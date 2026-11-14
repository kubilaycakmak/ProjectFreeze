import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workload = fileURLToPath(new URL('../examples/workload.js', import.meta.url));

test('opted-in non-loopback HTTPS serves only the required route', {
  skip: process.env.PF_TEST_PUBLIC !== '1', timeout: 20000
}, async t => {
  const host = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(host, 'This test needs a non-loopback interface.');
  const dir = await mkdtemp(join(tmpdir(), 'pf-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const stop = join(dir, 'stop');
  const port = await new Promise(resolve => {
    const listener = createServer();
    listener.listen(0, host, () => { const port = listener.address().port; listener.close(() => resolve(port)); });
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      await writeFile(stop, 'stop');
      await new Promise(resolve => {
        child.once('exit', resolve);
        setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 1500).unref();
      });
    }
    await rm(dir, { recursive: true, force: true });
  });
  await exec(process.env.PF_TEST_OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=ProjectFreeze local test', '-addext', `subjectAltName=IP:${host}`, '-keyout', key, '-out', cert]);
  if (process.platform !== 'win32') await chmod(key, 0o600);
  child = spawn(process.execPath, [workload], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, PF_DEMO_HOST: host, PF_DEMO_PORT: String(port), PF_DEMO_PUBLIC: '1', PF_DEMO_TLS_KEY: key,
      PF_DEMO_TLS_CERT: cert, PF_DEMO_STOP_FILE: stop } });
  const ca = await readFile(cert);
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host, port, ca, path, method, signal: AbortSignal.timeout(1200) }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  let health;
  for (let i = 0; i < 25 && !health; i++) { health = await get('/health').catch(() => undefined); if (!health) await delay(150); }
  assert.equal(health, 200);
  assert.equal(await get('/daemon-stop', 'POST'), 404);
  assert.equal(await get('/health', 'POST'), 404);
});
