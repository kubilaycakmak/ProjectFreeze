import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { Fault } from './errors.js';
import { bootId, command, executable, linux } from './platform.js';

const dockerEnv = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^DOCKER_(HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH|API_VERSION)$/i.test(name)) delete env[name];
  return env;
};

async function docker(args) {
  const env = dockerEnv();
  const cli = await executable('docker', process.cwd(), env);
  const host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  return command(cli, ['--host', host, ...args], { env });
}

export async function composeTargets(project, all) {
  const targets = [];
  for (const service of project.recipe?.containers ?? []) {
    const shared = service.shared || all.some(other => other.id !== project.id && other.recipe?.containers.some(candidate =>
      candidate.project === service.project && candidate.service === service.service));
    if (shared) { targets.push({ ...service, shared }); continue; }
    const output = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${service.project}`,
      '--filter', `label=com.docker.compose.service=${service.service}`]);
    const ids = output.trim().split(/\s+/).filter(id => /^[a-f0-9]{64}$/.test(id));
    if (!ids.length) throw new Fault('NOT_FOUND', `No existing Compose container matches ${service.project}/${service.service}.`);
    for (const id of ids) {
      const container = await inspectDocker(id);
      const labels = container.Config.Labels;
      if (container.Id !== id || labels['com.docker.compose.project'] !== service.project ||
          labels['com.docker.compose.service'] !== service.service || labels['com.docker.compose.oneoff']?.toLowerCase() === 'true') {
        throw new Fault('DENIED', 'Compose container identity did not match the approved policy.');
      }
      const configDir = labels['com.docker.compose.project.working_dir'];
      if (!configDir || configDir !== project.cwd) throw new Fault('DENIED', 'Compose working-directory label differs from the registered project.');
      if (container.HostConfig.RestartPolicy.Name !== 'no' && container.HostConfig.RestartPolicy.Name !== '') {
        throw new Fault('UNSUPPORTED', 'Set the exclusive container restart policy to no before managing it.');
      }
      targets.push({ ...service, id, running: container.State.Running, paused: container.State.Paused });
    }
  }
  return targets;
}

async function inspectDocker(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Fault('USAGE', 'Container identity is invalid.');
  return JSON.parse(await docker(['inspect', '--type', 'container', id]))[0];
}

export async function containerAction(action, id, timeout = 10000) {
  if (!['pause', 'unpause', 'start', 'stop'].includes(action)) throw new Fault('USAGE', 'Unknown container action.');
  await inspectDocker(id);
  await docker([action, ...(action === 'stop' ? ['--timeout', String(Math.ceil(timeout / 1000))] : []), id]);
  const { State: state } = await inspectDocker(id);
  const verified = { pause: state.Running && state.Paused, unpause: state.Running && !state.Paused,
    start: state.Running && !state.Paused, stop: !state.Running }[action];
  if (!verified) throw new Fault('PARTIAL', 'The container did not reach its requested state.');
}

async function hashFiles(path) {
  const entries = await readdir(path);
  const files = {};
  for (const name of entries.sort()) {
    if (name === 'manifest.json') continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !(await lstat(join(path, name))).isFile()) {
      throw new Fault('DENIED', 'Checkpoint contains an unexpected file type.');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(path, name))) hash.update(chunk);
    Object.defineProperty(files, name, { value: hash.digest('hex'), enumerable: true });
  }
  if (!Object.keys(files).length) throw new Fault('PARTIAL', 'CRIU generated no images.');
  return files;
}

async function criu() {
  if (!linux) throw new Fault('UNSUPPORTED', 'Native checkpoint requires Linux CRIU. Use freeze/resume or sleep/wake on this host.');
  const cli = await executable('criu', process.cwd(), process.env);
  await command(cli, ['check'], { timeout: 30000 }).catch(error => {
    throw new Fault(error.code === 'DENIED' ? 'DENIED' : 'UNSUPPORTED', 'CRIU preflight failed. Verify kernel support and CRIU permissions.');
  });
  const version = (await command(cli, ['--version'])).trim();
  return { cli, version };
}

export async function checkpoint(state, project, root, backend, targets, mark) {
  const id = randomUUID();
  const path = join(state, `checkpoint-${id}`);
  const manifest = { schemaVersion: 1, id, backend, project: project.id, platform: process.platform, arch: arch(),
    kernel: release(), boot: await bootId(), cwd: project.cwd, captured: new Date().toISOString() };
  if (backend === 'docker') {
    const eligible = targets.filter(target => !target.shared && target.running && !target.paused);
    if (eligible.length !== 1 || targets.length !== 1 || root) throw new Fault('UNSUPPORTED', 'Docker checkpoint requires a single exclusive running container and no native workload.');
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}']));
    if (version.Os !== 'linux') throw new Fault('UNSUPPORTED', 'The Docker server must use a Linux CRIU runtime.');
    Object.assign(manifest, { container: eligible[0].id, version: version.Version });
    await mkdir(path, { mode: 0o700 });
    mark(id);
    await docker(['checkpoint', 'create', '--leave-running', '--checkpoint-dir', path, manifest.container, id]);
    manifest.files = await hashFiles(join(path, id));
  } else {
    if (!root || targets.length) throw new Fault('UNSUPPORTED', 'Native checkpoint requires a live native root and no container dependencies.');
    const { cli, version } = await criu();
    const [ownNamespace, childNamespace] = await Promise.all([readFile('/proc/self/status', 'utf8'), readFile(`/proc/${root.pid}/status`, 'utf8')]);
    if (!ownNamespace.includes('NSpid:') || !childNamespace.includes('NSpid:')) throw new Fault('UNSUPPORTED', 'CRIU could not establish PID namespace metadata.');
    Object.assign(manifest, { version, root });
    await mkdir(path, { mode: 0o700 });
    mark(id);
    await command(cli, ['dump', '--tree', String(root.pid), '--images-dir', path, '--work-dir', path,
      '--log-file', 'dump.log', '--leave-running'], { timeout: 120000 });
    manifest.files = await hashFiles(path);
  }
  await writeFile(join(path, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return id;
}

export async function restore(state, project, id, targets, mark) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Fault('USAGE', 'Supply a checkpoint ID.');
  const path = join(state, `checkpoint-${id}`);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8').catch(() => {
    throw new Fault('NOT_FOUND', 'A complete checkpoint manifest is missing.');
  }));
  if (manifest.schemaVersion !== 1 || manifest.project !== project.id || manifest.cwd !== project.cwd ||
      manifest.platform !== process.platform || manifest.arch !== arch() || manifest.kernel !== release() || manifest.boot !== await bootId()) {
    throw new Fault('DENIED', 'Checkpoint requires the original project, host boot, architecture, and kernel.');
  }
  const images = manifest.backend === 'docker' ? join(path, id) : path;
  if (JSON.stringify(await hashFiles(images)) !== JSON.stringify(manifest.files)) throw new Fault('DENIED', 'Checkpoint integrity verification failed.');
  if (manifest.backend === 'docker') {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}']));
    if (version.Version !== manifest.version || !targets.some(t => !t.shared && !t.running && t.id === manifest.container)) {
      throw new Fault('DENIED', 'Restore requires the original stopped container and matching Docker version.');
    }
    mark(id);
    await docker(['start', '--checkpoint', id, '--checkpoint-dir', path, manifest.container]);
    if (!(await inspectDocker(manifest.container)).State.Running) throw new Fault('PARTIAL', 'Restored container is not running.');
    return undefined;
  }
  const { cli, version } = await criu();
  if (manifest.version !== version || targets.length) throw new Fault('DENIED', 'Restore requires the original CRIU version and capture scope.');
  const work = join(state, `restore-${randomUUID()}`);
  await mkdir(work, { mode: 0o700 });
  mark(id);
  const pidFile = join(work, 'pid');
  await command(cli, ['restore', '--images-dir', path, '--work-dir', work, '--log-file', 'restore.log',
    '--restore-detached', '--pidfile', pidFile], { timeout: 120000 });
  return Number((await readFile(pidFile, 'utf8')).trim());
}
