import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { problem } from './errors.js';
import { request, waitOperation } from './ipc.js';
import { identity } from './platform.js';

const write = line => process.stdout.write(`${line}\n`);
const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const endpoints = ports => [...new Set(ports.map(({ port }) => port))].join(', ') || 'none';
const actions = { f: 'freeze', u: 'resume', z: 'sleep', w: 'wake' };

export async function lineMenu() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let nextLine;
  let closed = false;
  function receive(value) {
    const resolveLine = nextLine;
    nextLine = undefined;
    resolveLine?.(value);
  }
  input.on('line', receive);
  input.once('close', () => { closed = true; receive(undefined); });
  const abort = new AbortController();
  const numbers = new Map();
  function detach() { abort.abort(); input.close(); }
  process.once('SIGINT', detach);
  async function ask(prompt) {
    if (closed) return undefined;
    return new Promise(resolveLine => {
      nextLine = value => resolveLine(value?.trim());
      write(prompt);
    });
  }
  async function execute(action, payload, label) {
    if ((await ask(`${label}\nApply ${action}? [y/N]`))?.toLowerCase() !== 'y') return;
    const started = await request(action, payload);
    write(`Operation ${started.id}`);
    const result = await waitOperation(started.id, () => {}, abort.signal);
    write(`${action} ${result.status}`);
    for (const outcome of result.outcomes.filter(item => item.status === 'failed')) write(clean(outcome.message ?? outcome.code));
    if (result.status === 'complete') return result;
  }
  async function showListeners() {
    const ports = await request('ports');
    write('Local TCP and UDP ports (read-only)');
    if (!ports.length) write('No local endpoints observed.');
    for (const port of ports) write(clean(`${port.protocol.toUpperCase()} ${port.address.includes(':') ? `[${port.address}]` : port.address}:${port.port}  PID ${port.pid ?? 'unknown'}  ${port.name ?? port.image ?? 'unassigned'}  (${port.scope})`));
  }
  async function showServices() {
    const { rows, unavailable } = await request('services');
    write('Running services (read-only)');
    if (!rows.length) write('No running services observed.');
    for (const row of rows) write(clean(`${row.manager}  ${row.name}  PID ${row.pid ?? 'unknown'}  ${row.description ?? ''}`));
    for (const scope of unavailable) write(clean(`${scope} service manager unavailable`));
  }
  async function loadRecipe(path) {
    const recipe = JSON.parse(await readFile(resolve(path), 'utf8'));
    recipe.cwd = resolve(recipe.cwd ?? '.');
    return recipe;
  }
  async function adopt(project) {
    if (!project.candidates.length) { write('No current candidates to review.'); return; }
    for (const row of project.candidates) write(clean(`Candidate PID ${row.pid}  TCP ${endpoints(row.ports)}  ${row.image ?? ''}`));
    const value = await ask('Approved PIDs, comma-separated (Enter cancels)');
    if (!value) return;
    const pids = new Set(value.split(',').map(value => Number(value.trim())));
    const approved = project.candidates.filter(row => pids.has(row.pid));
    if (approved.length !== pids.size) { write('Select only the listed candidate PIDs.'); return; }
    const path = await ask('Optional JSON restart recipe (Enter skips)');
    const id = project.state === 'discovered' ? undefined : project.id;
    return execute('adopt', { id, cwd: project.cwd, confirm: true, members: approved.map(identity), recipe: path ? await loadRecipe(path) : undefined },
      `${clean(project.name)}  PID ${approved.map(row => row.pid).join(', ')}`);
  }
  async function inspect(project) {
    let id = project.id;
    while (!abort.signal.aborted) {
      const live = await request('inspect', { id });
      write(clean(`${live.name} [${live.state}]  TCP ${endpoints(live.ports)}  ${live.id}`));
      for (const row of live.processes) write(clean(`PID ${row.pid}  TCP ${endpoints(row.ports)}  ${row.image ?? ''}`));
      const value = await ask('f Freeze   u Resume   z Sleep   w Wake   a Review candidates   r Refresh   b Back   q Quit');
      if (value === 'q' || value === undefined) { detach(); return; }
      if (value === 'b' || value === '') return;
      if (value === 'a' || (value === 'f' && live.state === 'discovered')) {
        const adopted = await adopt(live);
        if (adopted) [id] = adopted.projects;
        continue;
      }
      if (!Object.hasOwn(actions, value)) continue;
      await execute(actions[value], { ids: [id] }, `${clean(live.name)}  ${live.processCount} process(es)  TCP ${endpoints(live.ports)}`);
    }
  }
  function renderProjects(projects) {
    const lines = projects.map(project => {
      if (!numbers.has(project.id)) numbers.set(project.id, numbers.size + 1);
      return clean(`${numbers.get(project.id)}. ${project.name} [${project.state}]  TCP ${endpoints(project.ports)}  ${project.processCount} process(es)`);
    });
    return lines.join('\n') || 'No projects observed. Use p to view local ports.';
  }
  try {
    while (!abort.signal.aborted) {
      try {
        const scan = () => request('list').then(rows => rows.sort((a, b) => b.processCount - a.processCount || a.name.localeCompare(b.name)));
        const prompt = 'Project number   p Ports   v Services   l Launch recipe   Enter Refresh   q Quit';
        let projects = await scan();
        let rendered = renderProjects(projects);
        write(`\nProjectFreeze\n${rendered}`);
        let waiting = true;
        let updating = false;
        const timer = setInterval(async () => {
          if (updating) return;
          updating = true;
          try {
            const snapshot = await scan();
            if (!waiting || !nextLine) return;
            projects = snapshot;
            const current = renderProjects(projects);
            if (rendered !== current) {
              rendered = current;
              write(`\nProjectFreeze\n${rendered}\n${prompt}`);
            }
          } catch { /* The previous snapshot remains visible until the next scan. */ }
          finally { updating = false; }
        }, 2500);
        let value;
        try { value = await ask(prompt); }
        finally { waiting = false; clearInterval(timer); }
        if (value === 'q' || value === undefined) return;
        if (value === 'p') await showListeners();
        else if (value === 'v') await showServices();
        else if (value === 'l') {
          const path = await ask('Path to JSON launch recipe (Enter cancels)');
          if (path) {
            const recipe = await loadRecipe(path);
            await execute('run', { recipe }, clean(`${recipe.cwd}\nExecutable ${recipe.argv?.[0] ?? '(missing)'}`));
          }
        } else if (/^[1-9]\d*$/.test(value)) {
          const project = projects.find(row => numbers.get(row.id) === Number(value));
          if (project) await inspect(project);
        }
      } catch (error) {
        write(clean(problem(error).message));
        if ((await ask('Enter Retry   q Quit')) !== '') return;
      }
    }
  } finally { process.off('SIGINT', detach); input.close(); }
}
