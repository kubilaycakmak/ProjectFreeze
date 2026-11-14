import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/stream-test.mjs', import.meta.url));

async function reserve(host) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server;
}

function stream(port) {
  const lines = [];
  const client = request({ host: '127.0.0.1', port, path: '/stream' }, response => {
    assert.equal(response.statusCode, 200);
    response.setEncoding('utf8');
    response.on('data', chunk => { lines.push(chunk); });
    response.once('end', () => { result.ended = true; });
  });
  const result = { lines, ended: false, close: () => client.destroy() };
  client.on('error', error => { result.error = error; });
  client.end();
  return result;
}

async function until(check, reason, timeout = 17000) {
  const end = Date.now() + timeout;
  do { const value = check(); if (value) return value; await delay(120); } while (Date.now() < end);
  assert.fail(reason);
}

test('numbered menu finds listeners and sleeps and wakes a streaming workload', { timeout: 125000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-menu-')));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(cwd, 'state') };
  const options = { cwd, env, windowsHide: true, timeout: 30000 };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--json', ...args], options)).stdout).data;
  const recipe = join(cwd, 'stream.json');
  const reservation = await reserve('127.0.0.1');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const ipv6 = process.platform === 'win32' ? await reserve('::1') : undefined;
  let menu, first, second, id;
  t.after(async () => {
    menu?.kill();
    first?.close();
    second?.close();
    ipv6?.close();
    id ??= (await run('list').catch(() => [])).find(item => item.cwd === cwd && item.state !== 'discovered')?.id;
    if (id) {
      await run('resume', id).catch(() => {});
      await run('sleep', id).catch(() => {});
    }
    await run('daemon', 'stop').catch(() => {});
    await delay(450);
    await rm(cwd, { recursive: true, force: true, maxRetries: 6 });
  });
  await exec(process.execPath, [fixture, '--recipe', recipe, String(port)], options);
  menu = spawn(process.execPath, [bin, 'menu'], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  menu.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const command = async (value, next) => {
    const at = output.length;
    menu.stdin.write(`${value}\n`);
    return until(() => output.slice(at).match(next) && output.slice(at), `Waiting for ${next}\n${output}`);
  };
  await until(() => output.includes('Project number'), 'menu did not open automatically');
  await command('l', /Path to JSON/);
  await command(recipe, /Apply run/);
  const view = await command('y', /run complete[\s\S]*Project number/);
  const selected = view.match(new RegExp(`^(\\d+)\\. .*\\[running\\]  TCP ${port} `, 'm'));
  assert.ok(selected, view);
  await command('p', new RegExp(`127\\.0\\.0\\.1:${port}  PID \\d+[\\s\\S]*Project number`));
  if (ipv6) {
    const listeners = await run('listeners');
    assert.ok(listeners.some(row => row.pid === process.pid && row.address === '::1' && row.port === ipv6.address().port));
  }
  const detail = await command(selected[1], /z Sleep.*w Wake.*q Quit/);
  id = detail.match(/p-[a-f0-9]{16}/)[0];
  first = stream(port);
  const pid1 = Number((await until(() => first.lines.join('').match(/PID=(\d+)/), 'no initial stream'))[1]);
  await command('z', /Apply sleep\? \[y\/N\]/);
  await command('y', /sleep complete[\s\S]*\[sleeping\]  TCP none[\s\S]*q Quit/);
  await until(() => first.ended, 'graceful shutdown did not close the original HTTP stream');
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  }), { code: 'ECONNREFUSED' });
  assert.ok(!(await run('listeners')).some(row => row.port === port));
  await command('w', /Apply wake\? \[y\/N\]/);
  await command('y', new RegExp(`wake complete[\\s\\S]*\\[running\\]  TCP ${port}[\\s\\S]*q Quit`));
  second = stream(port);
  const pid2 = Number((await until(() => second.lines.join('').match(/PID=(\d+)/), 'no resumed stream'))[1]);
  assert.notEqual(pid1, pid2);
  assert.ok((await run('listeners')).some(row => row.port === port && row.pid === pid2 && row.project === id));
  t.diagnostic(`TCP ${port}: PID ${pid1} → closed → PID ${pid2}`);
  await command('z', /Apply sleep\? \[y\/N\]/);
  await command('y', /sleep complete[\s\S]*\[sleeping\][\s\S]*q Quit/);
  menu.stdin.end('q\n');
});
