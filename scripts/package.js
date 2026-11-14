import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const all = process.argv.includes('--all');
const helperName = (os, arch) => `projectfreeze-${os}-${arch}${os === 'win32' ? '.exe' : ''}`;
const supported = ['linux', 'darwin', 'win32'].flatMap(os => ['x64', 'arm64'].map(arch => helperName(os, arch)));
const host = helperName(process.platform, process.arch);
if (!all && !supported.includes(host)) throw new Error(`Unsupported build platform: ${process.platform}-${process.arch}`);
const required = all ? supported : [host];
const entries = new Set(readdirSync('helpers'));
const allowed = new Set(['.gitkeep', ...supported.flatMap(name => [name, `${name}.sha256`])]);
const unexpected = [...entries].filter(name => !allowed.has(name));
if (unexpected.length) throw new Error(`Unexpected entries in helpers/: ${unexpected.join(', ')}`);
const helpers = {};
for (const name of supported) {
  if (!required.includes(name) && !entries.has(name) && !entries.has(`${name}.sha256`)) continue;
  if (!entries.has(name) || !entries.has(`${name}.sha256`)) throw new Error(`Missing helper or checksum: ${name}`);
  const path = join('helpers', name);
  if (!lstatSync(path).isFile() || !lstatSync(`${path}.sha256`).isFile()) throw new Error(`Helper and checksum must be regular files: ${name}`);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (readFileSync(`${path}.sha256`, 'utf8').split(' ')[0] !== hash) throw new Error(`Integrity check failed for ${name}`);
  helpers[name] = hash;
}
mkdirSync('dist', { recursive: true });
const npm = process.platform === 'win32' ? process.env.ComSpec : 'npm';
const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', 'dist'];
const packed = spawnSync(npm, process.platform === 'win32' ? ['/d', '/c', 'npm', ...args] : args, { encoding: 'utf8' });
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
const [result] = JSON.parse(packed.stdout);
const digest = createHash('sha256').update(readFileSync(join('dist', result.filename))).digest('hex');
const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const revision = status.status === 0 && !status.stdout.trim()
  ? spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }) : null;
const commit = revision?.status === 0 ? revision.stdout.trim() : undefined;
writeFileSync(join('dist', `${result.filename}.sha256`), `${digest}  ${result.filename}\n`);
writeFileSync(join('dist', 'build-metadata.json'), `${JSON.stringify({ schemaVersion: 1, candidate: result.filename, sha256: digest, helpers, commit }, null, 2)}\n`);
console.log(result.filename);
