import { lstat, realpath, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { Fault } from './errors.js';
import { command, linux } from './platform.js';

const unitName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(service|timer)$/;
const keys = ['Id', 'LoadState', 'ActiveState', 'FreezerState', 'FragmentPath', 'DropInPaths', 'WorkingDirectory',
  'ControlGroup', 'TriggeredBy', 'Triggers', 'RequiredBy', 'WantedBy', 'BoundBy', 'PartOf', 'ConsistsOf',
  'Restart', 'SendSIGKILL', 'RefuseManualStop', 'RefuseManualStart', 'KillMode'];

export function validSystemd(policy) {
  return Array.isArray(policy) && policy.length <= 24 && policy.every(item => item && typeof item.unit === 'string' &&
    unitName.test(item.unit) && typeof item.shared === 'boolean') && new Set(policy.map(item => item.unit)).size === policy.length;
}

const systemctl = (args, options = {}) => {
  if (!linux) throw new Fault('UNSUPPORTED', 'User systemd units require a Linux systemd user manager.');
  return command('/usr/bin/systemctl', ['--user', '--no-pager', '--no-ask-password', ...args], options).catch(error => {
    throw new Fault(error.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'PARTIAL', 'The user systemd manager did not complete its command. Inspect unit status locally.');
  });
};

function below(parent, path) {
  const rel = relative(parent, path);
  return Boolean(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function approvedFile(path, cwd) {
  try {
    const actual = await realpath(path);
    const file = await lstat(actual);
    return below(cwd, actual) && file.isFile() && file.uid === process.getuid() && (file.mode & 0o022) === 0;
  } catch { return false; }
}

export async function unitState(unit) {
  if (!unitName.test(unit)) throw new Fault('USAGE', 'Use an exact systemd user service or timer name.');
  const output = await systemctl(['show', ...keys.flatMap(key => ['-p', key]), '--', unit]);
  const state = Object.fromEntries(output.trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (state.Id !== unit || state.LoadState !== 'loaded') throw new Fault('NOT_FOUND', `The exact user unit ${unit} is not loaded.`);
  return state;
}

export async function serviceTargets(project, projects) {
  const policies = project.recipe?.systemd ?? [];
  if (!policies.length) return [];
  const output = [];
  for (const policy of policies) {
    const shared = policy.shared || projects.some(other => other.id !== project.id && other.recipe?.systemd?.some(s => s.unit === policy.unit));
    if (shared) { output.push({ ...policy, shared }); continue; }
    const state = await unitState(policy.unit);
    const timer = policy.unit.endsWith('.timer');
    if (!await approvedFile(state.FragmentPath, project.cwd) || state.DropInPaths ||
        (!timer && await realpath(state.WorkingDirectory).catch(() => '') !== project.cwd)) {
      throw new Fault('DENIED', `The linked unit ${policy.unit} must use a user-owned fragment inside the project, with no drop-ins.`);
    }
    if (state.RefuseManualStop === 'yes' || state.RefuseManualStart === 'yes' ||
        (!timer && (state.SendSIGKILL !== 'no' || !['control-group', 'mixed'].includes(state.KillMode)))) {
      throw new Fault('UNSUPPORTED', `The unit ${policy.unit} needs manual start and stop, KillMode=control-group or mixed, and SendSIGKILL=no.`);
    }
    const linked = [state.TriggeredBy, state.Triggers, state.RequiredBy, state.BoundBy, state.PartOf, state.ConsistsOf]
      .join(' ').trim().split(/\s+/).filter(Boolean);
    if (linked.some(name => !policies.some(item => item.unit === name && !item.shared) ||
        projects.some(other => other.id !== project.id && other.recipe?.systemd?.some(item => item.unit === name)))) {
      throw new Fault('DENIED', `The unit ${policy.unit} has activation or lifecycle dependencies outside the exclusive reviewed scope.`);
    }
    const fragment = await realpath(state.FragmentPath);
    const info = await lstat(fragment);
    output.push({ ...policy, state, timer, definition: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` });
  }
  return output;
}

export async function serviceAction(action, target, timeout) {
  if (!['freeze', 'thaw', 'stop', 'start'].includes(action) || target.shared) throw new Fault('DENIED', 'The unit is outside the approved action scope.');
  const current = await unitState(target.unit);
  const info = await lstat(await realpath(current.FragmentPath));
  if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` !== target.definition || current.FragmentPath !== target.state.FragmentPath ||
      current.DropInPaths !== target.state.DropInPaths || current.TriggeredBy !== target.state.TriggeredBy ||
      current.Triggers !== target.state.Triggers || current.SendSIGKILL !== target.state.SendSIGKILL) {
    throw new Fault('DENIED', 'Systemd unit definition or activation metadata changed during the operation.');
  }
  if (action === 'freeze' && (!current.ControlGroup || current.ControlGroup === '/' || current.ActiveState !== 'active')) {
    throw new Fault('BUSY', 'The unit no longer has an active dedicated cgroup.');
  }
  const options = ['start', 'stop'].includes(action) ? ['--job-mode=ignore-dependencies'] : [];
  await systemctl([...options, action, '--', target.unit], { timeout });
  const actual = await unitState(target.unit);
  const valid = {
    freeze: actual.FreezerState === 'frozen', thaw: actual.FreezerState === 'running',
    start: actual.ActiveState === 'active', stop: ['inactive', 'failed'].includes(actual.ActiveState) && !actual.ControlGroup
  }[action];
  if (!valid) throw new Fault('PARTIAL', `The unit ${target.unit} did not reach the requested state.`);
}

export async function systemdPids(target) {
  if (!linux || !target.state?.ControlGroup?.startsWith('/')) return [];
  const path = join('/sys/fs/cgroup', target.state.ControlGroup, 'cgroup.procs');
  const values = await readFile(path, 'utf8').catch(() => '');
  return values.trim().split(/\s+/).filter(Boolean).map(Number);
}
