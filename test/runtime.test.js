import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));
const fixture = await readFile(new URL('./fixtures/server.mjs', import.meta.url), 'utf8');
const windows = process.platform === 'win32';
const code = () => new Promise(resolve => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
async function eventually(callback, message, timeout = 14000) {
  const end = Date.now() + timeout;
  do { const value = await callback(); if (value) return value; await delay(200); } while (Date.now() < end);
  assert.fail(message);
}

test('real ownership, lifecycle, IPC authentication and MCP', { timeout: 130000 }, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pf-')));
  const project = join(base, 'Project ü with spaces');
  const foreign = join(base, 'Unrelated process');
  const state = join(base, 'state');
  const env = { ...process.env, PROJECTFREEZE_HOME: state };
  const run = async (args, allowError = false) => {
    const result = await exec(process.execPath, [bin, '--json', ...args], { env, timeout: 35000, windowsHide: true })
      .catch(error => { if (!allowError) assert.fail(error.stdout || error.message); return error; });
    return JSON.parse(result.stdout);
  };
  const stopDaemon = () => run(['daemon', 'stop'], true).catch(() => {});
  const launchFixture = (dir, port) => {
    const child = spawn(process.execPath, [join(dir, 'server.mjs'), 'serve', String(port)], { cwd: dir, stdio: 'ignore', windowsHide: true });
    child.unref();
    return child;
  };
  t.after(async () => {
    const list = await run(['list'], true).catch(() => ({}));
    for (const row of list.data ?? []) {
      if (row.cwd === project && ['running', 'partial', 'frozen', 'adopted'].includes(row.state)) {
        await run(['resume', row.id], true).catch(() => {});
        await writeFile(join(project, 'stop.request'), '').catch(() => {});
        if (row.state !== 'adopted') await run(['sleep', row.id, '--force'], true).catch(() => {});
      }
    }
    await Promise.all([writeFile(join(project, 'stop.request'), '').catch(() => {}), writeFile(join(foreign, 'stop.request'), '').catch(() => {})]);
    await delay(450);
    await stopDaemon();
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });
  assert.deepEqual(await run(['--version']), { schemaVersion: 1, ok: true, data: { version: manifest.version } });
  for (const dir of [project, foreign]) {
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), '{}');
    await writeFile(join(dir, 'server.mjs'), fixture);
  }
  const port = await code();
  const foreignPort = await code();
  const outside = launchFixture(foreign, foreignPort);
  const external = launchFixture(project, port);
  const url = `http://127.0.0.1:${port}`;
  const healthy = async address => fetch(address, { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false);
  await eventually(() => healthy(url), 'fixture should listen');
  const discovery = await eventually(async () => (await run(['discover'])).data.find(row => row.cwd === project && row.processes.some(p => p.pid === external.pid)), 'discover unmanaged project');
  const root = discovery.processes.find(p => p.pid === external.pid);
  const identity = p => `${p.pid}@${p.birth}@${p.boot}`;
  const stale = await run(['adopt', '--cwd', project, '--member', `${root.pid}@1@${root.boot}`, '--confirm'], true);
  assert.equal(stale.data.status, 'failed');
  assert.equal(stale.data.outcomes[0].code, 'DENIED');
  const previousBoot = await run(['adopt', '--cwd', project, '--member', `${root.pid}@${root.birth}@${randomUUID()}`, '--confirm'], true);
  assert.equal(previousBoot.data.outcomes[0].code, 'DENIED');
  assert.equal(await healthy(url), true);
  const recipe = join(base, 'recipe.json');
  await writeFile(recipe, JSON.stringify({ cwd: project, argv: [process.execPath, join(project, 'server.mjs'), 'serve', String(port)],
    stop: [process.execPath, join(project, 'server.mjs'), 'stop'], ready: { address: '127.0.0.1', port }, timeout: 12000 }));
  const worker = +(await readFile(join(project, 'worker.pid'), 'utf8'));
  const candidate = discovery.processes.find(p => p.pid === worker);
  assert.ok(candidate);
  const adopted = await run(['adopt', '--cwd', project, '--member', identity(root), '--member', identity(candidate), '--confirm', '--recipe', recipe]);
  assert.equal(adopted.data.status, 'complete');
  const id = adopted.data.projects[0];
  const inspect = async () => (await run(['inspect', id])).data;
  assert.equal((await inspect()).processCount, 2);
  assert.ok((await inspect()).ports.some(p => p.port === port));
  assert.equal((await run(['freeze', id])).data.status, 'complete');
  assert.equal((await inspect()).state, 'frozen');
  assert.ok((await inspect()).ports.some(p => p.port === port));
  assert.equal(await healthy(url), false);
  assert.equal(await healthy(`http://127.0.0.1:${foreignPort}`), true);
  assert.equal((await run(['daemon', 'stop'])).data.stopped, true);
  await delay(350);
  assert.equal((await run(['resume', id])).data.status, 'complete');
  assert.equal(await healthy(url), true);
  assert.equal((await run(['sleep', id])).data.status, 'complete');
  assert.equal((await inspect()).state, 'sleeping');
  assert.equal(await healthy(url), false);
  await unlink(join(project, 'stop.request'));
  assert.equal((await run(['wake', id])).data.status, 'complete');
  let lastInspection;
  await eventually(async () => {
    lastInspection = await inspect();
    const pid = Number(await readFile(join(project, 'worker.pid'), 'utf8'));
    return pid !== worker && lastInspection.processes.some(process => process.pid === pid);
  }, 'discover managed job/group member').catch(error => {
    error.message += `; observed ${JSON.stringify(lastInspection?.processes)}`;
    throw error;
  });
  assert.equal((await run(['freeze', id])).data.status, 'complete');
  assert.equal((await run(['resume', id])).data.status, 'complete');
  assert.equal((await run(['sleep', id])).data.status, 'complete');
  assert.equal(await healthy(`http://127.0.0.1:${foreignPort}`), true);
  assert.equal(outside.exitCode, null);

  const endpoint = JSON.parse(await readFile(join(state, 'endpoint.json'), 'utf8'));
  const socket = createConnection(endpoint.port ? { host: '127.0.0.1', port: endpoint.port } : { path: join(state, endpoint.socket) });
  const rejected = new Promise(resolve => { socket.once('close', resolve); socket.on('error', () => {}); });
  socket.on('connect', () => socket.write('POST /daemon-stop HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  await rejected;
  assert.equal((await run(['daemon', 'status'])).data.protocol, 1);

  const child = spawn(process.execPath, [bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const messages = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => messages.push(JSON.parse(line)));
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  try {
    send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-test', version: '1' } });
    const { result: initialization } = await eventually(() => messages.find(m => m.id === 1), 'initialize MCP');
    assert.equal(initialization.protocolVersion, '2025-11-25');
    assert.equal(initialization.serverInfo.version, manifest.version);
    send(undefined, 'notifications/initialized');
    send(2, 'tools/list');
    const { result: inventory } = await eventually(() => messages.find(m => m.id === 2), 'list MCP tools');
    assert.ok(inventory.tools.some(tool => tool.name === 'freeze'));
    for (const name of ['ports', 'services']) assert.equal(inventory.tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
    send(3, 'tools/call', { name: 'reconcile', arguments: { ids: [id] }, _meta: { progressToken: 'native' } });
    assert.equal((await eventually(() => messages.find(m => m.id === 3), 'call MCP tool')).result.structuredContent.data.status, 'complete');
    assert.ok(messages.some(m => m.method === 'notifications/progress'));
    send(4, 'tools/call', { name: 'ports', arguments: {} });
    const { result: ports } = await eventually(() => messages.find(m => m.id === 4), 'list ports through MCP');
    assert.ok(ports.structuredContent.data.some(row => row.protocol === 'tcp' && row.port === foreignPort));
  } finally { child.stdin.end(); lines.close(); }
});
