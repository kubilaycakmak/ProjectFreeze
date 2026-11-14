import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const all = process.argv.includes('--all');
const platforms = all ? ['linux', 'darwin', 'win32'].flatMap(os => ['x64', 'arm64'].map(arch => [os, arch])) : [[process.platform, process.arch]];
const helpers = {};
for (const [os, arch] of platforms) {
  const name = `projectfreeze-${os}-${arch}${os === 'win32' ? '.exe' : ''}`;
  const path = join('helpers', name);
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
writeFileSync(join('dist', `${result.filename}.sha256`), `${digest}  ${result.filename}\n`);
writeFileSync(join('dist', 'build-metadata.json'), `${JSON.stringify({ schemaVersion: 1, candidate: result.filename, sha256: digest, helpers,
  repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID }, null, 2)}\n`);
console.log(result.filename);
