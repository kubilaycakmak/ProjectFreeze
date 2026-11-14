import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

mkdirSync('helpers', { recursive: true });
const windows = process.platform === 'win32';
const name = `projectfreeze-${process.platform}-${process.arch}${windows ? '.exe' : ''}`;
const output = join('helpers', name);
const compiler = windows ? join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : 'cc';
const args = windows ? ['/nologo', '/optimize+', '/platform:anycpu', `/out:${output}`, 'native\\windows.cs']
  : ['-std=c11', '-Wall', '-Wextra', '-O2', ...(process.platform === 'linux' ? ['-static'] : ['-mmacosx-version-min=13.5']), '-o', output, `native/${process.platform}.c`];
const build = spawnSync(compiler, args, { stdio: 'inherit' });
if (build.status !== 0) throw new Error(`Native build failed: ${build.error?.code ?? build.status}`);
writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${name}\n`);
