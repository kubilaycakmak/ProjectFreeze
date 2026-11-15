import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import { Fault, problem } from './errors.js';
import { command, checkHelper, helper, windows } from './platform.js';
import { Store } from './store.js';

export const protocol = 1;
const maxRequest = 192 * 1024;
const maxResponse = 16 * 1024 * 1024;
const nonce = () => randomBytes(32).toString('hex');
const validHex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mac = (secret, ...parts) => createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(parts)).digest('hex');
const same = (a, b) => validHex(a) && validHex(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const recordPath = dir => join(dir, 'endpoint.json');
const actions = new Set(['list', 'discover', 'inspect', 'listeners', 'ports', 'services', 'history', 'operation', 'cancel', 'adopt', 'run', 'freeze', 'resume',
  'sleep', 'kill', 'wake', 'checkpoint', 'restore', 'reconcile', 'daemon-status', 'daemon-stop']);
const inventoryActions = new Set(['ports', 'services']);
const unknownAction = 'Unknown action or invalid arguments.';

export async function stateDirectory() {
  const dir = process.env.PROJECTFREEZE_HOME ?? (windows ? join(process.env.LOCALAPPDATA ?? homedir(), 'ProjectFreeze') : join(homedir(), '.projectfreeze'));
  if (!isAbsolute(dir)) throw new Fault('USAGE', 'PROJECTFREEZE_HOME must be an absolute path.');
  if (windows) {
    await checkHelper();
    await command(helper, ['secure-directory', dir]).catch(() => { throw new Fault('DENIED', 'ProjectFreeze state requires a private directory owned by the current Windows user.'); });
  } else {
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Fault('DENIED', 'ProjectFreeze state requires a real, user-owned 0700 directory.');
    }
  }
  return realpath(dir);
}

function frames(socket, limit, callback) {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > limit) { socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf(10)) !== -1 && !socket.destroyed) {
      const raw = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      try { callback(JSON.parse(raw)); }
      catch { socket.destroy(); }
    }
  });
}

const line = value => `${JSON.stringify(value)}\n`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validate(action, input) {
  if (!actions.has(action) || !object(input)) throw new Fault('USAGE', unknownAction);
  if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > 32 || input.ids.some(id => typeof id !== 'string' || !/^p-[a-f0-9]{16}$/.test(id)))) {
    throw new Fault('USAGE', 'Project IDs must be an array of registered project identifiers.');
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || input.id.length > 64)) throw new Fault('USAGE', 'Invalid identifier.');
  for (const name of ['members', 'exclude']) {
    if (input[name] !== undefined && (!Array.isArray(input[name]) || input[name].length > 256 || input[name].some(value =>
      !object(value) || !Number.isSafeInteger(value.pid) || value.pid < 2 || typeof value.birth !== 'string' ||
      !/^[0-9.]{1,64}$/.test(value.birth) || !validBoot(value.boot)))) throw new Fault('USAGE', 'Invalid process identity.');
  }
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))) throw new Fault('USAGE', 'Supply an absolute project directory.');
}

const validBoot = value => typeof value === 'string' && /^[a-f0-9-]{12,80}$/i.test(value);

function transport(record, dir) {
  if (Number.isInteger(record.port) && record.port > 0 && record.port <= 65535) return { host: '127.0.0.1', port: record.port };
  if (!windows && /^pf-[a-f0-9]{12}\.sock$/.test(record.socket)) return { path: join(dir, record.socket) };
  throw new Fault('UNAVAILABLE', 'Local daemon endpoint is invalid.');
}

export async function daemon() {
  const dir = await stateDirectory();
  if (!windows) process.umask(0o077);
  const lock = new DatabaseSync(join(dir, 'daemon-lock.sqlite'));
  try { lock.exec('BEGIN EXCLUSIVE'); }
  catch { lock.close(); throw new Fault('BUSY', 'A daemon already owns this state directory.'); }
  const store = new Store(dir);
  const engine = new Engine(store, dir);
  const secret = nonce();
  const name = `pf-${nonce().slice(0, 12)}.sock`;
  const socketPath = join(dir, name);
  const loopback = windows || Buffer.byteLength(socketPath) >= 100;
  const connections = new Set();
  let closing = false;
  let timer;
  const server = createServer(socket => {
    if (connections.size >= 96 || closing) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    let greeting;
    let handled = false;
    frames(socket, maxRequest, message => {
      if (!greeting) {
        if (message?.v !== protocol || !validHex(message.client)) { socket.destroy(); return; }
        const server = nonce();
        greeting = { client: message.client, server };
        socket.write(line({ server, proof: mac(secret, 'server', protocol, greeting.client, server) }));
        return;
      }
      if (handled || typeof message?.request !== 'string' || !same(message.proof,
        mac(secret, 'client', protocol, greeting.client, greeting.server, message.request))) { socket.destroy(); return; }
      handled = true;
      socket.setTimeout(20000, () => socket.destroy());
      void (async () => {
        const { action, input } = JSON.parse(message.request);
        validate(action, input);
        if (action === 'daemon-status') return { pid: process.pid, protocol, busy: engine.current?.op.id };
        if (action === 'daemon-stop') {
          if (engine.current) throw new Fault('BUSY', 'Wait for the operation to finish before stopping the daemon.');
          closing = true;
          engine.closing = true;
          while (engine.tracking) await delay(25);
          return { stopped: true };
        }
        return engine.dispatch(action, input);
      })().then(data => ({ ok: true, data }), error => ({ ok: false, error: problem(error) })).then(result => {
        const response = JSON.stringify(result);
        if (closing && result.ok && result.data?.stopped) {
          socket.end(line({ response, proof: mac(secret, 'response', protocol, greeting.client, greeting.server, response) }), () => void shutdown());
        } else socket.end(line({ response, proof: mac(secret, 'response', protocol, greeting.client, greeting.server, response) }));
      }).catch(() => socket.destroy());
    });
  });

  let stopped = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    closing = true;
    clearInterval(timer);
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await unlink(recordPath(dir)).catch(() => {});
    if (!loopback) await unlink(socketPath).catch(() => {});
    while (engine.current || engine.tracking) await delay(100);
    store.close();
    lock.exec('ROLLBACK');
    lock.close();
  }

  const old = await readFile(recordPath(dir), 'utf8').then(JSON.parse).catch(() => null);
  if (!windows && old && /^pf-[a-f0-9]{12}\.sock$/.test(old.socket)) await unlink(join(dir, old.socket)).catch(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(loopback ? { host: '127.0.0.1', port: 0, exclusive: true } : { path: socketPath, exclusive: true }, resolve);
  });
  if (!loopback) await chmod(socketPath, 0o600);
  const record = { v: protocol, secret, ...(loopback ? { port: server.address().port } : { socket: name }) };
  const staged = join(dir, `endpoint-${nonce().slice(0, 12)}.json`);
  await writeFile(staged, line(record), { flag: 'wx', mode: 0o600 });
  await rename(staged, recordPath(dir));
  timer = setInterval(() => { if (!closing) void engine.poll().catch(() => {}); }, 1750);
  timer.unref();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

async function endpointRecord(dir) {
  const record = await readFile(recordPath(dir), 'utf8').then(JSON.parse).catch(() => null);
  if (!record || !validHex(record.secret)) throw new Fault('UNAVAILABLE', 'Local daemon is not running.');
  if (record.v !== protocol) throw new Fault('UNSUPPORTED', 'Local daemon protocol differs. Stop the old daemon and restart it.');
  return record;
}

async function connect(dir, action, input, record) {
  record ??= await endpointRecord(dir);
  const address = transport(record, dir);
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    const client = nonce();
    const unavailable = () => reject(new Fault('UNAVAILABLE', 'Local daemon did not complete the authenticated request.'));
    let greeting;
    socket.setTimeout(22000, () => socket.destroy());
    socket.on('error', unavailable);
    socket.on('close', unavailable);
    socket.once('connect', () => socket.write(line({ v: protocol, client })));
    frames(socket, maxResponse, message => {
      if (!greeting) {
        if (!validHex(message?.server) || !same(message.proof, mac(record.secret, 'server', protocol, client, message.server))) {
          socket.destroy(); return;
        }
        greeting = message.server;
        const request = JSON.stringify({ action, input });
        if (Buffer.byteLength(request) > maxRequest / 2) { reject(new Fault('USAGE', 'Request is too large.')); socket.destroy(); return; }
        socket.write(line({ request, proof: mac(record.secret, 'client', protocol, client, greeting, request) }));
        return;
      }
      if (typeof message?.response !== 'string' || !same(message.proof, mac(record.secret, 'response', protocol, client, greeting, message.response))) {
        socket.destroy(); return;
      }
      const result = JSON.parse(message.response);
      if (result.ok) resolve(result.data);
      else reject(new Fault(result.error.code, result.error.message, result.error.details));
      socket.destroy();
    });
  });
}

let cachedDir;
let starting;
let replacing;
async function start(dir) {
  let running = false;
  for (let i = 0; i < 100; i++) {
    if (!running && i % 10 === 0) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url)), '_daemon'],
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: dir, env: process.env });
      running = true;
      child.once('error', () => { running = false; });
      child.once('exit', () => { running = false; });
      child.unref();
    }
    await delay(120);
    try { return await connect(dir, 'daemon-status', {}); }
    catch (error) { if (error.code !== 'UNAVAILABLE') throw error; }
  }
  throw new Fault('UNAVAILABLE', 'Daemon startup timed out. Run projectfreeze daemon foreground to inspect the startup error.');
}

async function replaceLegacyDaemon(dir, record) {
  try {
    // Use the endpoint that rejected the action so a concurrent client cannot stop its replacement.
    await connect(dir, 'daemon-stop', {}, record);
  } catch (error) {
    if (error.code === 'BUSY') throw new Fault('BUSY', 'The daemon needs an update for this view. Wait for its current operation to finish and retry.');
    if (error.code !== 'UNAVAILABLE') throw error;
  }
  await start(dir);
}

async function connectForAction(dir, action, input) {
  if (!inventoryActions.has(action)) return connect(dir, action, input);
  const record = await endpointRecord(dir);
  try { return await connect(dir, action, input, record); }
  catch (error) {
    if (!object(input) || error.code !== 'USAGE' || error.message !== unknownAction) throw error;
    await (replacing ??= replaceLegacyDaemon(dir, record).finally(() => { replacing = undefined; }));
    return connect(dir, action, input);
  }
}

export async function request(action, input = {}, autoStart = true) {
  const dir = await (cachedDir ??= stateDirectory());
  if (action === 'daemon-start') {
    try { return await connect(dir, 'daemon-status', {}); }
    catch (error) { if (error.code !== 'UNAVAILABLE') throw error; }
    return start(dir);
  }
  if (!autoStart) return connect(dir, action, input);
  if (['list', 'discover', 'inspect', 'listeners', 'ports', 'services', 'history', 'operation'].includes(action)) {
    try { return await connectForAction(dir, action, input); }
    catch (error) { if (error.code !== 'UNAVAILABLE') throw error; }
  }
  try { await connect(dir, 'daemon-status', {}); }
  catch (error) {
    if (error.code !== 'UNAVAILABLE') throw error;
    await (starting ??= start(dir).finally(() => { starting = undefined; }));
  }
  return connectForAction(dir, action, input);
}

export async function waitOperation(id, onProgress = () => {}, signal) {
  let last;
  while (!signal?.aborted) {
    const op = await request('operation', { id });
    const stamp = `${op.status}/${op.outcomes.length}/${op.pending}`;
    if (stamp !== last) { onProgress(op); last = stamp; }
    if (op.status !== 'running') return op;
    if (signal?.aborted) return op;
    await delay(200);
  }
  return { id, status: 'running', outcomes: [] };
}
