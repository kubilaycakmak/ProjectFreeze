import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Fault, exitCode, problem } from './errors.js';
import { daemon, request, waitOperation } from './ipc.js';

const usage = `ProjectFreeze

  projectfreeze                         Open the interactive terminal
  projectfreeze menu                    Open the numbered, Enter-driven menu
  projectfreeze list | discover | listeners | history
  projectfreeze inspect PROJECT
  projectfreeze adopt --cwd DIR --member PID@BIRTH@BOOT --confirm [--recipe FILE]
  projectfreeze run --cwd DIR -- EXECUTABLE [ARG ...]
  projectfreeze run --recipe FILE
  projectfreeze freeze | resume | sleep | wake PROJECT [PROJECT ...]
  projectfreeze checkpoint PROJECT [--backend criu|docker]
  projectfreeze restore PROJECT --checkpoint ID
  projectfreeze reconcile [PROJECT ...]
  projectfreeze operation ID | cancel ID
  projectfreeze daemon start|status|stop|foreground
  projectfreeze mcp                       Start the local stdio server

Options: --json, --detach, --cwd, --recipe, --member, --exclude, --confirm, --force.
Sleep with --force approves forced shutdown of the reviewed exclusive scope.
Press Ctrl-C to disconnect from a running operation. Use cancel ID to request cancellation.
`;

const mutations = new Set(['adopt', 'run', 'freeze', 'resume', 'sleep', 'wake', 'checkpoint', 'restore', 'reconcile']);
const readActions = new Set(['list', 'discover', 'inspect', 'listeners', 'history', 'operation', 'cancel']);
const opts = {
  json: { type: 'boolean' }, detach: { type: 'boolean' }, force: { type: 'boolean' }, confirm: { type: 'boolean' },
  cwd: { type: 'string' }, recipe: { type: 'string' }, member: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true }, backend: { type: 'string' }, checkpoint: { type: 'string' }, help: { type: 'boolean', short: 'h' }
};

function target(raw) {
  const [pid, birth, boot, extra] = raw.split('@');
  if (extra !== undefined || !pid || !birth || !boot) throw new Fault('USAGE', 'Process identities use PID@BIRTH@BOOT.');
  return { pid: Number(pid), birth, boot };
}

function format(data) {
  if (Array.isArray(data) && data.every(row => row.cwd)) {
    return data.length ? data.map(row => `${row.id}\t${row.state}\t${row.processCount} process(es)\tTCP ${[...new Set(row.ports.map(p => p.port))].join(', ') || 'none'}\t${row.cwd}`).join('\n') : 'No projects in authorized scope.';
  }
  if (data?.outcomes) return [`${data.action} ${data.id} ${data.status}`, ...data.outcomes.map(row =>
    `  ${row.target}  ${row.status}${row.message ? `  ${row.message}` : ''}`)].join('\n');
  return JSON.stringify(data, null, 2);
}

export async function main(args) {
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args : args.slice(0, separator);
  const literal = separator < 0 ? [] : args.slice(separator + 1);
  let json = flags.includes('--json');
  try {
    const { positionals, values } = parseArgs({ args: flags, allowPositionals: true, options: opts });
    json = Boolean(values.json);
    let [action, ...ids] = positionals;
    if (values.help || action === 'help') { process.stdout.write(usage); return; }
    if (action === 'mcp') { await (await import('./mcp.js')).serve(); return; }
    if (action === '_daemon' || (action === 'daemon' && ids[0] === 'foreground')) { await daemon(); return; }
    if (action === 'menu' || (!action && !json && process.stdin.isTTY && process.stdout.isTTY)) {
      if (json || ids.length) throw new Fault('USAGE', 'Run projectfreeze menu without additional arguments.');
      if (action === 'menu' || process.platform === 'win32' || process.env.TERM === 'dumb') await (await import('./line-menu.js')).lineMenu();
      else await (await import('./tui.js')).interactive();
      return;
    }
    action ??= 'list';
    let input = {};
    let auto = true;
    if (action === 'daemon') {
      if (!['start', 'status', 'stop'].includes(ids[0]) || ids.length !== 1) throw new Fault('USAGE', 'Choose daemon start, status, stop, or foreground.');
      action = `daemon-${ids[0]}`;
      auto = false;
    } else if (mutations.has(action)) {
      const cwd = resolve(values.cwd ?? '.');
      let file;
      if (values.recipe) {
        try { file = JSON.parse(await readFile(resolve(values.recipe), 'utf8')); }
        catch { throw new Fault('USAGE', 'The recipe file could not be read as JSON.'); }
      }
      if (action === 'adopt') input = { cwd, recipe: file, confirm: values.confirm, members: values.member?.map(target), exclude: values.exclude?.map(target) };
      else if (action === 'run') input = { recipe: file ? { ...file, cwd: resolve(values.cwd ?? file.cwd ?? '.') } : { cwd, argv: literal } };
      else input = { ids, force: values.force, backend: values.backend, checkpoint: values.checkpoint };
    } else if (readActions.has(action)) {
      if (['inspect', 'operation', 'cancel'].includes(action)) {
        if (ids.length !== 1) throw new Fault('USAGE', 'This command requires one identifier.');
        input = { id: ids[0] };
      } else if (ids.length) throw new Fault('USAGE', 'This command takes no positional arguments.');
    } else throw new Fault('USAGE', 'Unknown command. Run projectfreeze --help.');

    const reply = await request(action, input, auto);
    let result = reply;
    if (mutations.has(action) && !values.detach) {
      if (!json && process.stderr.isTTY) process.stderr.write(`Operation ${reply.id} started.\n`);
      result = await waitOperation(reply.id, op => {
        if (!json && process.stderr.isTTY && op.status === 'running' && op.pending) process.stderr.write(`  ${op.pending}\n`);
      });
    }
    const status = result?.status;
    const fault = result?.outcomes?.find(outcome => outcome.status === 'failed');
    const code = status === 'partial' || status === 'interrupted' ? 'PARTIAL' : status === 'cancelled' ? 'CANCELLED' : status === 'failed' ? fault?.code ?? 'INTERNAL' : null;
    const display = () => action === 'listeners' ? (result.length ? result.map(row =>
      `${row.address.includes(':') ? `[${row.address}]` : row.address}:${row.port}\tPID ${row.pid}\t${row.name ?? row.image ?? 'unassigned'}\t${row.scope}`).join('\n') : 'No TCP listeners observed.') : format(result);
    process.stdout.write(`${json ? JSON.stringify({ schemaVersion: 1, ok: !code, data: result }) : display()}\n`);
    if (code) process.exitCode = exitCode(code);
  } catch (error) {
    const detail = error?.code?.startsWith?.('ERR_PARSE_ARGS') ? { code: 'USAGE', message: 'Invalid command-line arguments. Run projectfreeze --help.' } : problem(error);
    const output = json ? JSON.stringify({ schemaVersion: 1, ok: false, error: detail }) : `${detail.code} ${detail.message}`;
    (json ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = exitCode(detail.code);
  }
}
