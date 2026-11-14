import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Fault } from './errors.js';
import { bootId, command, executable, linux } from './platform.js';

const dockerEnv = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^DOCKER_(HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH|API_VERSION)$/i.test(name)) delete env[name];
  return env;
};

async function docker(args, options = {}) {
  const env = dockerEnv();
  const cli = await executable('docker', process.cwd(), env);
  const host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  return command(cli, ['--host', host, ...args], { env, ...options });
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
      const labels = container.Config.Labels ?? {};
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
  await docker([action, ...(action === 'stop' ? ['--timeout', String(Math.ceil(timeout / 1000))] : []), id], { timeout: timeout + 5000 });
  const { State: state } = await inspectDocker(id);
  const verified = { pause: state.Running && state.Paused, unpause: state.Running && !state.Paused,
    start: state.Running && !state.Paused, stop: !state.Running }[action];
  if (!verified) throw new Fault('PARTIAL', 'The container did not reach its requested state.');
}

async function hashFiles(path) {
  const files = {};
  async function walk(relative) {
    const entries = await readdir(join(path, relative));
    for (const name of entries.sort()) {
      if (!relative && name === 'manifest.json') continue;
      const key = relative ? `${relative}/${name}` : name;
      const file = join(path, key);
      const info = await lstat(file);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || (!info.isDirectory() && !info.isFile())) {
        throw new Fault('DENIED', 'Checkpoint contains an unexpected file type.');
      }
      if (info.isDirectory()) { await walk(key); continue; }
      if (name.endsWith('.log')) continue;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      Object.defineProperty(files, key, { value: hash.digest('hex'), enumerable: true });
    }
  }
  await walk('');
  if (!Object.keys(files).length) throw new Fault('PARTIAL', 'CRIU generated no images.');
  return files;
}

async function criu() {
  if (!linux) throw new Fault('UNSUPPORTED', 'Native checkpoint requires Linux CRIU. Use freeze/resume or sleep/wake on this host.');
  const cli = await executable('criu', process.cwd(), process.env);
  await command(cli, ['check', '--no-default-config'], { timeout: 30000 }).catch(error => {
    throw new Fault(error.code === 'DENIED' ? 'DENIED' : 'UNSUPPORTED', 'CRIU preflight failed. Verify kernel support and CRIU permissions.');
  });
  const version = (await command(cli, ['--version'])).trim();
  return { cli, version };
}

export async function checkpoint(state, project, root, backend, targets, mark, verify) {
  const id = randomUUID();
  const path = join(state, `checkpoint-${id}`);
  const manifest = { schemaVersion: 1, id, backend, project: project.id, platform: process.platform, arch: arch(),
    kernel: release(), boot: await bootId(), cwd: project.cwd, captured: new Date().toISOString() };
  if (backend === 'docker') {
    if (!linux) throw new Fault('UNSUPPORTED', 'Docker checkpoint images require a verifiable local Linux filesystem shared with the Docker engine.');
    const eligible = targets.filter(target => !target.shared && target.running && !target.paused);
    if (eligible.length !== 1 || targets.length !== 1 || root) throw new Fault('UNSUPPORTED', 'Docker checkpoint requires a single exclusive running container and no native workload.');
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}']));
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    if (version.Os !== 'linux' || !info.ExperimentalBuild || info.KernelVersion !== release()) {
      throw new Fault('UNSUPPORTED', 'Docker checkpoint requires a local experimental Linux Docker engine with CRIU.');
    }
    const container = await inspectDocker(eligible[0].id);
    if (container.Mounts.length || container.HostConfig.Privileged || container.HostConfig.AutoRemove || container.HostConfig.NetworkMode !== 'host') {
      throw new Fault('UNSUPPORTED', 'This Docker checkpoint backend requires an existing host-network container with no mounts, privilege escalation, or auto-removal. Use freeze or sleep for isolated-network containers.');
    }
    if (!isAbsolute(info.DockerRootDir)) throw new Fault('DENIED', 'Docker did not report a local checkpoint store.');
    const imagePath = join(info.DockerRootDir, 'containers', container.Id, 'checkpoints', id);
    const access = await lstat(join(imagePath, '..')).catch(() => null);
    if (!access?.isDirectory()) throw new Fault('DENIED', 'The caller cannot verify the Docker engine checkpoint directory.');
    Object.assign(manifest, { container: container.Id, image: container.Image, version: version.Version, dockerRoot: info.DockerRootDir });
    await mkdir(path, { mode: 0o700 });
    mark(id);
    await docker(['checkpoint', 'create', '--leave-running', manifest.container, id], { timeout: 120000 });
    manifest.files = await hashFiles(imagePath);
  } else {
    if (!root || targets.length) throw new Fault('UNSUPPORTED', 'Native checkpoint requires a live native root and no container dependencies.');
    const { cli, version } = await criu();
    const namespace = await verify(root);
    Object.assign(manifest, { version, root, namespace });
    await mkdir(path, { mode: 0o700 });
    mark(id);
    await verify(root);
    await command(cli, ['dump', '--no-default-config', '--tree', String(root.pid), '--images-dir', path, '--work-dir', path,
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
  if (manifest.backend === 'docker') {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}']));
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    const container = await inspectDocker(manifest.container);
    if (version.Version !== manifest.version || container.Image !== manifest.image || info.DockerRootDir !== manifest.dockerRoot ||
        !info.ExperimentalBuild || !targets.some(t => !t.shared && !t.running && t.id === manifest.container)) {
      throw new Fault('DENIED', 'Restore requires the original stopped container and matching Docker version.');
    }
    const images = join(info.DockerRootDir, 'containers', container.Id, 'checkpoints', id);
    if (JSON.stringify(await hashFiles(images)) !== JSON.stringify(manifest.files)) throw new Fault('DENIED', 'Checkpoint integrity verification failed.');
    mark(id);
    const collision = /^failed to upload checkpoint to containerd: commit failed: content sha256:[a-f0-9]{64}: already exists$/;
    for (let attempt = 0; attempt < 3; attempt++) {
      let failure;
      try { await docker(['start', '--checkpoint', id, manifest.container], { timeout: 120000 }); }
      catch (error) { failure = error; }
      const { State: state } = await inspectDocker(manifest.container);
      if (state.Running && !state.Restarting && !state.Paused) return undefined;
      if (!failure || !collision.test(state.Error ?? '') || attempt === 2) {
        throw new Fault('PARTIAL', collision.test(state.Error ?? '')
          ? 'Docker restore hit a containerd content collision. The checkpoint is retained.'
          : 'Docker did not verify a running restored container. The checkpoint is retained. Inspect the local Docker container state.');
      }
      await delay(1500);
      const current = await inspectDocker(manifest.container);
      if (current.State.Running || current.State.Restarting || current.State.Paused || current.State.Dead || current.State.Pid) {
        throw new Fault('PARTIAL', 'Docker container state changed after a failed restore. Inspect it before retrying.');
      }
      mark(id);
    }
  }
  if (manifest.backend !== 'criu') throw new Fault('DENIED', 'Unknown checkpoint backend.');
  if (JSON.stringify(await hashFiles(path)) !== JSON.stringify(manifest.files)) throw new Fault('DENIED', 'Checkpoint integrity verification failed.');
  const { cli, version } = await criu();
  if (manifest.version !== version || targets.length) throw new Fault('DENIED', 'Restore requires the original CRIU version and capture scope.');
  const work = join(state, `restore-${randomUUID()}`);
  await mkdir(work, { mode: 0o700 });
  mark(id);
  const pidFile = join(work, 'pid');
  await command(cli, ['restore', '--no-default-config', '--images-dir', path, '--work-dir', work, '--log-file', 'restore.log',
    '--restore-detached', '--pidfile', pidFile], { timeout: 120000 });
  return Number((await readFile(pidFile, 'utf8')).trim());
}
