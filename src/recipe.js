import { readFile, realpath, mkdir, statfs } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { Fault } from './errors.js';
import { directory } from './discovery.js';
import { linux } from './platform.js';
import { validSystemd } from './systemd.js';

const envName = /^[A-Za-z_][A-Za-z_0-9]*$/;
const projectName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const platformEnv = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']);
const argv = (values) => Array.isArray(values) && values.length > 0 && values.length <= 128 &&
  values.every(s => typeof s === 'string' && !s.includes('\0') && s.length <= 16384) && Boolean(values[0]);

export async function recipe(input) {
  if (!input || !argv(input.argv)) throw new Fault('USAGE', 'Supply an executable and literal arguments.');
  if (input.stop !== undefined && !argv(input.stop)) throw new Fault('USAGE', 'The shutdown command must be an argument array.');
  const cwd = await directory(input.cwd ?? '.');
  const { env = [], dependencies = [], timeout = 10000, restart = 'never', ready, stop, cgroup, containers = [], systemd = [] } = input;
  if (!Array.isArray(env) || !env.every(s => typeof s === 'string' && envName.test(s) && !s.startsWith('PROJECTFREEZE_'))) {
    throw new Fault('USAGE', 'Environment references must be variable names.');
  }
  if (!Array.isArray(dependencies) || !dependencies.every(s => typeof s === 'string' && /^p-[a-f0-9]{16}$/.test(s))) {
    throw new Fault('USAGE', 'Dependencies must be registered project IDs.');
  }
  if (!Array.isArray(containers) || containers.length > 24 || !containers.every(c => c && typeof c.project === 'string' && typeof c.service === 'string' &&
      projectName.test(c.project) && projectName.test(c.service) && typeof c.shared === 'boolean') ||
      new Set(containers.map(c => `${c.project}/${c.service}`)).size !== containers.length) {
    throw new Fault('USAGE', 'Containers require a Compose project, service, and explicit shared policy.');
  }
  if (!validSystemd(systemd) || (!linux && systemd.length)) throw new Fault('USAGE', 'Configure exact Linux user systemd unit names and explicit shared policies.');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000 || !['never', 'on-failure'].includes(restart)) {
    throw new Fault('USAGE', 'Choose a shutdown timeout from 100 to 120000 ms and restart never or on-failure.');
  }
  if (ready && (!['127.0.0.1', '::1'].includes(ready.address) || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535)) {
    throw new Fault('USAGE', 'Readiness requires a loopback TCP address and port.');
  }
  if (cgroup !== undefined && (!linux || typeof cgroup !== 'string' || !isAbsolute(cgroup))) {
    throw new Fault('USAGE', 'A cgroup requires an absolute, delegated cgroup v2 directory on Linux.');
  }
  return { argv: input.argv, cwd, env: [...new Set(env)], dependencies: [...new Set(dependencies)], timeout, restart, ready, stop, cgroup, containers, systemd };
}

export function launchEnv(recipe, available) {
  const entries = Object.entries(available).filter(([name]) => platformEnv.has(name.toUpperCase()));
  const env = Object.fromEntries(entries);
  for (const name of recipe.env) {
    if (!Object.hasOwn(available, name)) throw new Fault('UNAVAILABLE', `Required environment reference is missing: ${name}.`);
    env[name] = available[name];
  }
  return env;
}

export async function prepareCgroup(parent, id) {
  if (!parent) return undefined;
  try {
    const canonical = await realpath(parent);
    if ((await statfs(canonical)).type !== 0x63677270) throw new Error();
    const child = join(canonical, id);
    await mkdir(child);
    if ((await readFile(join(child, 'cgroup.procs'), 'utf8')).trim()) throw new Error();
    return child;
  } catch { throw new Fault('DENIED', 'Could not create an empty dedicated cgroup in the delegated cgroup v2 directory.'); }
}

export function bindAddress(value, publicListener) {
  if (!isIP(value) || (!publicListener && !['127.0.0.1', '::1'].includes(value))) {
    throw new Fault('USAGE', 'Set a literal IP. A non-loopback workload listener requires explicit public opt-in.');
  }
  return value;
}
