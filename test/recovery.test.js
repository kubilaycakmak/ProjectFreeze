import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { projectId } from '../src/discovery.js';
import { Engine } from '../src/engine.js';
import { bootId } from '../src/platform.js';
import { Store } from '../src/store.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));

async function until(fn, message = 'Expected state was not observed.', timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await fn();
    if (result) return result;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(message);
}

test('an interrupted restore blocks relaunch until the effect is cleared', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-restore-recovery-')));
  const store = new Store(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  const id = projectId(cwd);
  const operation = randomUUID();
  const effect = { operation, kind: 'restore', backend: 'criu', boot: await bootId() };
  store.commit({ id, cwd, members: [], excluded: [], state: 'restoring', uncertainEffect: effect },
    { id: operation, action: 'restore', projects: [id], status: 'running', started: new Date().toISOString(), pending: 'restore checkpoint' });
  const engine = new Engine(store, cwd);
  assert.equal(store.operation(operation).status, 'interrupted');
  async function run(action, input) {
    const { id: operationId } = await engine.dispatch(action, input);
    await until(() => !engine.current);
    return store.operation(operationId);
  }
  const unresolved = await run('reconcile', { ids: [id] });
  assert.equal(unresolved.outcomes[0].code, 'PARTIAL');
  assert.equal(store.project(id).state, 'partial');
  assert.deepEqual(store.project(id).uncertainEffect, effect);
  const blocked = await run('run', { recipe: { cwd, argv: [process.execPath, '--version'] } });
  assert.equal(blocked.outcomes[0].code, 'BUSY');
  store.save({ ...store.project(id), uncertainEffect: { ...effect, boot: randomUUID() } });
  assert.equal((await run('reconcile', { ids: [id] })).status, 'complete');
  assert.equal(store.project(id).state, 'exited');
  assert.equal(store.project(id).uncertainEffect, undefined);
});

test('restart evidence and interrupted shutdown survive a daemon crash', { timeout: 100000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-recovery-')));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(cwd, 'state') };
  const file = join(cwd, 'worker.mjs');
  const recipeFile = join(cwd, 'recipe.json');
  const read = name => readFile(join(cwd, name), 'utf8').catch(() => '');
  const call = async (...args) => {
    const result = await exec(process.execPath, [bin, '--json', ...args], { env, windowsHide: true, timeout: 26000 }).catch(error => error);
    return JSON.parse(result.stdout);
  };
  let id;
  t.after(async () => {
    await writeFile(join(cwd, 'finish'), '');
    if (id) { await call('reconcile', id).catch(() => {}); await call('sleep', id, '--force').catch(() => {}); }
    await call('daemon', 'stop').catch(() => {});
    await delay(600);
    await rm(cwd, { recursive: true, force: true, maxRetries: 6 });
  });
  await writeFile(file, `import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'stop') { writeFileSync('shutdown-entered', '1'); }
else writeFileSync('worker.pid', String(process.pid));
setInterval(() => {
  if (existsSync('finish')) process.exit(0);
  if (process.argv[2] !== 'stop' && existsSync('fail-' + process.pid)) process.exit(11);
}, 70);
`);
  await writeFile(join(cwd, 'package.json'), '{}');
  await writeFile(recipeFile, JSON.stringify({ cwd, argv: [process.execPath, file], stop: [process.execPath, file, 'stop'], restart: 'on-failure' }));
  const launched = await call('run', '--recipe', recipeFile);
  assert.equal(launched.ok, true, JSON.stringify(launched));
  id = launched.data.projects[0];
  const first = Number(await until(() => read('worker.pid')));
  const crash = async () => {
    const { data } = await call('daemon', 'status');
    process.kill(data.pid, 'SIGKILL');
    await until(async () => !(await call('daemon', 'status')).ok);
  };
  await crash();
  await writeFile(join(cwd, `fail-${first}`), '');
  await until(async () => {
    const receipt = (await readdir(env.PROJECTFREEZE_HOME)).find(name => /^exit-[a-f0-9-]{36}$/.test(name));
    return receipt && await readFile(join(env.PROJECTFREEZE_HOME, receipt), 'utf8') === '11\n';
  }, 'The launch supervisor did not record the failure while the daemon was down.', 30000);
  assert.equal((await call('daemon', 'start')).ok, true);
  const second = await until(async () => {
    const pid = Number(await read('worker.pid'));
    return pid !== first && pid;
  }, 'The daemon did not start a replacement worker.', 30000);
  await until(async () => (await call('inspect', id)).data?.state === 'running');
  assert.ok((await call('history')).data.some(op => op.action === 'wake' && op.projects.includes(id)));
  const shutdown = await call('sleep', id, '--detach');
  assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
  await until(() => read('shutdown-entered'));
  await crash();
  await writeFile(join(cwd, 'finish'), '');
  const recovered = await call('operation', shutdown.data.id);
  assert.equal(recovered.data.status, 'interrupted');
  assert.match(recovered.data.pending, /shutdown command/);
  await until(async () => (await call('inspect', id)).data?.processCount === 0);
  assert.equal((await call('reconcile', id)).ok, true);
  assert.equal(Number(await read('worker.pid')), second);
  assert.equal((await call('inspect', id)).data.state, 'exited');
});

test('detached candidate remains observable after its parent exits', { timeout: 45000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-detached-')));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(cwd, 'state') };
  const file = join(cwd, 'worker.mjs');
  const parent = join(cwd, 'parent.mjs');
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--json', ...args], { env, windowsHide: true })).stdout);
  t.after(async () => {
    await writeFile(join(cwd, 'finish'), '');
    await call('daemon', 'stop').catch(() => {});
    await delay(500);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(cwd, 'package.json'), '{}');
  await writeFile(file, `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync('detached.pid', String(process.pid));
setInterval(() => { if (existsSync('finish')) process.exit(0); }, 100);`);
  await writeFile(parent, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(file)}], { detached: true, stdio: 'ignore', windowsHide: true }).unref();`);
  const launch = spawn(process.execPath, [parent], { cwd, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { launch.once('error', reject); launch.once('exit', code => code ? reject(new Error('Parent exit failed')) : resolve()); });
  const pid = Number(await until(() => readFile(join(cwd, 'detached.pid'), 'utf8').catch(() => '')));
  const project = (await call('discover')).data.find(p => p.cwd === cwd);
  const candidate = project.processes.find(p => p.pid === pid);
  assert.ok(candidate.evidence.includes('parent-outside-scan'));
  assert.equal(project.confidence, 'observed');
  assert.ok(project.unresolved.some(item => item.pid === pid));
});
