import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const all = process.argv.includes('--all');
const platforms = all ? ['linux', 'darwin', 'win32'].flatMap(os => ['x64', 'arm64'].map(arch => [os, arch])) : [[process.platform, process.arch]];
for (const [os, arch] of platforms) {
  const name = `projectfreeze-${os}-${arch}${os === 'win32' ? '.exe' : ''}`;
  const path = join('helpers', name);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (readFileSync(`${path}.sha256`, 'utf8').split(' ')[0] !== hash) throw new Error(`Integrity check failed for ${name}`);
}
mkdirSync('dist', { recursive: true });
const npm = process.platform === 'win32' ? process.env.ComSpec : 'npm';
const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', 'dist'];
const packed = spawnSync(npm, process.platform === 'win32' ? ['/d', '/c', 'npm', ...args] : args, { encoding: 'utf8' });
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
const [result] = JSON.parse(packed.stdout);
writeFileSync(join('dist', `${result.filename}.sha256`), `${createHash('sha256').update(readFileSync(join('dist', result.filename))).digest('hex')}  ${result.filename}\n`);
console.log(result.filename);
