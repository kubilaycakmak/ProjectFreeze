import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = mkdtempSync(join(tmpdir(), 'pf consumer '));
const path = process.argv[2] ? resolve(process.argv[2]) : resolve('dist', readdirSync('dist').find(file => file.endsWith('.tgz')));
assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), readFileSync(`${path}.sha256`, 'utf8').split(' ')[0]);
const env = { ...process.env, PROJECTFREEZE_HOME: join(base, 'state with spaces') };
const windows = process.platform === 'win32';
const npm = windows ? process.env.ComSpec : 'npm';
const options = { cwd: base, env, stdio: 'pipe', timeout: 30000, windowsHide: true };
const npmArgs = args => windows ? ['/d', '/c', 'npm', ...args] : args;
const install = ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'];
const npmRun = args => execFileSync(npm, npmArgs(args), options);
const npmCli = windows ? join(resolve(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined;
const previous = process.env.PF_PREVIOUS_TARBALL ? mkdtempSync(join(base, 'previous ')) : undefined;
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
  execFileSync(npm, npmArgs([...install, process.env.PF_PREVIOUS_TARBALL || path]), { ...options, cwd: prefix });
  assert.equal(run(['list']).ok, true);
  assert.equal(run(['daemon', 'status']).data.protocol, 1);
  const workload = join(base, 'worker.mjs');
  const recipe = join(base, 'recipe.json');
  writeFileSync(workload, `import { existsSync } from 'node:fs'; setInterval(() => { if (existsSync(${JSON.stringify(finish)})) process.exit(0); }, 100);`);
  writeFileSync(recipe, JSON.stringify({ cwd: base, argv: [process.execPath, workload],
    stop: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(finish)}, '')`] }));
  ({ data: { projects: [id] } } = run(['run', '--recipe', recipe]));
  pid = run(['inspect', id]).data.processes[0].pid;
  assert.equal(probe(), true);
  assert.equal(run(['daemon', 'stop']).ok, true);
  await delay(500);
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
