import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { identity, key, manifestStart, matches, scan } from './platform.js';
import { Fault } from './errors.js';

const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', '.git'];

export async function directory(value) {
  try {
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch { throw new Fault('USAGE', 'Provide an existing project directory.'); }
}

export function projectId(path) {
  return `p-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

function within(parent, child) {
  if (!child) return false;
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes(':'));
}

async function rootFor(start, cache) {
  if (!start) return undefined;
  if (!cache.has(start)) cache.set(start, (async () => {
    let path = start;
    while (path !== dirname(path)) {
      for (const file of manifests) {
        if (await access(join(path, file)).then(() => true, () => false)) {
          return { path: await realpath(path).catch(() => path), manifest: file };
        }
      }
      path = dirname(path);
    }
  })());
  return cache.get(start);
}

export async function candidates(projects, rows = undefined) {
  const processes = rows ?? await scan();
  const groups = new Map();
  const cache = new Map();
  const claimed = new Set(projects.flatMap(project => project.members.map(key)));
  const observedAt = new Date().toISOString();
  const byPid = new Map(processes.map(p => [p.pid, p]));
  for (const process of processes) {
    if (claimed.has(key(process))) continue;
    const root = await rootFor(manifestStart(process), cache);
    if (!root) continue;
    const id = projectId(root.path);
    const group = groups.get(id) ?? { id, name: basename(root.path), cwd: root.path, state: 'discovered',
      confidence: 'observed', observedAt, members: [], unresolved: [] };
    const evidence = [`manifest:${root.manifest}`];
    if (within(root.path, process.cwd)) evidence.push('working-directory');
    if (within(root.path, process.projectHint)) evidence.push('script-path');
    if (process.image) evidence.push('executable');
    if (process.ports.length) evidence.push('listening-socket');
    const parent = byPid.get(process.parent);
    if (parent && within(root.path, parent.cwd)) evidence.push('observed-parent');
    group.members.push({ ...publicProcess(process), evidence });
    group.unresolved.push(identity(process));
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function publicProcess(row) {
  const { projectHint, cpuTime, ...visible } = row;
  return visible;
}

export function summarize(project, rows, discovered) {
  const processes = rows.filter(row => project.members.some(member => matches(member, row))).map(publicProcess);
  const owners = new Map();
  for (const p of processes) {
    for (const port of p.ports) owners.set(`${port.address}/${port.port}`, port);
  }
  return { id: project.id, name: project.name, cwd: project.cwd, state: project.state,
    confidence: project.members.length ? 'reviewed-or-contained' : 'registered',
    processes, processCount: processes.length, ports: [...owners.values()],
    rssSum: processes.some(p => p.rss !== undefined) ? processes.reduce((n, p) => n + (p.rss ?? 0), 0) : undefined,
    cpuPercent: processes.some(p => p.cpuPercent !== undefined) ? processes.reduce((n, p) => n + (p.cpuPercent ?? 0), 0) : undefined,
    dependencies: project.recipe?.dependencies ?? [], containers: project.recipe?.containers ?? [], systemd: project.recipe?.systemd ?? [],
    excluded: project.excluded, unresolved: discovered?.unresolved ?? [], observedAt: new Date().toISOString(),
    metrics: 'CPU is sampled as percent of one core. RSS sums resident pages and can count shared pages more than once.' };
}
