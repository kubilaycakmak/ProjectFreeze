import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { checkpoint, composeTargets, containerAction, restore } from '../src/integrations.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));

test('native CRIU round trip retains a real process checkpoint', {
  skip: process.platform !== 'linux' || process.env.PF_TEST_CRIU !== '1', timeout: 150000
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pf-criu-'));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(dir, 'state') };
  const run = async (...args) => {
    const result = await exec(process.execPath, [bin, '--json', ...args], { env, timeout: 120000 }).catch(error => error);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  let project;
  try {
    ({ projects: [project] } = await run('run', '--cwd', dir, '--', '/usr/bin/sleep', '120'));
    const capture = await run('checkpoint', project);
    const id = capture.outcomes.find(o => o.status === 'captured').target;
    await run('sleep', project);
    await run('restore', project, '--checkpoint', id);
    assert.equal((await run('inspect', project)).processCount, 1);
    await run('sleep', project);
  } finally {
    if (project) await run('sleep', project).catch(() => {});
    await run('daemon', 'stop').catch(() => {});
    await delay(250);
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Compose service identity, pause, sharing, and shutdown', {
  skip: process.platform !== 'linux' || process.env.PF_TEST_DOCKER !== '1', timeout: 60000
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pf-compose-'));
  const projectName = `projectfreeze-test-${process.pid}`;
  const compose = (...args) => exec('docker', ['--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', projectName, ...args], { cwd, timeout: 30000 });
  const service = { project: projectName, service: 'worker', shared: false };
  const project = { id: 'fixture', cwd, recipe: { containers: [service] } };
  let checkpointDir;
  try {
    const network = process.env.PF_TEST_DOCKER_CHECKPOINT === '1' ? 'host' : 'none';
    await writeFile(join(cwd, 'compose.yaml'), `services:\n  worker:\n    image: busybox:1.37\n    command: ["sh", "-c", "trap 'exit 0' TERM; while true; do echo alive; sleep 0.2; done"]\n    restart: "no"\n    network_mode: ${network}\n`);
    await compose('up', '-d', '--pull', 'never');
    const [running] = await composeTargets(project, [project]);
    assert.equal(running.running, true);
    assert.match(running.id, /^[a-f0-9]{64}$/);
    await containerAction('pause', running.id);
    assert.equal((await composeTargets(project, [project]))[0].paused, true);
    const [shared] = await composeTargets(project, [project, { id: 'other', recipe: { containers: [{ ...service }] } }]);
    assert.equal(shared.shared, true);
    assert.equal(shared.id, undefined);
    await containerAction('unpause', running.id);
    await containerAction('stop', running.id, 1000);
    assert.equal((await composeTargets(project, [project]))[0].running, false);
    await containerAction('start', running.id);
    assert.equal((await composeTargets(project, [project]))[0].running, true);
    if (process.env.PF_TEST_DOCKER_CHECKPOINT === '1') {
      const id = await checkpoint(cwd, project, undefined, 'docker', await composeTargets(project, [project]), () => {});
      await containerAction('stop', running.id, 1000);
      const root = (await exec('docker', ['info', '--format', '{{.DockerRootDir}}'])).stdout.trim();
      checkpointDir = join(root, 'containers', running.id, 'checkpoints', id);
      try { await restore(cwd, project, id, await composeTargets(project, [project]), () => {}); }
      catch (error) {
        if (process.env.GITHUB_ACTIONS === 'true') {
          const direct = await exec('docker', ['inspect', '--format', '{{json .State}}', running.id]).catch(failure => failure);
          const journal = await exec('journalctl', ['-u', 'docker', '--no-pager', '-n', '25']).catch(() => ({ stdout: '' }));
          const logs = await exec('/usr/bin/find', [checkpointDir, '-name', '*.log', '-print', '-exec', 'tail', '-n', '15', '{}', ';']).catch(() => ({ stdout: '' }));
          console.error(direct.stdout, direct.stderr, journal.stdout, logs.stdout);
        }
        throw error;
      }
      assert.equal((await composeTargets(project, [project]))[0].running, true);
    }
  } finally {
    await compose('unpause').catch(() => {});
    await compose('down').catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});
