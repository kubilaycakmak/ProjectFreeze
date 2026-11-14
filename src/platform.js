import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { Fault } from './errors.js';

const exec = promisify(execFile);
export const windows = process.platform === 'win32';
export const linux = process.platform === 'linux';
const name = `projectfreeze-${process.platform}-${process.arch}${windows ? '.exe' : ''}`;
export const helper = fileURLToPath(new URL(`../helpers/${name}`, import.meta.url));
const sys = windows ? join(process.env.SystemRoot, 'System32') : '/usr/bin';
const ps = join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const powershell = (script) => command(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
const samples = new Map();
const knownStates = new Set(['R', 'S', 'D', 'T', 't', 'I', 'M', '?', 'P', 'Z', 'X']);
const ignorePids = new Set([process.pid]);

export function identity(p) { return { pid: p.pid, birth: p.birth, boot: p.boot }; }
export function key(p) { return `${p.boot}/${p.pid}/${p.birth}`; }
export function matches(a, b) { return a && b && key(a) === key(b); }
export function ignored(pid) { return ignorePids.has(pid); }

export async function command(file, args, options = {}) {
  try {
    return (await exec(file, args, { timeout: 12000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options })).stdout;
  } catch (error) {
    const code = ({ ENOENT: 'UNAVAILABLE', EACCES: 'DENIED', 2: 'USAGE', 3: 'NOT_FOUND', 4: 'DENIED', 5: 'UNSUPPORTED', 6: 'BUSY' })[error.code] ?? 'PARTIAL';
    throw new Fault(code, `Execution of ${basename(file)} failed.`, { exit: error.code });
  }
}

let checked;
export function checkHelper() {
  return checked ??= Promise.all([readFile(helper), readFile(`${helper}.sha256`, 'utf8')]).then(([bytes, manifest]) => {
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.split(' ')[0]) {
      throw new Fault('DENIED', 'Native helper integrity check failed. Reinstall the package.');
    }
  }, () => { throw new Fault('UNAVAILABLE', `Missing native helper for ${process.platform}/${process.arch}. Install a release tarball or run npm run build:native.`); });
}

let boot;
export function bootId() {
  return boot ??= (linux ? readFile('/proc/sys/kernel/random/boot_id', 'utf8') : windows
    ? powershell('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks')
    : command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).then(value => {
    const id = value.trim();
    if (!/^[a-f0-9-]{12,80}$/i.test(id)) throw new Fault('UNAVAILABLE', 'A stable boot identity could not be verified.');
    return id;
  });
}

let linuxUnits;
function units() {
  return linuxUnits ??= Promise.all([command('/usr/bin/getconf', ['CLK_TCK']), command('/usr/bin/getconf', ['PAGESIZE'])])
    .then(values => values.map(Number));
}

async function linuxProcess(pid, boot, clock, pageSize, full) {
  const base = `/proc/${pid}`;
  try {
    if ((await stat(base)).uid !== process.getuid()) return null;
    const raw = await readFile(`${base}/stat`, 'utf8');
    const parts = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!knownStates.has(parts[0]) || parts[0] === 'Z' || parts[0] === 'X') return null;
    const row = { pid, boot, birth: parts[19], parent: +parts[1], group: +parts[2], session: +parts[3], state: parts[0],
      cpuTime: (+parts[11] + +parts[12]) * 1e9 / clock, rss: +parts[21] * pageSize, ports: [] };
    if (full) {
      const [cwd, image, args] = await Promise.all([
        readlink(`${base}/cwd`).catch(() => undefined), readlink(`${base}/exe`).catch(() => undefined),
        readFile(`${base}/cmdline`, 'utf8').catch(() => '')
      ]);
      row.cwd = cwd;
      row.image = image;
      row.projectHint = argumentHint(args.split('\0'), cwd);
      const current = await readFile(`${base}/stat`, 'utf8');
      if (current.slice(current.lastIndexOf(')') + 2).split(' ')[19] !== row.birth) return null;
    }
    return row;
  } catch { return null; }
}

function argumentHint(args, cwd) {
  const path = args.slice(1, 8).find(value => /\.(?:[cm]?js|tsx?|py|rb|jar|php)$/i.test(value) &&
    !value.startsWith('-') && (isAbsolute(value) || cwd));
  return path ? resolve(cwd ?? '.', path) : undefined;
}

function parseAddress(hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length === 4) return [...bytes.reverse()].join('.');
  if (bytes.length !== 16) return undefined;
  for (let i = 0; i < 16; i += 4) bytes.subarray(i, i + 4).reverse();
  return Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':');
}

async function linuxPorts(rows) {
  const namespaces = new Map();
  await Promise.all(rows.map(async row => {
    const ns = await readlink(`/proc/${row.pid}/ns/net`).catch(() => undefined);
    if (ns) namespaces.set(ns, [...(namespaces.get(ns) ?? []), row]);
  }));
  for (const group of namespaces.values()) {
    const tables = await Promise.all(['tcp', 'tcp6'].map(proto => readFile(`/proc/${group[0].pid}/net/${proto}`, 'utf8').catch(() => '')));
    const sockets = new Map();
    for (const line of tables.join('\n').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [host, port] = fields[1].split(':');
      const address = parseAddress(host);
      if (address) sockets.set(`socket:[${fields[9]}]`, { address, port: Number.parseInt(port, 16) });
    }
    for (const row of group) {
      const path = `/proc/${row.pid}/fd`;
      const descriptors = await readdir(path).catch(() => []);
      const links = await Promise.all(descriptors.map(fd => readlink(`${path}/${fd}`).catch(() => '')));
      row.ports = [...new Set(links)].map(link => sockets.get(link)).filter(Boolean);
    }
  }
}

function decode(text, encoding) { return text ? Buffer.from(text, encoding).toString('utf8') : undefined; }

async function nonLinuxRows(boot, full) {
  const result = await command(helper, ['scan']);
  const rows = result.trimEnd().split('\n').filter(Boolean).map(line => {
    const fields = line.replace(/\r$/, '').split('\t');
    if (windows) {
      const [pid, parent, birth, state, cpuTime, rss, image] = fields;
      return { pid: +pid, parent: +parent, group: 0, session: 0, boot, birth, state, cpuTime: +cpuTime,
        rss: +rss < 0 ? undefined : +rss, image: decode(image, 'base64'), ports: [] };
    }
    const [pid, parent, group, birth, state, cpuTime, rss, image, cwd] = fields;
    return { pid: +pid, parent: +parent, group: +group, session: 0, boot, birth, state, cpuTime: +cpuTime, rss: +rss,
      image: decode(image, 'hex'), cwd: decode(cwd, 'hex'), ports: [] };
  });
  if (!full) return rows;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (windows) {
    const [net, args] = await Promise.all([
      command(join(sys, 'netstat.exe'), ['-ano', '-p', 'tcp']).catch(() => ''),
      powershell('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress').catch(() => '[]')
    ]);
    const observed = JSON.parse(args || '[]');
    for (const item of Array.isArray(observed) ? observed : [observed]) {
      const row = byPid.get(item?.ProcessId);
      if (row && item.CommandLine) row.projectHint = argumentHint([...item.CommandLine.matchAll(/"([^"]*)"|([^\s"]+)/g)].map(m => m[1] ?? m[2]));
    }
    for (const line of net.split('\n')) {
      const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (match) byPid.get(+match[3])?.ports.push({ address: match[1].replace(/^\[|\]$/g, ''), port: +match[2] });
    }
  } else {
    const sockets = await command('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']).catch(() => '');
    let pid = 0;
    for (const line of sockets.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      const match = line.match(/^n(.+):(\d+)$/);
      if (match) byPid.get(pid)?.ports.push({ address: match[1].replace(/^\[|\]$/g, ''), port: +match[2] });
    }
  }
  return rows;
}

export async function scan(full = true) {
  await checkHelper();
  const boot = await bootId();
  let rows;
  if (linux) {
    const [clock, page] = await units();
    const ids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
    rows = [];
    for (let i = 0; i < ids.length; i += 48) {
      rows.push(...(await Promise.all(ids.slice(i, i + 48).map(pid => linuxProcess(pid, boot, clock, page, full)))).filter(Boolean));
    }
    if (full) await linuxPorts(rows);
  } else rows = await nonLinuxRows(boot, full);
  rows = rows.filter(row => row.pid > 1 && !ignored(row.pid));
  if (full) {
    const time = performance.now();
    const current = new Set();
    for (const row of rows) {
      const id = key(row);
      current.add(id);
      const previous = samples.get(id);
      if (previous && time > previous.time && row.cpuTime >= previous.cpu) {
        row.cpuPercent = (row.cpuTime - previous.cpu) / ((time - previous.time) * 1e4);
      }
      samples.set(id, { time, cpu: row.cpuTime });
    }
    for (const id of samples.keys()) if (!current.has(id)) samples.delete(id);
  }
  return rows;
}

export async function control(action, target) {
  if (target.boot !== await bootId() || ignored(target.pid)) throw new Fault('NOT_FOUND', 'The process identity is stale or protected.');
  try { await command(helper, [action, String(target.pid), target.birth]); }
  catch (error) { if (error.details?.exit === 10) return false; throw error; }
  return true;
}

export async function executable(value, cwd, env) {
  const path = env.PATH ?? env.Path ?? '';
  const explicit = isAbsolute(value) || value.includes('/') || value.includes('\\');
  const candidates = explicit ? [resolve(cwd, value)] : path.split(delimiter).filter(isAbsolute).map(dir => join(dir, value));
  for (const candidate of candidates) {
    for (const file of windows && !/\.(exe|com)$/i.test(candidate) ? [`${candidate}.exe`, `${candidate}.com`] : [candidate]) {
      try {
        const absolute = await realpath(file);
        await access(absolute, constants.X_OK);
        if (statSync(absolute).isFile()) return absolute;
      } catch { /* A later PATH entry may be executable. */ }
    }
  }
  throw new Fault('UNAVAILABLE', 'The recipe executable could not be resolved. Use an absolute executable or add it to PATH.');
}

export async function stageLaunch(argv, cwd, env, job, cgroup, onExit) {
  await checkHelper();
  const file = await executable(argv[0], cwd, env);
  const marker = windows ? job : cgroup ? join(cgroup, 'cgroup.procs') : '-';
  const child = spawn(helper, ['launch', marker, file, ...argv.slice(1)], { cwd, env, windowsHide: true, detached: true,
    stdio: ['pipe', 'pipe', 'ignore'] });
  let released = false;
  child.once('exit', code => { if (windows) ignorePids.delete(child.pid); if (released) onExit(code); });
  child.stdin.on('error', () => {});
  if (windows && child.pid) ignorePids.add(child.pid);
  const lines = createInterface({ input: child.stdout, terminal: false });
  let timer;
  try {
    const ready = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Fault('UNAVAILABLE', 'Native launch handshake timed out.')), 6000);
      child.once('error', () => reject(new Fault('UNAVAILABLE', 'Native launcher could not start.')));
      lines.once('line', resolve);
      lines.once('close', () => reject(new Fault('DENIED', 'Native launcher could not prepare the workload.')));
    });
    const pid = windows ? Number(ready.split('\t')[0]) : child.pid;
    const root = (await scan(false)).find(row => row.pid === pid);
    if (!root || (windows && root.birth !== ready.split('\t')[1])) throw new Fault('PARTIAL', 'Launch identity could not be verified.');
    return { root: identity(root), release() { released = true; child.stdin.end('G'); child.unref(); }, abort() { child.stdin.end(); } };
  } catch (error) {
    child.stdin.end();
    throw error;
  } finally { clearTimeout(timer); lines.close(); child.stdout.destroy(); }
}

export async function containerPids(project) {
  if (windows && project.job) {
    return new Set((await command(helper, ['members', project.job])).trim().split(/\s+/).map(Number));
  }
  if (linux && project.cgroup) {
    const rows = await readFile(join(project.cgroup, 'cgroup.procs'), 'utf8');
    return new Set(rows.trim().split(/\s+/).map(Number));
  }
  return null;
}

export function manifestStart(p) {
  if (p.projectHint) return dirname(p.projectHint);
  return p.cwd;
}
