import { emitKeypressEvents } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { problem } from './errors.js';
import { request, waitOperation } from './ipc.js';
import { identity, key as processKey } from './platform.js';

const esc = '\x1b[';
const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const segment = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wide = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const glyphs = value => Array.from(segment.segment(value), entry => entry.segment);
const columns = value => wide.test(value) ? 2 : 1;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const ports = entries => [...new Set((entries ?? []).map(row => row.port))].join(', ');
const endpoint = row => `${row.address.includes(':') ? `[${row.address}]` : row.address}:${row.port}`;
const mutations = {
  freeze: ['Freeze', 'Suspend reviewed processes. Memory and listening sockets stay allocated.'],
  resume: ['Resume', 'Resume the processes suspended by ProjectFreeze.'],
  sleep: ['Sleep', 'Shut down reviewed processes. Shared listeners may remain open.'],
  kill: ['Force termination', 'Stop the reviewed native processes immediately. Unsaved work may be lost.'],
  wake: ['Wake', 'Start the saved recipe. Expect a new PID and reconnect to the workload.'],
  checkpoint: ['Checkpoint', 'Capture supported process state into private storage.'],
  restore: ['Restore', 'Restore a verified checkpoint into an inactive workload.'],
  reconcile: ['Reconcile', 'Check current process identities against the operation journal.']
};
const shortcuts = { f: 'freeze', u: 'resume', z: 'sleep', k: 'kill', w: 'wake', c: 'checkpoint', o: 'restore', e: 'reconcile' };
const filters = ['all', 'running', 'discovered', 'sleeping', 'frozen', 'partial'];
const sorts = ['activity', 'name', 'ports', 'CPU'];
const helpSections = [
  ['Navigation', [
    ['↑ / ↓', 'Move or scroll'],
    ['PgUp / PgDn', 'Move by one page'],
    ['Home / End', 'Jump to first or last row'],
    ['Enter', 'Open or confirm'],
    ['Esc', 'Go back or cancel'],
    ['?', 'Open or close help'],
    ['q', 'Quit or detach']
  ]],
  ['Workloads', [
    ['l', 'Launch a saved recipe'],
    ['a', 'Review process ownership'],
    ['f', 'Freeze processes'],
    ['u', 'Resume frozen processes'],
    ['z', 'Sleep gracefully'],
    ['w', 'Wake from a saved recipe'],
    ['k', 'Force terminate (two confirmations)']
  ]],
  ['Views and selection', [
    ['Tab / Shift+Tab', 'Switch views'],
    ['← / →', 'Switch views from a list'],
    ['p', 'Open Ports (read-only)'],
    ['v', 'Open Services (read-only)'],
    ['h', 'Open History'],
    ['/', 'Search the current view'],
    ['Space', 'Toggle project selection'],
    ['t', 'Filter projects'],
    ['s', 'Sort projects'],
    ['r', 'Refresh the current view']
  ]],
  ['Recovery', [
    ['c', 'Create a checkpoint'],
    ['o', 'Restore a checkpoint'],
    ['e', 'Reconcile project state'],
    ['x', 'Request operation cancellation']
  ]]
];

function fit(value, width) {
  const parts = glyphs(clean(value));
  const total = parts.reduce((sum, char) => sum + columns(char), 0);
  let text = '';
  let used = 0;
  const limit = total > width ? Math.max(0, width - 1) : width;
  for (const char of parts) {
    const cells = columns(char);
    if (used + cells > limit) break;
    text += char;
    used += cells;
  }
  if (total > width && width) { text += '…'; used++; }
  return text + ' '.repeat(Math.max(0, width - used));
}

function helpGroup([heading, items], span) {
  const keyWidth = 15;
  const inline = span >= 32;
  const continuation = ' '.repeat(inline ? keyWidth + 4 : 4);
  const available = Math.max(1, span - continuation.length);
  const rows = [{ text: heading, tone: '1;36' }];
  for (const [key, description] of items) {
    const wrapped = [];
    for (const word of description.split(' ')) {
      const last = wrapped.at(-1);
      if (last && last.length + word.length + 1 <= available) wrapped[wrapped.length - 1] += ` ${word}`;
      else wrapped.push(word);
    }
    if (inline) rows.push({ text: `  ${fit(key, keyWidth)}  ${wrapped.shift()}` });
    else rows.push({ text: `  ${key}`, tone: '1' });
    rows.push(...wrapped.map(text => ({ text: continuation + text })));
  }
  return rows;
}

function helpRows(span) {
  if (span < 96) return helpSections.flatMap((section, index) => [
    ...(index ? [{ text: '' }] : []), ...helpGroup(section, span)
  ]);
  const gap = '    ';
  const leftWidth = Math.floor((span - gap.length) / 2);
  const rightWidth = span - leftWidth - gap.length;
  const rows = [];
  for (let offset = 0; offset < helpSections.length; offset += 2) {
    const left = helpGroup(helpSections[offset], leftWidth);
    const right = helpGroup(helpSections[offset + 1], rightWidth);
    if (offset) rows.push({ text: '' });
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      rows.push({ text: `${fit(left[index]?.text ?? '', leftWidth)}${gap}${right[index]?.text ?? ''}`, tone: left[index]?.tone ?? right[index]?.tone });
    }
  }
  return rows;
}

function helpPanel(span, budget, dialog) {
  const rows = helpRows(span);
  const capacity = Math.max(1, budget - 2);
  dialog.scroll = clamp(dialog.scroll, 0, rows.length - capacity);
  const end = Math.min(rows.length, dialog.scroll + capacity);
  return [{ text: 'Keyboard shortcuts', tone: '1;36' }, ...rows.slice(dialog.scroll, end),
    { text: rows.length > capacity ? `↑↓ Scroll  ·  ${dialog.scroll + 1}–${end} of ${rows.length}` : '', tone: '2' }];
}

function available(project, action) {
  if (!project) return false;
  if (action === 'freeze') return project.processCount > 0 && project.state !== 'frozen';
  if (action === 'resume') return ['frozen', 'partial'].includes(project.state);
  if (action === 'sleep') return project.restart?.configured && !['sleeping', 'frozen', 'exited'].includes(project.state);
  if (action === 'kill') return project.state !== 'discovered' && project.processCount > 0 &&
    !project.containers?.length && !project.systemd?.length && !project.supervisors?.length;
  if (action === 'wake') return project.restart?.configured && ['sleeping', 'exited', 'partial'].includes(project.state) && project.processCount === 0;
  if (action === 'checkpoint') return project.state !== 'discovered' && project.processCount > 0;
  if (action === 'restore') return project.state !== 'discovered' && project.processCount === 0;
  return project.state !== 'discovered';
}

export async function interactive() {
  const input = process.stdin;
  const output = process.stdout;
  const colors = !Object.hasOwn(process.env, 'NO_COLOR');
  const style = (code, text) => colors ? `${esc}${code}m${text}${esc}0m` : text;
  const selected = new Set();
  const scope = new AbortController();
  const wasRaw = input.isRaw;
  const width = () => Math.max(1, (output.columns || 80) - 1);
  const height = () => Math.max(3, output.rows || 24);
  let tab = 0;
  let projects = [];
  let listeners = [];
  let services = { rows: [], unavailable: [] };
  let history = [];
  let viewKey;
  let viewIndex = 0;
  let search = '';
  let filter = 0;
  let sort = 0;
  let status = 'Scanning local projects…';
  let detail, dialog, operation, refreshPending, timer;
  let scanning = false;
  let handling = false;
  let lastFrame = [];
  let ended = false;
  let close;
  const done = new Promise(resolveClose => { close = resolveClose; });
  const titles = ['Projects', 'Ports', 'Services', 'History'];

  function entries() {
    const query = search.toLowerCase();
    if (tab === 0) return projects.filter(project =>
      (filter === 0 || project.state === filters[filter] || (filter === 1 && project.processCount > 0 && project.state !== 'frozen')) &&
      `${project.name} ${project.state} ${project.cwd} ${ports(project.ports)} ${project.processes.map(row => row.pid).join(' ')}`.toLowerCase().includes(query)
    ).sort((a, b) => ((sort === 0 && Number(b.processCount > 0) - Number(a.processCount > 0)) ||
      (sort === 2 && b.ports.length - a.ports.length) || (sort === 3 && (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)) || a.name.localeCompare(b.name)))
      .map(project => ({ id: project.id, project }));
    if (tab === 1) return listeners.filter(row => `${row.protocol} ${endpoint(row)} ${row.pid ?? ''} ${row.name ?? ''} ${row.image ?? ''}`.toLowerCase().includes(query))
      .map(row => ({ id: `${row.protocol}/${endpoint(row)}/${row.pid}`, listener: row }));
    if (tab === 2) return services.rows.filter(row => `${row.name} ${row.manager} ${row.pid ?? ''} ${row.description ?? ''}`.toLowerCase().includes(query))
      .map(row => ({ id: `${row.manager}/${row.name}`, service: row }));
    return history.filter(row => `${row.action} ${row.status} ${row.id}`.includes(query)).map(row => ({ id: row.id, op: row }));
  }

  function focused(rows) {
    const existing = rows.findIndex(row => row.id === viewKey);
    viewIndex = existing >= 0 ? existing : clamp(viewIndex, 0, rows.length - 1);
    viewKey = rows[viewIndex]?.id;
    return rows[viewIndex];
  }

  function listLines(span, budget) {
    const rows = entries();
    focused(rows);
    const subheading = tab === 0 ? `${projects.filter(row => row.processCount > 0).length} active  /  ${projects.length} projects  /  ${selected.size} selected` :
      tab === 1 ? `${listeners.length} local TCP/UDP endpoints  /  Read-only` : tab === 2 ?
        `${services.rows.length} running services  /  Read-only${services.unavailable.length ? `  /  Unavailable: ${services.unavailable.join(', ')}` : ''}` :
        `${history.length} recent operations`;
    const lines = [{ text: `${subheading}    ${search ? `Search: ${search}` : tab === 0 ? `Filter: ${filters[filter]}  Sort: ${sorts[sort]}` : ''}`, tone: '2' }];
    const nameSize = clamp(Math.floor(span * 0.37), 12, 36);
    if (span >= 60) lines.push({ text: tab === 0 ? `    ${fit('PROJECT', nameSize)} ${fit('STATE', 18)} ${fit('PROCS', 6)} TCP` :
      tab === 1 ? '  PROTOCOL / LOCAL ENDPOINT            PID       PROJECT / PROCESS' : tab === 2 ?
        `  ${fit('SERVICE', nameSize)} ${fit('MANAGER', 24)} PID` : '  ACTION          STATUS         OPERATION', tone: '36' });
    if (!rows.length) return [...lines, { text: scanning ? '  Scanning…' : '  No matching entries.' }];
    const count = Math.max(1, budget - lines.length);
    const offset = clamp(viewIndex - count + 1, 0, rows.length - count);
    for (const [index, row] of rows.slice(offset, offset + count).entries()) {
      const marked = index + offset === viewIndex;
      const pointer = marked ? '› ' : '  ';
      let text;
      if (row.project) {
        const p = row.project;
        const choice = selected.has(p.id) ? '● ' : '  ';
        text = span >= 60 ? `${choice}${fit(p.name, nameSize)} ${fit(p.state, 18)} ${fit(p.processCount, 6)} ${ports(p.ports) || '—'}` :
          `${choice}${fit(p.name, Math.max(5, Math.min(nameSize, span - p.state.length - 7))).trimEnd()} ${p.state} ${ports(p.ports)}`;
      } else if (row.listener) {
        const p = row.listener;
        const address = `${p.protocol.toUpperCase()} ${endpoint(p)}`;
        text = span >= 60 ? `${fit(address, 38)} ${fit(p.pid ?? '—', 9)} ${p.name ?? basename(p.image ?? 'Unassigned')} (${p.scope})` : `${address}  PID ${p.pid ?? '—'}`;
      } else if (row.service) {
        const s = row.service;
        text = span >= 60 ? `${fit(s.name, nameSize)} ${fit(s.manager, 24)} ${s.pid ?? '—'}` : `${s.name}  ${s.manager}`;
      } else text = `${fit(row.op.action, 15)} ${fit(row.op.status, 14)} ${row.op.id}`;
      lines.push({ text: pointer + text, tone: marked ? '7' : row.project?.state === 'partial' ? '33' : undefined });
    }
    return lines;
  }

  function projectPanel(project) {
    const rows = project.processes;
    const children = new Map();
    for (const row of rows) {
      if (!children.has(row.parent)) children.set(row.parent, []);
      children.get(row.parent).push(row);
    }
    const branches = [];
    const visited = new Set();
    function branch(row, indent) {
      if (visited.has(row.pid)) return;
      visited.add(row.pid);
      branches.push(`${'  '.repeat(Math.min(indent, 4))}PID ${row.pid}  ${basename(row.image ?? '')}  ${ports(row.ports) ? `TCP ${ports(row.ports)}` : ''}`);
      for (const child of children.get(row.pid) ?? []) branch(child, indent + 1);
    }
    const pids = new Set(rows.map(row => row.pid));
    rows.filter(row => !pids.has(row.parent)).forEach(row => branch(row, 0));
    rows.forEach(row => branch(row, 0));
    const actionGuide = Object.entries(shortcuts).filter(([, action]) => available(project, action))
      .map(([key, action]) => `${key} ${mutations[action][0]}`);
    if (project.candidates?.length) actionGuide.unshift('a Review ownership');
    return [`${project.name}  [${project.state}]`, project.cwd, '',
      `TCP listeners: ${project.ports.map(endpoint).join(', ') || 'none'}`,
      `${project.processCount} processes   CPU ${project.cpuPercent?.toFixed(1) ?? '—'}%   RSS ${project.rssSum === undefined ? '—' : `${(project.rssSum / 2 ** 20).toFixed(1)} MiB`}`,
      `Restart recipe: ${project.restart?.configured ? 'saved' : 'unavailable'}   Candidates: ${project.candidates?.length ?? 0}`, '',
      actionGuide.join('   '), '', ...branches];
  }

  function panelLines(budget) {
    if (dialog?.kind === 'help') return helpPanel(width(), budget, dialog);
    const lines = dialog?.kind === 'input' ? [dialog.title, '', `› ${glyphs(dialog.text).slice(-Math.max(1, Math.floor((width() - 3) / 2))).join('')}`, '', 'Enter Apply   Esc Cancel'] :
      dialog?.kind === 'confirm' ? [dialog.title, '', ...dialog.lines] :
      dialog?.kind === 'adopt' ? ['Review ownership', 'Space toggles a process. Enter continues.', '',
        ...dialog.rows.map(row => `${dialog.approved.has(processKey(row)) ? '[x]' : '[ ]'} PID ${row.pid}  ${basename(row.image ?? '')}  TCP ${ports(row.ports) || '—'}`)] :
      detail?.project ? projectPanel(detail.project) : detail?.listener ? [`${detail.listener.protocol.toUpperCase()} ${endpoint(detail.listener)}`, '', `PID ${detail.listener.pid ?? 'unknown'}`, detail.listener.image ?? '',
        `Project: ${detail.listener.name ?? 'Unassigned'}`, `Scope: ${detail.listener.scope}`, '', ...(detail.listener.project ? ['Enter Open project'] : [])] :
      detail?.service ? [detail.service.name, detail.service.description ?? '', '', detail.service.manager, `PID ${detail.service.pid ?? 'unknown'}`, 'Read-only'] :
      [`${detail?.op.action}  [${detail?.op.status}]`, detail?.op.id, '', ...(detail?.op.outcomes ?? []).map(row => `${row.status}  ${row.target}  ${row.message ?? ''}`)];
    const panel = dialog ?? detail;
    const choice = dialog?.kind === 'adopt' ? dialog.index + 3 : undefined;
    const confirm = dialog?.kind === 'confirm';
    const cap = Math.max(1, budget - (confirm ? 1 : 0));
    panel.scroll = clamp(choice === undefined ? panel.scroll ?? 0 : Math.max(panel.scroll ?? 0, choice - cap + 1), 0, lines.length - cap);
    if (choice !== undefined && choice < panel.scroll) panel.scroll = choice;
    const visible = lines.slice(panel.scroll, panel.scroll + cap).map((line, index) => ({ text: line,
      tone: index + panel.scroll === choice ? '7' : index + panel.scroll === 0 ? '1;36' : undefined }));
    if (confirm) visible.push({ text: 'Enter Confirm   Esc Cancel', tone: '1;36' });
    return visible;
  }

  function draw() {
    if (ended) return;
    const span = width();
    const rows = height();
    const tabs = titles.map((title, index) => index === tab ? `[${title}]` : title).join('   ');
    const budget = Math.max(1, rows - 5);
    const body = dialog || detail ? panelLines(budget) : listLines(span, budget);
    const heading = [{ text: ' ProjectFreeze ', tone: '1;36' }, { text: tabs, tone: '1' }];
    const result = operation ? `${operation.action}  ${operation.status ?? 'starting'}  ${operation.outcomes?.length ?? 0} result(s)  ${operation.pending ?? ''}` : status;
    const controls = dialog?.kind === 'help' ? 'Esc Back   ? Close help' : operation ? 'x Cancel operation   q Detach' : dialog ? 'Esc Cancel   q Quit' : detail ?
      '↑↓ Scroll   Esc Back   Tab View   ? Help   q Quit' : 'Tab View   ↑↓ Move   Enter Inspect   / Search   l Launch   ? Help   q Quit';
    const frame = [...heading, ...body.slice(0, budget)];
    while (frame.length < rows - 2) frame.push({ text: '' });
    frame.push({ text: result, tone: operation ? '33' : '2' }, { text: controls, tone: '36' });
    const next = frame.slice(0, rows).map(line => style(line.tone ?? '0', fit(line.text, span)));
    let changes = '';
    for (const [index, line] of next.entries()) if (line !== lastFrame[index]) changes += `${esc}${index + 1};1H${line}${esc}K`;
    lastFrame = next;
    if (changes) output.write(changes);
  }

  async function refresh() {
    if (scanning) { refreshPending = true; return; }
    if (ended) return;
    scanning = true;
    let refreshed = false;
    const screen = tab;
    const inspected = detail?.project?.id;
    try {
      if (inspected && detail?.project?.id === inspected) {
        const current = await request('inspect', { id: inspected });
        if (detail?.project?.id === inspected) detail.project = current;
        projects = projects.map(row => row.id === inspected ? current : row);
      } else if (screen === 1) listeners = await request('ports');
      else if (screen === 2) services = await request('services');
      else if (screen === 3) history = await request('history');
      else projects = await request('list');
      refreshed = true;
    } catch (error) { status = problem(error).message; }
    finally {
      scanning = false;
      if (refreshed && status.startsWith('Scanning')) status = '';
      draw();
      if (refreshPending && !ended) { refreshPending = false; void refresh(); }
    }
  }

  function switchTab(index) {
    tab = (index + titles.length) % titles.length;
    detail = undefined;
    search = '';
    viewKey = undefined;
    viewIndex = 0;
    void refresh();
  }

  async function act(action, args) {
    if (operation || ended) return false;
    operation = { action };
    draw();
    try {
      const started = await request(action, args);
      operation = { ...started, action };
      const result = await waitOperation(started.id, item => { operation = item; draw(); }, scope.signal);
      status = `${mutations[action]?.[0] ?? action} ${result.status}${result.outcomes.filter(row => row.status === 'failed').map(row => `  ${row.message}`).join('')}`;
      return result.status === 'complete';
    } catch (error) { status = problem(error).message; return false; }
    finally { operation = undefined; void refresh(); }
  }

  function confirm(title, lines, run) { dialog = { kind: 'confirm', title, lines, run, scroll: 0 }; }
  function edit(title, text, apply) { dialog = { kind: 'input', title, text, apply }; }
  function inspectProject(id) {
    const project = projects.find(row => row.id === id);
    if (!project) { status = 'This project is no longer visible. Refresh and try again.'; return; }
    detail = { project, scroll: 0 };
    void refresh();
  }

  function review(action, targets, args = {}) {
    if (operation || !targets.length) return;
    const blocked = targets.find(project => !available(project, action));
    if (blocked) { status = `${mutations[action][0]} is unavailable for ${blocked.name} (${blocked.state}).`; return; }
    const display = mutations[action];
    confirm(`${display[0]} ${targets.length === 1 ? targets[0].name : `${targets.length} projects`}`,
      [display[1], '',
        ...targets.map(p => `${p.name}  ${p.processCount} process(es)  TCP ${ports(p.ports) || '—'}`)],
      () => act(action, { ids: targets.map(p => p.id), ...args }));
  }

  async function reviewKill(targets) {
    if (targets.length !== 1) {
      status = 'Select one project to force terminate.';
      return;
    }
    const project = await request('inspect', { id: targets[0].id });
    if (ended) return;
    if (!available(project, 'kill')) {
      status = 'Force termination requires an owned native project with processes and no registered services.';
      return;
    }
    const members = project.processes.map(identity);
    confirm(`Force terminate ${project.name}?`, [mutations.kill[1], project.cwd, '',
      ...project.processes.map(row => `PID ${row.pid}  ${basename(row.image ?? '')}  TCP ${ports(row.ports) || '—'}`)], () => {
      edit('Type KILL to confirm force termination', '', async text => {
        if (text !== 'KILL') { status = 'Force termination cancelled.'; return; }
        await act('kill', { ids: [project.id], confirm: true, members });
      });
    });
  }

  async function adopt(project, after) {
    const live = await request('inspect', { id: project.id });
    if (ended) return;
    detail = { project: live, scroll: 0 };
    if (!live.candidates.length) { status = 'No current candidates to review.'; return; }
    dialog = { kind: 'adopt', rows: live.candidates, approved: new Set(), index: 0, scroll: 0, project: live, after };
  }

  async function finishAdoption(panel, recipe) {
    const members = panel.rows.filter(row => panel.approved.has(processKey(row)));
    confirm(`Adopt ${members.length} reviewed process(es)`, members.map(row => `PID ${row.pid}  TCP ${ports(row.ports) || '—'}  ${row.image ?? ''}`), async () => {
      const adopted = await act('adopt', { cwd: panel.project.cwd, confirm: true, members: members.map(identity), recipe });
      if (adopted && panel.after && !ended) {
        projects = await request('list');
        await panel.after();
      }
    });
  }

  async function freeze(ids) {
    const targets = ids.map(id => projects.find(row => row.id === id)).filter(Boolean);
    const observed = targets.find(project => project.state === 'discovered');
    if (!observed) { review('freeze', targets); return; }
    await adopt(observed, () => freeze(ids));
  }

  async function loadRecipe(path) {
    const recipe = JSON.parse(await readFile(resolve(path.replace(/^"(.*)"$/, '$1')), 'utf8'));
    recipe.cwd = resolve(recipe.cwd ?? '.');
    return recipe;
  }

  function quit() {
    if (ended) return;
    ended = true;
    scope.abort();
    close();
  }

  async function handle(str, key) {
    const name = key?.name;
    if (key?.ctrl && name === 'c') { quit(); return; }
    if (dialog?.kind === 'input') {
      if (name === 'escape') dialog = undefined;
      else if (name === 'return') { const { text, apply } = dialog; dialog = undefined; await apply(text.trim()); }
      else if (name === 'backspace') dialog.text = glyphs(dialog.text).slice(0, -1).join('');
      else if (key?.ctrl && name === 'u') dialog.text = '';
      else if (str && !key?.ctrl && !key?.meta && !/[\p{Cc}]/u.test(str)) dialog.text = (dialog.text + str).slice(0, 4096);
      return;
    }
    if (name === 'q') { quit(); return; }
    if (name === 'escape') {
      if (dialog) dialog = undefined;
      else if (detail) { detail = undefined; void refresh(); }
      else if (search) search = '';
      else if (tab !== 0) switchTab(0);
      return;
    }
    const movement = ({ up: -1, down: 1, pageup: -Math.max(1, height() - 7), pagedown: Math.max(1, height() - 7) })[name];
    if (dialog?.kind === 'adopt') {
      if (movement) dialog.index = clamp(dialog.index + movement, 0, dialog.rows.length - 1);
      if (name === 'space') {
        const id = processKey(dialog.rows[dialog.index]);
        if (dialog.approved.has(id)) dialog.approved.delete(id); else dialog.approved.add(id);
      }
      if (name === 'return' && dialog.approved.size) {
        const panel = dialog;
        edit('Restart recipe path (optional)', '', async path => finishAdoption(panel, path ? await loadRecipe(path) : undefined));
      }
      return;
    }
    if (dialog) {
      if (dialog.kind === 'help') {
        if (str === '?') { dialog = undefined; return; }
        if (name === 'home' || name === 'end') dialog.scroll = name === 'home' ? 0 : Infinity;
      }
      if (movement) dialog.scroll = Math.max(0, (dialog.scroll ?? 0) + movement);
      if (name === 'return' && dialog.kind === 'confirm') { const { run } = dialog; dialog = undefined; await run(); }
      return;
    }
    if (str === '?') { dialog = { kind: 'help', scroll: 0 }; return; }
    if (name === 'x' && operation?.id) { await request('cancel', { id: operation.id }); return; }
    if (name === 'r') { void refresh(); return; }
    if (name === 'tab') { switchTab(tab + (key.shift ? -1 : 1)); return; }
    if (name === 'p') { switchTab(1); return; }
    if (name === 'v') { switchTab(2); return; }
    if (name === 'h') { switchTab(3); return; }
    if (str === '/') { edit(`Search ${titles[tab].toLowerCase()}`, search, text => { search = text; detail = undefined; viewKey = undefined; viewIndex = 0; }); return; }
    if (name === 'l' && !operation) {
      edit('Path to JSON launch recipe', '', async path => {
        if (!path) return;
        const recipe = await loadRecipe(path);
        confirm('Launch reviewed recipe', [recipe.cwd, `Executable: ${recipe.argv?.[0] ?? '(missing)'}`, `Readiness: ${recipe.ready ? endpoint(recipe.ready) : 'none configured'}`],
          () => act('run', { recipe }));
      });
      return;
    }
    if (detail) {
      if (movement) detail.scroll = Math.max(0, detail.scroll + movement);
      if (name === 'return' && detail.listener?.project) inspectProject(detail.listener.project);
    } else {
      if (name === 'left' || name === 'right') { switchTab(tab + (name === 'left' ? -1 : 1)); return; }
      if (name === 's' && tab === 0) { sort = (sort + 1) % sorts.length; return; }
      if (name === 't' && tab === 0) { filter = (filter + 1) % filters.length; return; }
      const rows = entries();
      const row = focused(rows);
      if (movement || name === 'home' || name === 'end') {
        viewIndex = clamp(name === 'home' ? 0 : name === 'end' ? rows.length - 1 : viewIndex + movement, 0, rows.length - 1);
        viewKey = rows[viewIndex]?.id;
        return;
      }
      if (name === 'return' && row) {
        if (row.project) inspectProject(row.id);
        else detail = { ...row, scroll: 0 };
        return;
      }
      if (name === 'space' && row?.project) {
        if (selected.has(row.id)) selected.delete(row.id); else selected.add(row.id);
        return;
      }
    }
    if (operation) return;
    const project = detail?.project ?? (!detail && tab === 0 ? focused(entries())?.project : undefined);
    if (!project) return;
    if (name === 'a') { await adopt(project); return; }
    const action = shortcuts[name];
    if (!action) return;
    const targets = !detail && selected.size ? projects.filter(row => selected.has(row.id)) : [project];
    if (!targets.length) { status = 'The selected projects are no longer visible.'; return; }
    if (action === 'freeze') { await freeze(targets.map(row => row.id)); return; }
    if (action === 'kill') { await reviewKill(targets); return; }
    if (action === 'restore') { edit('Checkpoint ID', '', checkpoint => { if (checkpoint) review(action, targets, { checkpoint }); }); return; }
    review(action, targets);
  }

  function keypress(str, key) {
    if (ended) return;
    if (handling && !(key?.ctrl && key.name === 'c') && !(operation && ['x', 'q'].includes(key?.name))) return;
    const locked = !handling && (key?.name === 'return' || key?.name === 'x' ||
      (!dialog && ['a', 'f', 'k'].includes(key?.name)));
    if (locked) handling = true;
    void handle(str, key).catch(error => { status = problem(error).message; }).finally(() => {
      if (locked) handling = false;
      draw();
    });
  }
  function resize() { lastFrame = []; output.write(`${esc}2J`); draw(); }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.on('keypress', keypress);
  input.once('end', quit);
  output.on('resize', resize);
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  try {
    output.write(`${esc}?1049h${esc}?25l${esc}2J`);
    input.resume();
    timer = setInterval(() => void refresh(), 2500);
    draw();
    void refresh();
    await done;
  } finally {
    clearInterval(timer);
    input.off('keypress', keypress);
    input.off('end', quit);
    input.setRawMode(wasRaw);
    input.pause();
    output.off('resize', resize);
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    output.write(`${esc}0m${esc}?25h${esc}?1049l${operation?.id ? `Operation ${operation.id} continues in the daemon.\n` : ''}`);
  }
}
