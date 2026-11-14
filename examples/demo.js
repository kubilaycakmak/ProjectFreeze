import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdtemp, realpath, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));
const checkpoint = process.argv[2] === '--checkpoint';
if (checkpoint && process.platform !== 'linux') throw new Error('The checkpoint demo requires Linux with a working CRIU installation.');
const base = await realpath(await mkdtemp(join(tmpdir(), 'pf-demo-')));
const worker = join(base, 'workload.mjs');
const marker = join(base, 'stop');
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const env = { ...process.env, PROJECTFREEZE_HOME: join(base, 'state'), PF_DEMO_PORT: String(port), PF_DEMO_STOP_FILE: marker };
const recipe = join(base, 'recipe.json');
const start = [process.execPath, worker];
const stop = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "stop")', marker];
const run = async (...args) => {
  const result = await exec(process.execPath, [cli, '--json', ...args], { env, windowsHide: true }).catch(error => error);
  const reply = JSON.parse(result.stdout);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error ?? reply.data));
  return reply.data;
};
let id, external;
try {
  if (checkpoint) {
    ({ projects: [id] } = await run('run', '--cwd', base, '--', '/usr/bin/sleep', '120'));
    const capture = await run('checkpoint', id);
    const image = capture.outcomes.find(row => row.status === 'captured').target;
    console.log(`Checkpoint ${image}`);
    await run('sleep', id);
    console.log(`Restore ${(await run('restore', id, '--checkpoint', image)).status}`);
    console.log(`Restored ${(await run('inspect', id)).processCount} process(es)`);
  } else {
    await copyFile(new URL('./workload.js', import.meta.url), worker);
    await writeFile(join(base, 'package.json'), '{}');
    await writeFile(recipe, JSON.stringify({ cwd: base, instance: 'demo', argv: start, stop, env: ['PF_DEMO_PORT', 'PF_DEMO_STOP_FILE'],
      ready: { address: '127.0.0.1', port } }));
    external = spawn(start[0], start.slice(1), { cwd: base, env, windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 10000;
    while (!(await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }).then(reply => reply.ok, () => false))) {
      if (Date.now() >= deadline || external.exitCode !== null) throw new Error('The demo listener did not start.');
      await delay(150);
    }
    const discovered = (await run('discover')).find(project => project.cwd === base);
    const member = discovered?.processes.find(row => row.pid === external.pid);
    if (!member) throw new Error('The independently launched demo process was not discovered.');
    console.log(`Discovered PID ${member.pid} on 127.0.0.1:${port}`);
    ({ projects: [id] } = await run('adopt', '--cwd', base, '--member', `${member.pid}@${member.birth}@${member.boot}`, '--confirm', '--recipe', recipe));
    console.log(`Adopted ${id} ${JSON.stringify((await run('inspect', id)).ports)}`);
    for (const command of ['freeze', 'resume', 'sleep', 'wake', 'sleep']) {
      if (command === 'wake') await unlink(marker);
      console.log(`${command} ${(await run(command, id)).status}`);
    }
  }
} finally {
  if (id) {
    await run('resume', id).catch(() => {});
    await run('sleep', id).catch(() => {});
  }
  if (external?.exitCode === null) external.kill();
  await run('daemon', 'stop').catch(() => {});
  await delay(500);
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
}
