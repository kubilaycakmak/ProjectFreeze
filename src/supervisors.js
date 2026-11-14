import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Fault } from './errors.js';
import { command, control, matches, scan, windows } from './platform.js';

const mac = process.platform === 'darwin';
const launchLabel = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const taskPath = /^\\(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\\)*[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const ps = windows ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
const script = fileURLToPath(new URL('./windows-supervisors.ps1', import.meta.url));
const ctl = (args, timeout) => command('/bin/launchctl', args, { timeout });
const digest = value => createHash('sha256').update(value).digest('hex');
const id = item => `${item.kind}:${windows ? item.name.toLowerCase() : item.name}`;

export function supervisorPolicies(value) {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => !item || typeof item.name !== 'string' ||
    typeof item.shared !== 'boolean' || !(
      (mac && item.kind === 'launchd' && launchLabel.test(item.name) && typeof item.plist === 'string' && isAbsolute(item.plist) && !/[\r\n\0]/.test(item.plist)) ||
      (windows && item.kind === 'scm' && launchLabel.test(item.name)) || (windows && item.kind === 'task' && taskPath.test(item.name))
    )) || new Set(value.map(id)).size !== value.length) throw new Fault('USAGE', 'Supply exact supervisor identities and explicit sharing for this platform.');
  return value.map(({ kind, name, shared, plist }) => ({ kind, name, shared, ...(kind === 'launchd' ? { plist } : {}) }));
}

async function projectFile(cwd, path, allowOutside = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Fault('DENIED', 'The supervisor must use an absolute executable or definition path.');
  const real = await realpath(path).catch(() => '');
  const rel = relative(cwd, real);
  if (!real || (!allowOutside && (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))) {
    throw new Fault('DENIED', 'The supervisor definition or executable must be inside the project directory.');
  }
  const info = await lstat(real);
  if (!info.isFile() || (!windows && (info.uid !== process.getuid() || (info.mode & 0o022)))) {
    throw new Fault('DENIED', 'The supervisor definition must be an owner-controlled regular file.');
  }
  return real;
}

function property(output, name) {
  return output.split('\n').map(line => line.match(new RegExp(`^\\s*${name} = (.+)$`))).find(Boolean)?.[1]?.trim();
}

async function launchdProbe(item, project) {
  const plist = await projectFile(project.cwd, item.plist);
  const json = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist]));
  const executable = json.Program ?? json.ProgramArguments?.[0];
  if (json.Label !== item.name || typeof executable !== 'string' || !isAbsolute(executable) ||
      await realpath(json.WorkingDirectory ?? '/').catch(() => '') !== project.cwd ||
      ['UserName', 'GroupName', 'RootDirectory', 'Sockets', 'MachServices', 'WatchPaths', 'QueueDirectories', 'StartInterval',
        'StartCalendarInterval', 'LaunchEvents', 'KeepAlive'].some(name => Object.hasOwn(json, name) && json[name] !== false)) {
    throw new Fault('DENIED', 'Use a project-owned, single-process LaunchAgent with a matching working directory and no auto-activation.');
  }
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${item.name}`;
  const output = await ctl(['print', service], 5000);
  const actual = property(output, 'path');
  if (!actual || await realpath(actual).catch(() => '') !== plist || property(output, 'program') !== executable) {
    throw new Fault('DENIED', 'The loaded LaunchAgent path and executable must match the reviewed definition.');
  }
  return { fingerprint: digest(await readFile(plist)), service, pid: Number(property(output, 'pid') ?? 0), executable };
}

async function windowsProbe(item, action = 'probe', fingerprint = '-') {
  try {
    return JSON.parse(await command(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, item.kind, item.name, action, fingerprint]));
  } catch (error) {
    if (error.details?.exit === 7) throw new Fault('PARTIAL', `The Windows supervisor did not complete ${action}. Inspect the exact configured service or task.`);
    throw error;
  }
}

async function probe(item, project) {
  if (item.kind === 'launchd') return launchdProbe(item, project);
  const state = await windowsProbe(item);
  if (state.path.toLowerCase() !== item.name.toLowerCase()) throw new Fault('DENIED', 'The Windows supervisor returned a different identity.');
  await projectFile(project.cwd, state.executable);
  if (item.kind === 'task' && await realpath(state.cwd).catch(() => '') !== project.cwd) {
    throw new Fault('DENIED', 'The scheduled task must use the registered project working directory.');
  }
  return state;
}

export async function supervisorTargets(project, all, enroll = false) {
  const result = [];
  for (const item of project.recipe?.supervisors ?? []) {
    const key = id(item);
    const shared = item.shared || all.some(other => other.id !== project.id && other.recipe?.supervisors?.some(s => id(s) === key));
    if (shared) { result.push({ ...item, key, shared }); continue; }
    const observed = await probe(item, project);
    project.supervisorPins ??= {};
    if (enroll && !project.supervisorPins[key]) project.supervisorPins[key] = observed.fingerprint;
    if (project.supervisorPins[key] !== observed.fingerprint) throw new Fault('DENIED', `The reviewed definition of ${item.name} changed.`);
    result.push({ ...item, ...observed, key, shared: false });
  }
  return result;
}

async function launchdProcess(target, rows) {
  if (!target.pid) return undefined;
  const process = rows.find(row => row.pid === target.pid);
  const executable = await realpath(target.executable).catch(() => '');
  if (!process?.image || await realpath(process.image).catch(() => '') !== executable || rows.some(row => row.parent === target.pid)) {
    throw new Fault('UNSUPPORTED', 'LaunchAgent control requires one observable process with the reviewed executable and no live children.');
  }
  return process;
}

export async function observeSupervisors(project, all, rows) {
  const targets = await supervisorTargets(project, all);
  for (const target of targets.filter(t => !t.shared)) {
    if (target.kind === 'launchd') {
      target.process = await launchdProcess(target, rows);
      target.state = target.process?.state === 'T' ? 'Paused' : target.process ? 'Running' : 'Stopped';
    }
  }
  return targets;
}

export async function supervisorAction(action, target, project) {
  const before = await probe(target, project);
  if (target.shared || before.fingerprint !== target.fingerprint) throw new Fault('DENIED', 'Supervisor scope changed before control.');
  const timeout = project.recipe?.timeout ?? 10000;
  if (target.kind === 'launchd') {
    if (action === 'start') {
      if (!before.pid) await ctl(['kickstart', before.service], timeout);
    } else {
      const process = await launchdProcess(before, await scan(false));
      if (!process || !matches(process, target.process)) throw new Fault('DENIED', 'The LaunchAgent process was replaced or could not be verified.');
      await control(({ pause: 'freeze', resume: 'resume', stop: 'stop' })[action], process);
    }
  } else {
    if (target.kind === 'scm' && ((action === 'pause' && !before.canPause) || (action === 'stop' && !before.canStop))) {
      throw new Fault('UNSUPPORTED', 'The Windows service did not advertise this control.');
    }
    await windowsProbe(target, action, target.fingerprint);
  }
  const deadline = Date.now() + timeout;
  do {
    const [current] = await observeSupervisors({ ...project, recipe: { ...project.recipe, supervisors: [target] } }, [], await scan(false));
    if (action === 'enable' ? current.enabled : action === 'disable' ? !current.enabled && !current.active :
        current.state === ({ pause: 'Paused', resume: 'Running', start: 'Running', stop: 'Stopped' })[action] &&
          (!['pause','resume'].includes(action) || current.pid === before.pid)) return;
    await delay(125);
  } while (Date.now() < deadline);
  throw new Fault('PARTIAL', 'The supervisor did not reach the requested state before the deadline.');
}
