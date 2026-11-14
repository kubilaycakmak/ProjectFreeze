import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'pf-repro-'));
const artifact = join('helpers', `projectfreeze-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
try {
  cpSync('native', join(work, 'native'), { recursive: true });
  execFileSync(process.execPath, [resolve('scripts/build-native.js')], { cwd: work, stdio: 'inherit' });
  assert.equal(readFileSync(artifact).equals(readFileSync(join(work, artifact))), true, 'Independent helper builds differ');
  console.log(`Reproduced ${artifact} byte for byte in an independent build directory.`);
} finally { rmSync(work, { recursive: true, force: true }); }
