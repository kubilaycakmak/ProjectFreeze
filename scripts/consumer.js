import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const candidates = process.argv[2] ? [process.argv[2]] : readdirSync('dist').filter(file => file.endsWith('.tgz')).map(file => join('dist', file));
if (candidates.length !== 1) throw new Error('Pass the exact tarball path to scripts/consumer.js.');
const path = resolve(candidates[0]);
assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), readFileSync(`${path}.sha256`, 'utf8').split(' ')[0]);
const previousTarball = process.env.PF_PREVIOUS_TARBALL ? resolve(process.env.PF_PREVIOUS_TARBALL) : undefined;
const base = mkdtempSync(join(tmpdir(), 'pf consumer '));
const env = { ...process.env, PROJECTFREEZE_HOME: join(base, 'state with spaces') };
const windows = process.platform === 'win32';
const npm = windows ? process.env.ComSpec : 'npm';
const options = { cwd: base, env, stdio: 'pipe', timeout: 30000, windowsHide: true };
const npmArgs = args => windows ? ['/d', '/c', 'npm', ...args] : args;
const install = ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'];
const npmRun = args => execFileSync(npm, npmArgs(args), options);
const npmCli = windows ? join(resolve(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined;
const previous = previousTarball ? mkdtempSync(join(base, 'previous ')) : undefined;
let prefix = previous ?? base;
const run = args => {
  const cli = join(prefix, 'node_modules', '@kubilaycakmak', 'projectfreeze', 'bin', 'projectfreeze.js');
  return JSON.parse(execFileSync(process.execPath, [cli, '--json', ...args], options).toString());
};
const finish = join(base, 'finish');
let id;
let pid;
const probe = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  execFileSync(npm, npmArgs([...install, previousTarball ?? path]), { ...options, cwd: prefix });
  assert.equal(run(['list']).ok, true);
  const daemon = run(['daemon', 'status']).data;
  assert.equal(daemon.protocol, 1);
  let legacy = false;
  if (previous) {
    try { run(['ports']); }
    catch (error) {
      assert.equal(JSON.parse(error.stdout).error.code, 'USAGE');
      legacy = true;
    }
  }
  const address = '127.0.0.1';
  const port = await new Promise((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, address, () => {
      const { port } = reservation.address();
      reservation.close(error => error ? reject(error) : resolvePort(port));
    });
  });
  const workload = join(base, 'worker.mjs');
  const recipe = join(base, 'recipe.json');
  writeFileSync(workload, `import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
createServer(socket => socket.end()).listen(${port}, ${JSON.stringify(address)});
setInterval(() => { if (existsSync(${JSON.stringify(finish)})) process.exit(0); }, 100);
`);
  writeFileSync(recipe, JSON.stringify({ cwd: base, argv: [process.execPath, workload], ready: { address, port },
    stop: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(finish)}, '')`] }));
  ({ data: { projects: [id] } } = run(['run', '--recipe', recipe]));
  pid = run(['inspect', id]).data.processes[0].pid;
  assert.equal(probe(), true);
  if (!legacy) {
    assert.equal(run(['daemon', 'stop']).ok, true);
    await delay(500);
  }
  const interruptedDir = mkdtempSync(join(base, 'interrupted '));
  try {
    copyFileSync(path, join(interruptedDir, 'candidate.tgz'));
    const npmChild = spawn(windows ? process.execPath : npm, [...(windows ? [npmCli] : []), ...install, './candidate.tgz'],
      { ...options, cwd: interruptedDir, stdio: 'ignore' });
    const done = new Promise((resolve, reject) => { npmChild.once('exit', (code, signal) => resolve({ code, signal })); npmChild.once('error', reject); });
    assert.equal(npmChild.kill('SIGTERM'), true);
    assert.notEqual((await done).code, 0);
    execFileSync(npm, npmArgs([...install, './candidate.tgz']), { ...options, cwd: interruptedDir });
  } finally { rmSync(interruptedDir, { recursive: true, force: true, maxRetries: 6 }); }
  assert.equal(probe(), true);
  prefix = base;
  npmRun([...install, path]);
  if (legacy) {
    const ports = run(['ports']).data;
    assert.ok(ports.some(row => row.protocol === 'tcp' && row.address === address && row.port === port && row.pid === pid));
    assert.notEqual(run(['daemon', 'status']).data.pid, daemon.pid);
    console.log('Verified port inventory replaces a legacy daemon and preserves the live listener.');
  }
  assert.equal(run(['inspect', id]).data.processes[0].pid, pid);
  assert.equal(run(['daemon', 'stop']).ok, true);
  await delay(500);
  npmRun(['uninstall', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '@kubilaycakmak/projectfreeze']);
  assert.ok(readFileSync(join(env.PROJECTFREEZE_HOME, 'state.sqlite')).length);
  assert.equal(probe(), true);
  npmRun([...install, path]);
  assert.equal(run(['inspect', id]).data.processes[0].pid, pid);
  assert.equal(run(['sleep', id]).ok, true);
  console.log('Verified interrupted install, live upgrade, uninstall, reinstall, and workload identity preservation.');
} finally {
  writeFileSync(finish, '');
  try { run(['daemon', 'stop']); } catch { /* A stopped or uninstalled daemon needs no cleanup. */ }
  await delay(500);
  rmSync(base, { recursive: true, force: true, maxRetries: 6 });
}
