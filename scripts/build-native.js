import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

mkdirSync('helpers', { recursive: true });
const windows = process.platform === 'win32';
const name = `projectfreeze-${process.platform}-${process.arch}${windows ? '.exe' : ''}`;
const output = join('helpers', name);
const framework = windows ? join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319') : '';
const sdk = process.env.PF_DOTNET_SDK;
const roslyn = sdk && join(sdk, 'Roslyn', 'bincore', 'csc.dll');
if (windows && sdk && !existsSync(roslyn)) throw new Error('PF_DOTNET_SDK must point to an installed .NET SDK directory.');
const compiler = windows ? (sdk ? 'dotnet' : join(framework, 'csc.exe')) : 'cc';
const args = windows ? [
  ...(sdk ? [roslyn, '/nostdlib+', '/deterministic+', '/pathmap:' + process.cwd() + '=/_/', ...['mscorlib', 'System', 'System.Core'].map(name => `/reference:${join(framework, `${name}.dll`)}`)] : []),
  '/nologo', '/optimize+', '/platform:anycpu', `/out:${output}`, 'native\\windows.cs'
] : ['-std=c11', '-Wall', '-Wextra', '-O2', '-ffile-prefix-map=' + process.cwd() + '=/_/',
  ...(process.platform === 'darwin' ? ['-mmacosx-version-min=13.5'] : []), '-o', output, `native/${process.platform}.c`];
const build = spawnSync(compiler, args, { stdio: 'inherit' });
if (build.status !== 0) throw new Error(`Native build failed: ${build.error?.code ?? build.status}`);
writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${name}\n`);
