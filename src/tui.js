import { emitKeypressEvents } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { problem } from './errors.js';
import { request, waitOperation } from './ipc.js';

const esc = '\x1b[';
const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const states = ['all', 'discovered', 'running', 'adopted', 'frozen', 'sleeping', 'partial', 'exited'];
const sorts = ['name', 'state', 'processCount', 'cpuPercent', 'rssSum'];
const consequence = {
  freeze: 'Suspend reviewed processes. Memory and listening sockets are retained.',
  resume: 'Release recorded suspensions. Connections and credentials may have expired.',
  sleep: 'Graceful shutdown using the reviewed recipe. Durable data is retained.',
  wake: 'Cold start from the recipe in dependency order.',
  checkpoint: 'Capture supported local process memory into private storage.',
  restore: 'Restore a verified checkpoint into an inactive project.',
  reconcile: 'Compare current identities with durable ownership and operation history.'
};

export async function interactive() {
  const input = process.stdin;
  const output = process.stdout;
  const colors = !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb';
  const selected = new Set();
  let cursor = 0, scroll = 0, filter = 0, sort = 0, search = '', projects = [];
  let page = 'list', detail, expanded = false, editing, preview, active, done = false, updating = false, detaching;
  let message = 'Scanning authorized processes…';
  const visible = () => projects.filter(project => (filter === 0 || project.state === states[filter]) &&
    `${project.name} ${project.cwd} ${project.state}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) =>
    typeof a[sorts[sort]] === 'number' && typeof b[sorts[sort]] === 'number' ? b[sorts[sort]] - a[sorts[sort]]
      : String(a[sorts[sort]] ?? '').localeCompare(String(b[sorts[sort]] ?? '')));
  const current = () => detail ?? visible()[cursor];

  function draw() {
    if (done) return;
    const width = Math.max(18, (output.columns ?? 80) - 1);
    const height = Math.max(7, output.rows ?? 24);
    const lines = ['ProjectFreeze', ''];
    if (page === 'help') {
      lines.push('↑/↓ Move    Space Select    Enter Inspect    → Expand    ← Collapse',
        '/ Search    s Sort    t Filter    r Refresh    ? Help    q Close',
        'a Adopt    l Launch recipe    f Freeze    u Resume    z Sleep    w Wake',
        'c Checkpoint    o Restore    e Reconcile    h History    x Cancel operation',
        'Close or Ctrl-C to detach. Reconnect with projectfreeze or operation ID.',
        'Cancellation takes effect at a resource boundary. Inspect outcomes after cancellation.');
    } else if (page === 'history') {
      lines.push('Operation history', '', ...((detail?.operations ?? []).flatMap(op => [
        `${op.status} ${op.action} ${op.id}`, ...op.outcomes.map(outcome => `  ${outcome.status} ${outcome.target} ${outcome.message ?? ''}`)])));
    } else if (page === 'detail' && detail) {
      lines.push(`${detail.name}  ${detail.state}  ${detail.confidence}`, detail.cwd,
        `Processes ${detail.processCount}   CPU ${detail.cpuPercent?.toFixed(1) ?? '?'}%   RSS sum ${detail.rssSum ? (detail.rssSum / 2 ** 20).toFixed(1) + ' MiB' : '?'}`,
        `TCP listeners ${detail.ports.map(port => `[${port.address}]:${port.port}`).join(' ') || 'none observed'}`,
        `Dependencies ${detail.dependencies.join(', ') || 'none'}   Compose ${detail.containers.length}   systemd ${detail.systemd.length}   Other supervisors ${detail.supervisors?.length ?? 0}`,
        `${detail.unresolved?.length ?? 0} unresolved   ${detail.operations?.filter(op => ['running', 'interrupted', 'partial'].includes(op.status)).length ?? 0} incomplete operations`);
      if (expanded) {
        const rows = detail.processes;
        const pids = new Set(rows.map(row => row.pid));
        const visited = new Set();
        const render = (p, level) => {
          if (visited.has(p.pid)) return;
          visited.add(p.pid);
          lines.push(`${'  '.repeat(Math.min(level, 8))}${p.pid} ${p.state} ${p.image ?? p.cwd ?? ''}`);
          rows.filter(row => row.parent === p.pid).forEach(row => render(row, level + 1));
        };
        rows.filter(row => !pids.has(row.parent)).forEach(row => render(row, 0));
      }
      lines.push(detail.metrics ?? 'Observed candidates require explicit ownership review.');
    } else {
      const rows = visible();
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      const count = Math.max(1, height - 8);
      scroll = Math.max(0, Math.min(scroll, cursor));
      if (cursor >= scroll + count) scroll = cursor - count + 1;
      lines.push(`Search ${search || 'all'}   Filter ${states[filter]}   Sort ${sorts[sort]}   Selected ${selected.size}`, '');
      for (const [index, row] of rows.slice(scroll, scroll + count).entries()) {
        lines.push(`${index + scroll === cursor ? '>' : ' '} ${selected.has(row.id) ? '[x]' : '[ ]'} ${row.name}  ${row.state}  ${row.processCount} proc  ${row.cwd}`);
      }
      if (!rows.length) lines.push('No projects in the current view.');
    }
    if (preview) {
      lines.splice(2, Infinity, preview.title, '', ...preview.lines, '', 'Enter Confirm    Esc Back');
    }
    if (editing) lines.splice(2, Infinity, `${editing.label} ${editing.text}`, '', 'Enter Apply    Esc Cancel');
    const banner = active ? `Operation ${active.id} ${active.status ?? ''} ${active.pending ?? ''}` : message;
    const body = lines.slice(0, height - 3).map(value => Array.from(clean(value)).slice(0, width).join(''));
    const tail = [banner, '? Help   Esc Back   q Close'].map(value => Array.from(clean(value)).slice(0, width).join(''));
    output.write(`${esc}H${esc}2J${colors ? `${esc}1m${body.shift()}${esc}0m\n` : ''}${body.join('\n')}\n\n${tail.join('\n')}`);
  }

  async function refresh() {
    if (updating || done) return;
    updating = true;
    try {
      projects = await request('list');
      if (detail && page === 'detail') detail = await request('inspect', { id: detail.id });
    } catch (error) { message = problem(error).message; }
    finally { updating = false; draw(); }
  }

  async function act(action, args) {
    if (active) return;
    try {
      active = await request(action, args);
      draw();
      detaching = new AbortController();
      const result = await waitOperation(active.id, op => { active = op; draw(); }, detaching.signal);
      message = `${action} ${result.status} ${result.outcomes.filter(o => o.status === 'failed').map(o => o.message).join(' ')}`;
      return result.status === 'complete';
    } catch (error) { message = problem(error).message; }
    finally { active = undefined; void refresh(); }
  }

  function review(action, ids, args = {}) {
    if (active || !ids.length) return;
    const projectsInScope = ids.map(id => projects.find(p => p.id === id)).filter(Boolean);
    preview = { title: `${action} ${ids.length} project(s)`, lines: [consequence[action], ...projectsInScope.map(p =>
      `${p.name} ${p.processCount} process(es), ${p.ports.length} TCP listener(s), ${p.containers.length} Compose service(s)`) ],
    run: () => act(action, { ids, ...args }) };
  }

  async function adopt(project, after) {
    if (active) return;
    detail = await request('inspect', { id: project.id });
    page = 'detail';
    const members = detail.candidates ?? [];
    if (!members.length) { message = 'No current candidates available for review.'; return; }
    editing = { label: 'Approved candidate PIDs (comma-separated)', text: '', apply: text => {
      const pid = new Set(text.split(',').map(s => Number(s.trim())));
      const approved = members.filter(row => pid.has(row.pid));
      if (!approved.length || approved.length !== pid.size) { message = 'Enter candidate PIDs shown in project inspection.'; return; }
      preview = { title: `Adopt ${approved.length} explicitly approved process(es)`, lines: approved.map(row => `${row.pid} ${row.image ?? row.cwd}`),
        run: async () => {
          const adopted = await act('adopt', { cwd: project.cwd, confirm: true, members: approved.map(({ pid, birth, boot }) => ({ pid, birth, boot })) });
          if (adopted && after) await after();
        } };
    } };
    message = `Candidates ${members.map(row => row.pid).join(', ')}`;
  }

  async function reviewFreeze(ids) {
    const observed = projects.find(project => ids.includes(project.id) && project.state === 'discovered');
    if (!observed) { review('freeze', ids); return; }
    await adopt(observed, async () => {
      projects = await request('list');
      await reviewFreeze(ids);
    });
  }

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(`${esc}?1049h${esc}?25l`);
  const exit = () => {
    done = true;
    detaching?.abort();
    input.off('keypress', keypress);
    input.setRawMode(false);
    input.pause();
    output.off('resize', draw);
    clearInterval(timer);
    output.write(`${esc}?25h${esc}?1049l${active ? `Operation ${active.id} continues in the daemon.\n` : ''}`);
  };
  async function handle(str, key) {
    const name = key?.name;
    if (key?.ctrl && name === 'c') { exit(); return; }
    if (editing) {
      if (name === 'escape') editing = undefined;
      else if (name === 'return') { const { text, apply } = editing; editing = undefined; await apply(text); }
      else if (name === 'backspace') editing.text = Array.from(editing.text).slice(0, -1).join('');
      else if (str && !key.ctrl && !key.meta) editing.text += clean(str);
      return;
    }
    if (preview) {
      if (name === 'escape') preview = undefined;
      else if (name === 'return') { const { run } = preview; preview = undefined; await run(); }
      return;
    }
    if (name === 'q') { exit(); return; }
    if (name === 'escape') { page = 'list'; detail = undefined; return; }
    if (str === '?') { page = 'help'; return; }
    if (name === 'x' && active) { await request('cancel', { id: active.id }); return; }
    if (name === 'r') { await refresh(); return; }
    if (str === '/') { editing = { label: 'Search', text: search, apply: value => { search = value; cursor = 0; page = 'list'; detail = undefined; } }; return; }
    if (name === 's') { sort = (sort + 1) % sorts.length; return; }
    if (name === 't') { filter = (filter + 1) % states.length; return; }
    if (name === 'l') { editing = { label: 'Path to JSON launch recipe', text: '', apply: async path => {
      const recipe = JSON.parse(await readFile(resolve(path), 'utf8'));
      recipe.cwd = resolve(recipe.cwd ?? '.');
      preview = { title: 'Launch reviewed recipe', lines: [recipe.cwd, String(recipe.argv?.[0])], run: () => act('run', { recipe }) };
    } }; return; }
    if (name === 'h') { detail = { ...detail, operations: await request('history') }; page = 'history'; return; }
    const project = current();
    if (!project) return;
    if (page === 'list' && ['up', 'down'].includes(name)) cursor += name === 'up' ? -1 : 1;
    if (name === 'space' && page === 'list') selected.has(project.id) ? selected.delete(project.id) : selected.add(project.id);
    if (name === 'return' && page === 'list') { detail = await request('inspect', { id: project.id }); page = 'detail'; }
    if (name === 'right') expanded = true;
    if (name === 'left') expanded = false;
    if (name === 'a') { await adopt(project); return; }
    const action = ({ f: 'freeze', u: 'resume', z: 'sleep', w: 'wake', c: 'checkpoint', o: 'restore', e: 'reconcile' })[name];
    if (!action) return;
    const ids = selected.size ? [...selected] : [project.id];
    if (action === 'freeze') { await reviewFreeze(ids); return; }
    if (action === 'restore') { editing = { label: 'Checkpoint ID', text: '', apply: checkpoint => review(action, ids, { checkpoint }) }; return; }
    review(action, ids);
  }
  function keypress(str, key) { void handle(str, key).catch(error => { message = problem(error).message; }).finally(draw); }
  input.on('keypress', keypress);
  output.on('resize', draw);
  const timer = setInterval(() => void refresh(), 2500);
  await refresh();
}
