import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { helper } from '../src/platform.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/stream-test.mjs', import.meta.url));
const ipc = new URL('../src/ipc.js', import.meta.url).href;

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

test('named workloads sharing a directory keep distinct ownership and listeners', { timeout: 150000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-instances-')));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(cwd, 'state') };
  async function run(...args) {
    const result = await exec(process.execPath, [bin, '--json', ...args], { cwd, env, windowsHide: true, timeout: 35000 })
      .catch(error => error);
    return JSON.parse(result.stdout);
  }
  t.after(async () => {
    const list = await run('list').catch(() => ({}));
    for (const row of (list.data ?? []).filter(row => row.cwd === cwd && row.instance && row.processCount)) {
      if (row.state === 'frozen') await run('resume', row.id);
      await run('sleep', row.id);
    }
    await run('daemon', 'stop');
    await delay(450);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  const server = await Promise.all([reserve('127.0.0.1'), reserve('127.0.0.1')]);
  const [apiPort, workerPort] = server.map(listener => listener.address().port);
  await Promise.all(server.map(listener => new Promise(resolve => listener.close(resolve))));
  const script = join(cwd, 'stream.mjs');
  await copyFile(fixture, script);
  await writeFile(join(cwd, 'package.json'), '{}');
  async function launch(instance, port) {
    const marker = join(cwd, `${instance}.stop`);
    const recipe = join(cwd, `${instance}.json`);
    await writeFile(recipe, JSON.stringify({ cwd, instance, argv: [process.execPath, script, String(port), marker],
      stop: [process.execPath, script, '--stop', marker], ready: { address: '127.0.0.1', port } }));
    return run('run', '--recipe', recipe);
  }
  const api = await launch('api', apiPort);
  const worker = await launch('worker', workerPort);
  assert.equal(api.ok, true, JSON.stringify(api));
  assert.equal(worker.ok, true, JSON.stringify(worker));
  const [apiId] = api.data.projects;
  const [workerId] = worker.data.projects;
  assert.notEqual(apiId, workerId);
  const inventory = (await run('list')).data;
  assert.equal(inventory.find(row => row.id === apiId).instance, 'api');
  const peer = inventory.find(row => row.id === workerId).processes.find(row => row.ports.some(port => port.port === workerPort));
  assert.ok(peer);
  const crossClaim = await run('adopt', apiId, '--cwd', cwd, '--member', `${peer.pid}@${peer.birth}@${peer.boot}`, '--confirm');
  assert.equal(crossClaim.data.outcomes[0].code, 'DENIED');
  assert.equal((await launch('api', apiPort)).data.outcomes[0].code, 'BUSY');
  assert.equal((await launch('conflict', workerPort)).data.outcomes[0].code, 'BUSY');
  assert.equal((await run('freeze', apiId)).ok, true);
  const client = stream(workerPort);
  t.after(() => client.close());
  await until(() => client.lines.some(line => line.includes(`PID=${peer.pid}`)), 'freezing the API must preserve the worker');
  client.close();
  assert.equal((await run('resume', apiId)).ok, true);
  assert.equal((await run('sleep', apiId)).ok, true);
  const ports = (await run('ports')).data;
  assert.equal(ports.some(row => row.port === apiPort && row.protocol === 'tcp'), false);
  assert.ok(ports.some(row => row.port === workerPort && row.pid === peer.pid && row.project === workerId));
});

test('local port inventory and reviewed lifecycle controls preserve unrelated sockets', { timeout: 125000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-menu-')));
  const env = { ...process.env, PROJECTFREEZE_HOME: join(cwd, 'state') };
  const options = { cwd, env, windowsHide: true, timeout: 30000 };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--json', ...args], options)).stdout).data;
  const recipe = join(cwd, 'stream.json');
  const reservation = await reserve('127.0.0.1');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const ipv6 = process.platform === 'win32' ? await reserve('::1') : undefined;
  const udp = createSocket('udp4');
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', resolve);
  });
  let menu, first, second, id, candidate;
  t.after(async () => {
    menu?.kill();
    candidate?.kill();
    first?.close();
    second?.close();
    ipv6?.close();
    udp.close();
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
  menu = spawn(process.execPath, [bin, 'menu', '--plain'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '';
  menu.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const command = async (value, next) => {
    const at = output.length;
    menu.stdin.write(`${value}\n`);
    return until(() => output.slice(at).match(next) && output.slice(at), `Waiting for ${next}\n${output}`);
  };
  await until(() => output.includes('Project number'), 'menu did not open automatically');
  const candidateDir = join(cwd, 'Unmanaged stream');
  await mkdir(candidateDir);
  await writeFile(join(candidateDir, 'package.json'), '{}');
  const script = join(candidateDir, 'stream.mjs');
  await copyFile(fixture, script);
  candidate = spawn(process.execPath, [script, '0'], { cwd: candidateDir, windowsHide: true, stdio: 'ignore' });
  await until(() => /Unmanaged stream \[discovered\]  TCP \d+/.test(output), 'idle menu did not discover an unmanaged listener');
  candidate.kill();
  await command('l', /Path to JSON/);
  await command(recipe, /Apply run/);
  const view = await command('y', /run complete[\s\S]*Project number/);
  const selected = view.match(new RegExp(`^(\\d+)\\. .*\\[running\\]  TCP ${port} `, 'm'));
  assert.ok(selected, view);
  const inventory = await command('p', new RegExp(`TCP 127\\.0\\.0\\.1:${port}  PID \\d+[\\s\\S]*Project number`));
  assert.match(inventory, new RegExp(`UDP 127\\.0\\.0\\.1:${udp.address().port}  PID`));
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
  await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { request, waitOperation } from ${JSON.stringify(ipc)};
    const id = process.argv[1];
    const project = await request('inspect', { id });
    const members = project.processes.map(({ pid, birth, boot }) => ({ pid, birth, boot }));
    for (const payload of [{ ids: [id], members }, { ids: [id], confirm: true, members: members.map(row => ({ ...row, birth: '1' })) }]) {
      const started = await request('kill', payload);
      const result = await waitOperation(started.id);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcomes[0].code, 'DENIED');
    }
    assert.ok((await request('inspect', { id })).processes.some(row => row.pid === ${pid2}));
    const started = await request('kill', { ids: [id], confirm: true, members });
    const result = await waitOperation(started.id);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal((await request('inspect', { id })).state, 'sleeping');
    const ports = await request('ports');
    assert.ok(!ports.some(row => row.protocol === 'tcp' && row.port === ${port} && row.address === '127.0.0.1'));
    assert.ok(ports.some(row => row.protocol === 'udp' && row.port === ${udp.address().port} && row.address === '127.0.0.1'));
  `, id], options);
  t.diagnostic(`TCP ${port}: PID ${pid1} → closed → PID ${pid2}`);
  await command('z', /Apply sleep\? \[y\/N\]/);
  await command('y', /sleep complete[\s\S]*\[sleeping\][\s\S]*q Quit/);
  menu.stdin.end('q\n');
});

test('other ProjectFreeze installations keep their ports without appearing as projects', {
  skip: !['win32', 'linux'].includes(process.platform), timeout: 65000
}, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-installation-')));
  const other = join(cwd, 'projectfreeze');
  const otherBin = join(other, 'bin', 'projectfreeze.js');
  const otherState = join(cwd, `other-${'x'.repeat(96)}`);
  const currentState = join(cwd, 'current');
  const run = async (entry, state, ...args) => JSON.parse((await exec(process.execPath, [entry, '--json', ...args], {
    cwd, env: { ...process.env, PROJECTFREEZE_HOME: state }, windowsHide: true, timeout: 25000
  })).stdout).data;
  let workload;
  t.after(async () => {
    workload?.kill();
    await Promise.all([run(otherBin, otherState, 'daemon', 'stop').catch(() => {}),
      run(bin, currentState, 'daemon', 'stop').catch(() => {})]);
    await delay(500);
    await rm(cwd, { recursive: true, force: true, maxRetries: 6 });
  });
  await mkdir(join(other, 'helpers'), { recursive: true });
  const copy = name => cp(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(other, name), { recursive: true });
  await Promise.all([copy('bin'), copy('src'), copy('package.json'), copyFile(helper, join(other, 'helpers', basename(helper))),
    copyFile(`${helper}.sha256`, join(other, 'helpers', `${basename(helper)}.sha256`))]);
  const { pid } = await run(otherBin, otherState, 'daemon', 'start');
  const script = join(other, 'stream.mjs');
  await copyFile(fixture, script);
  workload = spawn(process.execPath, [script, '0'], { cwd: other, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    workload.stdout.once('data', resolve);
    workload.once('error', reject);
    workload.once('exit', code => reject(new Error(`Stream fixture exited with code ${code}`)));
  });
  const observed = await run(bin, currentState, 'discover');
  assert.ok(observed.some(project => project.cwd === other && project.processes.some(process => process.pid === workload.pid)));
  assert.ok(observed.every(project => project.processes.every(process => process.pid !== pid)));
  const inventory = await run(bin, currentState, 'ports');
  assert.ok(inventory.some(row => row.pid === pid && row.address === '127.0.0.1' && row.scope === 'unassigned'));
});
