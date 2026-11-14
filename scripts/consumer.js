import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = mkdtempSync(join(tmpdir(), 'pf consumer '));
const archive = readdirSync('dist').find(file => file.endsWith('.tgz'));
const path = resolve('dist', archive);
assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), readFileSync(`${path}.sha256`, 'utf8').split(' ')[0]);
const env = { ...process.env, PROJECTFREEZE_HOME: join(base, 'state with spaces') };
const windows = process.platform === 'win32';
const npm = windows ? process.env.ComSpec : 'npm';
const options = { cwd: base, env, stdio: 'pipe', timeout: 30000, windowsHide: true };
const npmRun = args => execFileSync(npm, windows ? ['/d', '/c', 'npm', ...args] : args, options);
const cli = join(base, 'node_modules', '@kubilaycakmak', 'projectfreeze', 'bin', 'projectfreeze.js');
const run = args => JSON.parse(execFileSync(process.execPath, [cli, '--json', ...args], options).toString());
try {
  npmRun(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', windows ? `"${path}"` : path]);
  assert.equal(run(['list']).ok, true);
  assert.equal(run(['daemon', 'status']).data.protocol, 1);
  assert.equal(run(['daemon', 'stop']).ok, true);
  await delay(500);
  npmRun(['uninstall', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '@kubilaycakmak/projectfreeze']);
  assert.ok(readFileSync(join(env.PROJECTFREEZE_HOME, 'state.sqlite')).length);
  console.log('Verified the installed tarball, local daemon, and retained state after uninstall.');
} finally {
  try { run(['daemon', 'stop']); } catch { /* A stopped or uninstalled daemon needs no cleanup. */ }
  await delay(500);
  rmSync(base, { recursive: true, force: true, maxRetries: 6 });
}
