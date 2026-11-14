import { access, readFile, realpath, stat } from 'node:fs/promises';
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

export function projectId(path, instance) {
  const hash = createHash('sha256').update(path);
  if (instance !== undefined) hash.update('\0').update(instance);
  return `p-${hash.digest('hex').slice(0, 16)}`;
}

function within(parent, child) {
  if (!child) return false;
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes(':'));
}

async function projectFreezeCli(root, hint, cache) {
  if (root.manifest !== 'package.json' || !hint) return false;
  const script = relative(root.path, hint).split(sep).join('/');
  if ((process.platform === 'win32' ? script.toLowerCase() : script) !== 'bin/projectfreeze.js') return false;
  if (!cache.has(root.path)) cache.set(root.path, (async () => {
    const file = join(root.path, 'package.json');
    const info = await stat(file);
    if (!info.isFile()) return false;
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    return manifest.name === '@kubilaycakmak/projectfreeze' && manifest.bin?.projectfreeze === 'bin/projectfreeze.js';
  })().catch(() => false));
  return cache.get(root.path);
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
  const cliPackages = new Map();
  const claimed = new Set(projects.flatMap(project => project.members.map(key)));
  const observedAt = new Date().toISOString();
  const byPid = new Map(processes.map(p => [p.pid, p]));
  for (const process of processes) {
    if (claimed.has(key(process))) continue;
    const root = await rootFor(manifestStart(process), cache) ?? await rootFor(process.cwd, cache);
    if (!root) continue;
    if (await projectFreezeCli(root, process.projectHint, cliPackages)) continue;
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
    if (process.parent <= 1 || !parent) evidence.push('parent-outside-scan');
    if (process.session === process.pid || process.group === process.pid) evidence.push('separate-session-or-group');
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
  return { id: project.id, name: project.name, cwd: project.cwd, instance: project.instance, state: project.state,
    confidence: project.members.length ? 'reviewed-or-contained' : 'registered',
    processes, processCount: processes.length, ports: [...owners.values()],
    rssSum: processes.some(p => p.rss !== undefined) ? processes.reduce((n, p) => n + (p.rss ?? 0), 0) : undefined,
    cpuPercent: processes.some(p => p.cpuPercent !== undefined) ? processes.reduce((n, p) => n + (p.cpuPercent ?? 0), 0) : undefined,
    dependencies: project.recipe?.dependencies ?? [], containers: project.recipe?.containers ?? [], systemd: project.recipe?.systemd ?? [],
    supervisors: project.recipe?.supervisors?.map(({ kind, name, shared }) => ({ kind, name, shared })) ?? [],
    excluded: project.excluded, unresolved: discovered?.unresolved ?? [], observedAt: new Date().toISOString(),
    restart: project.recipe ? { configured: true, gracefulStop: Boolean(project.recipe.stop) } : { configured: false },
    metrics: 'CPU is sampled as percent of one core. RSS sums resident pages and can count shared pages more than once.' };
}
