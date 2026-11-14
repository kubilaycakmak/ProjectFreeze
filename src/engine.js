import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { readFile, readlink, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { candidates, directory, projectId, summarize } from './discovery.js';
import { Fault, problem } from './errors.js';
import { checkpoint, composeTargets, containerAction, restore } from './integrations.js';
import { bootId, command, containerPids, control, executable, identity, key, localPorts, matches, scan, stageLaunch, windows } from './platform.js';
import { localServices } from './inventory.js';
import { launchEnv, prepareCgroup, recipe } from './recipe.js';
import { serviceAction, serviceTargets, systemdPids } from './systemd.js';
import { observeSupervisors, supervisorAction, supervisorTargets } from './supervisors.js';

const suspended = row => row.state === 'T';
const stopped = row => row.state === 'Z' || row.state === 'X';
const alive = (rows, target) => rows.find(row => matches(row, target) && !stopped(row));
const visible = (rows, project) => rows.filter(row => !stopped(row) && project.members.some(target => matches(target, row)));
const runningService = (containers, units) => containers.some(target => !target.shared && target.running) ||
  units.some(unit => !unit.shared && !unit.timer && unit.state.ActiveState === 'active');
const newProject = (id, cwd) => ({ id, cwd, name: basename(cwd), members: [], excluded: [], state: 'registered' });
const changes = new Set(['adopt', 'run', 'freeze', 'resume', 'sleep', 'kill', 'wake', 'checkpoint', 'restore', 'reconcile']);

async function listening({ address, port }) {
  return new Promise(resolve => {
    const socket = createConnection({ host: address, port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

export class Engine {
  constructor(store, state) {
    this.store = store;
    this.state = state;
    this.current = null;
    this.tracking = false;
    this.closing = false;
    this.store.recover();
  }

  async dispatch(action, input = {}) {
    if (action === 'history') return this.store.history();
    if (action === 'operation') return this.store.operation(input.id);
    if (action === 'cancel') {
      if (this.current?.op.id !== input.id) throw new Fault('NOT_FOUND', 'Operation is no longer running.');
      this.current.cancelled = true;
      return { id: input.id, cancellation: 'requested' };
    }
    if (action === 'services') return localServices();
    if (['list', 'discover', 'inspect', 'listeners', 'ports'].includes(action)) return this.inspect(action, input);
    if (!changes.has(action)) throw new Fault('USAGE', 'Unknown operation.');
    while (this.tracking) await delay(25);
    if (this.current || this.closing) throw new Fault('BUSY', 'An operation is running or the daemon is shutting down.');
    const ids = [...new Set(input.ids ?? [])];
    if (!['adopt', 'run', 'reconcile'].includes(action) && (!ids.length || ids.length > 32 || !ids.every(id => /^p-[a-f0-9]{16}$/.test(id)))) {
      throw new Fault('USAGE', 'Provide one or more registered project IDs.');
    }
    const op = { id: randomUUID(), action, projects: ids, status: 'running', started: new Date().toISOString(), outcomes: [] };
    const job = { op, cancelled: false };
    this.store.journal(op);
    this.current = job;
    void this.work(job, input).catch(() => { this.current = null; });
    return { id: op.id, status: op.status };
  }

  async inspect(action, input) {
    const projects = this.store.projects();
    const rows = await scan();
    for (const project of projects) if (project.root) await this.track(project, rows).catch(() => {});
    const discovered = await candidates(projects, rows);
    const observed = discovered.map(group => ({ ...group, processes: group.members, processCount: group.members.length,
      ports: group.members.flatMap(member => member.ports), dependencies: [], containers: [], systemd: [], supervisors: [], restart: { configured: false } }));
    if (action === 'discover') return observed;
    const managed = projects.map(project => summarize(project, rows, observed.find(d => d.id === project.id)));
    const combined = [...managed, ...observed.filter(candidate => !projects.some(p => p.id === candidate.id))];
    if (action === 'list') return combined;
    if (action === 'listeners' || action === 'ports') {
      const association = new Map(observed.flatMap(project => project.processes.map(row => [row.pid, { project: project.id, name: project.name, scope: 'observed' }])));
      for (const project of managed) {
        for (const row of project.processes) association.set(row.pid, { project: project.id, name: project.name, scope: 'managed' });
      }
      const images = new Map(rows.map(row => [row.pid, row.image]));
      const endpoints = action === 'ports' ? await localPorts(rows) : rows.flatMap(row => row.ports.map(port => ({ ...port, pid: row.pid })));
      return [...new Map(endpoints.map(row => [`${row.protocol}/${row.address}/${row.port}/${row.pid}`, row])).values()]
        .map(row => ({ ...row, image: images.get(row.pid), scope: 'unassigned', ...association.get(row.pid) }))
        .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || a.pid - b.pid);
    }
    const project = combined.find(p => p.id === input.id);
    if (!project) throw new Fault('NOT_FOUND', 'Unknown project ID.');
    const registered = projects.find(row => row.id === input.id);
    const supervisors = registered ? await observeSupervisors(registered, projects, rows).then(targets => targets.map(({ key, kind, name, state, pid, enabled, active, shared }) =>
      ({ key, kind, name, state, pid, enabled, active, shared })), error => project.supervisors.map(target => ({ ...target, error: problem(error) }))) : [];
    return { ...project, supervisors, candidates: observed.find(candidate => candidate.id === input.id)?.processes ?? [],
      operations: this.store.history().filter(op => op.projects.includes(input.id)).slice(0, 12) };
  }

  check(job) { if (job.cancelled) throw new Fault('CANCELLED', 'Cancelled at a resource boundary. Completed effects remain in the journal.'); }
  pending(job, project, text, effect) {
    job.op.pending = text;
    if (effect) project.uncertainEffect = { operation: job.op.id, ...effect };
    this.store.commit(project, job.op);
  }
  record(job, project, target, status, error) {
    if (!error) {
      delete job.op.pending;
      if (project?.uncertainEffect?.operation === job.op.id) delete project.uncertainEffect;
    }
    job.op.outcomes.push({ target, status, ...(error ? problem(error) : {}) });
    this.store.commit(project, job.op);
  }

  async work(job, input) {
    const { op } = job;
    try {
      if (op.action === 'adopt') await this.adopt(job, input);
      else if (op.action === 'run') await this.run(job, input);
      else if (op.action === 'reconcile') await this.reconcile(job, input.ids);
      else {
        const all = this.store.projects();
        const byId = new Map(all.map(project => [project.id, project]));
        const ordered = [];
        const visiting = new Set();
        const add = id => {
          if (visiting.has(id)) throw new Fault('USAGE', 'Dependency graph contains a cycle.');
          if (ordered.includes(id)) return;
          const project = byId.get(id);
          if (!project) throw new Fault('NOT_FOUND', 'Project or registered dependency is missing.');
          visiting.add(id);
          for (const dep of project.recipe?.dependencies ?? []) {
            if (op.action === 'wake' || op.projects.includes(dep)) add(dep);
          }
          visiting.delete(id);
          ordered.push(id);
        };
        op.projects.forEach(add);
        if (['freeze', 'sleep'].includes(op.action)) ordered.reverse();
        for (const id of ordered) {
          this.check(job);
          const project = this.store.project(id);
          try {
            if (project.uncertainEffect) {
              throw new Fault('PARTIAL', 'Reconcile the interrupted resource effect before changing project state.');
            }
            if (op.action === 'freeze') await this.freeze(job, project);
            if (op.action === 'resume') await this.resume(job, project);
            if (op.action === 'sleep') await this.sleep(job, project, input);
            if (op.action === 'kill') await this.kill(job, project, input);
            if (op.action === 'wake') await this.wake(job, project);
            if (op.action === 'checkpoint') await this.capture(job, project, input);
            if (op.action === 'restore') await this.restore(job, project, input);
          } catch (error) {
            if (['freezing', 'resuming', 'sleeping-in-progress', 'terminating', 'waking', 'restoring'].includes(project.state)) project.state = 'partial';
            this.record(job, project, id, 'failed', error);
            if (error.code === 'CANCELLED' || ['wake', 'sleep'].includes(op.action)) break;
          }
        }
      }
      const failures = op.outcomes.filter(outcome => outcome.status === 'failed');
      op.status = job.cancelled ? 'cancelled' : failures.length ? (op.outcomes.length === 1 ? 'failed' : 'partial') : 'complete';
    } catch (error) {
      this.record(job, undefined, op.action, 'failed', error);
      op.status = job.cancelled ? 'cancelled' : 'failed';
    } finally {
      op.ended = new Date().toISOString();
      this.store.journal(op);
      this.current = null;
    }
  }

  async adopt(job, input) {
    const cwd = await directory(input.cwd);
    const id = projectId(cwd);
    const projects = this.store.projects();
    const project = projects.find(p => p.id === id) ?? newProject(id, cwd);
    if (!['registered', 'exited', 'running', 'adopted'].includes(project.state)) throw new Fault('BUSY', 'Reconcile the current project state before changing ownership.');
    if (input.confirm !== true || !Array.isArray(input.members) || !input.members.length || input.members.length > 256) {
      throw new Fault('USAGE', 'Inspect discovery and explicitly approve the listed PID@creation@boot identities.');
    }
    const rows = await scan();
    const group = (await candidates(projects, rows)).find(candidate => candidate.id === id);
    const excluded = Array.isArray(input.exclude) ? input.exclude : [];
    for (const target of [...input.members, ...excluded]) {
      if (!group?.members.some(row => matches(row, target)) && !project.members.some(row => matches(row, target))) {
        throw new Fault('DENIED', 'An approved identity no longer matches the current candidates. Review discovery again.');
      }
    }
    for (const target of input.members) {
      if (!alive(rows, target) || excluded.some(item => matches(item, target))) throw new Fault('DENIED', 'A selected process is stale or excluded.');
      if (!project.members.some(item => matches(item, target))) project.members.push({ ...identity(target), source: 'adopted' });
    }
    project.members = project.members.filter(target => !excluded.some(item => matches(item, target)));
    project.excluded.push(...excluded.map(identity));
    project.state = project.root ? 'running' : 'adopted';
    if (input.recipe) {
      project.recipe = await recipe({ ...input.recipe, cwd });
      await supervisorTargets(project, projects, true);
    }
    job.op.projects = [id];
    this.record(job, project, id, 'adopted');
  }

  async run(job, input) {
    const configuration = await recipe(input.recipe);
    const id = projectId(configuration.cwd);
    const project = this.store.projects().find(p => p.id === id) ?? newProject(id, configuration.cwd);
    if (project.uncertainEffect || !['registered', 'exited', 'sleeping'].includes(project.state)) {
      throw new Fault('BUSY', 'This project already owns a workload or has an interrupted effect. Inspect and reconcile before launching another.');
    }
    if (visible(await scan(false), project).length) throw new Fault('BUSY', 'Verified processes are already running for this project.');
    const all = this.store.projects();
    for (const id of configuration.dependencies) {
      if (id === project.id || !all.some(p => p.id === id && p.state === 'running')) throw new Fault('UNAVAILABLE', 'Start registered dependencies before running this recipe.');
    }
    project.recipe = configuration;
    project.restarts = 0;
    job.op.projects = [id];
    if (configuration.systemd.length) await serviceTargets(project, all);
    await supervisorTargets(project, all, true);
    try { await this.launch(job, project); }
    catch (error) { project.state = 'partial'; this.record(job, project, id, 'failed', error); }
  }

  async launch(job, project) {
    const config = project.recipe;
    if (!config) throw new Fault('UNAVAILABLE', 'This project has no reviewed restart recipe.');
    const env = launchEnv(config, process.env);
    if (config.ready && await listening(config.ready)) throw new Fault('BUSY', 'The readiness port already accepts connections.');
    if (project.cgroup) await rmdir(project.cgroup).catch(() => {});
    project.cgroup = await prepareCgroup(config.cgroup, `${project.id}-${randomUUID()}`);
    project.job = windows ? `Local\\ProjectFreeze-${randomUUID()}` : undefined;
    project.sleepingIntent = false;
    project.state = 'waking';
    project.launchReceipt = randomUUID();
    this.pending(job, project, 'stage workload launch');
    const staged = await stageLaunch(config.argv, project.cwd, env, project.job, project.cgroup, join(this.state, `exit-${project.launchReceipt}`));
    try {
      project.root = staged.root;
      project.members = [...project.members.filter(member => member.source === 'adopted' && member.suspended), { ...staged.root, source: 'launched' }];
      this.pending(job, project, 'release verified staged workload', { kind: 'launch' });
      this.check(job);
      staged.release();
    } catch (error) { staged.abort(); throw error; }
    await this.ready(job, project);
    project.state = 'running';
    this.record(job, project, project.id, 'running');
  }

  async ready(job, project) {
    const deadline = Date.now() + (project.recipe?.timeout ?? 10000);
    do {
      this.check(job);
      const rows = await scan(Boolean(project.recipe?.ready));
      await this.track(project, rows);
      if (project.root && !visible(rows, project).length) {
        if (Date.now() + 250 >= deadline) throw new Fault('PARTIAL', 'Workload exited before readiness.');
        await delay(200);
        continue;
      }
      const port = project.recipe?.ready;
      if (!port || (visible(rows, project).some(row => row.ports.some(p => p.port === port.port &&
        [port.address, '0.0.0.0', '*', '::', '0:0:0:0:0:0:0:0'].includes(p.address))) && await listening(port))) return;
      await delay(200);
    } while (Date.now() < deadline);
    throw new Fault('PARTIAL', 'Readiness deadline expired without a verified workload listener.');
  }

  async track(project, rows) {
    if (!project.root) return;
    let contained = null;
    try { contained = await containerPids(project); }
    catch (error) {
      if (!windows || error.code !== 'NOT_FOUND') throw error;
    }
    const root = alive(rows, project.root);
    const groupProof = root ?? (!windows && !project.cgroup && rows.find(row => row.group === project.root.pid &&
      row.session === project.root.pid && project.members.some(member => matches(member, row))));
    const foreign = new Set(this.store.projects().filter(other => other.id !== project.id).flatMap(other => other.members.map(key)));
    for (const row of rows) {
      if (stopped(row) || foreign.has(key(row)) || project.excluded.some(item => matches(item, row)) ||
          project.members.some(item => matches(item, row))) continue;
      if (contained?.has(windows ? key(row) : row.pid) || (!contained && groupProof && row.group === project.root.pid && row.group === groupProof.group)) {
        project.members.push({ ...identity(row), source: 'contained' });
      }
    }
  }

  async restartEligible(project, rows) {
    if (project.recipe?.restart !== 'on-failure' || project.sleepingIntent || !['running', 'exited'].includes(project.state) ||
        (project.restarts ?? 0) >= 3 || visible(rows, project).length || project.root?.boot !== await bootId() ||
        !/^[a-f0-9-]{36}$/.test(project.launchReceipt ?? '')) return false;
    const receipt = await readFile(join(this.state, `exit-${project.launchReceipt}`), 'utf8').catch(() => '');
    return /^[1-9][0-9]{0,9}\n$/.test(receipt);
  }

  async poll() {
    if (this.current || this.tracking || this.closing) return;
    this.tracking = true;
    let restart;
    try {
      const projects = this.store.projects();
      if (!projects.length) return;
      const rows = await scan(false);
      for (const project of projects) {
        if (!project.members.length && !project.recipe?.systemd?.length && !project.recipe?.containers?.length) continue;
        const before = JSON.stringify(project);
        try { await this.track(project, rows); }
        catch { if (project.state === 'frozen') { project.state = 'partial'; this.store.save(project); } continue; }
        const live = visible(rows, project);
        if (!restart && await this.restartEligible(project, rows)) restart = project.id;
        if (['running', 'adopted'].includes(project.state) && !live.length && !project.recipe?.supervisors?.length) {
          try {
            const containers = await composeTargets(project, projects);
            const units = await serviceTargets(project, projects);
            if (!runningService(containers, units)) project.state = 'exited';
          } catch { project.state = 'partial'; }
        }
        if (project.state === 'frozen') {
          try {
            const units = await serviceTargets(project, projects);
            const containers = await composeTargets(project, projects);
            const external = await observeSupervisors(project, projects, rows);
            const servicePids = new Set([...(await Promise.all(units.map(systemdPids))).flat(), ...external.map(target => target.pid)]);
            const observed = live.filter(row => !servicePids.has(row.pid));
            if ((!live.length && !units.some(unit => unit.state?.FreezerState === 'frozen') && !containers.some(target => target.paused) &&
                  !external.some(t => t.state === 'Paused' || project.disabledTasks?.includes(t.key))) ||
                observed.some(row => !suspended(row)) || units.some(unit => unit.state?.ActiveState === 'active' && unit.state.FreezerState !== 'frozen') ||
                containers.some(target => target.running && !target.paused) || external.some(t => !t.shared && (t.state === 'Running' || t.enabled || t.active))) project.state = 'partial';
          } catch { project.state = 'partial'; }
        }
        if (JSON.stringify(project) !== before) this.store.save(project);
      }
    } finally { this.tracking = false; }
    if (restart && !this.current && !this.closing) {
      const project = this.store.project(restart);
      project.restarts = (project.restarts ?? 0) + 1;
      project.state = 'exited';
      this.store.save(project);
      await this.dispatch('wake', { ids: [restart] });
    }
  }

  async freeze(job, project) {
    if (!['running', 'adopted', 'partial', 'frozen', 'registered'].includes(project.state)) throw new Fault('BUSY', 'Project is not in a freezable state.');
    const all = this.store.projects();
    if (all.some(other => other.id !== project.id && !job.op.projects.includes(other.id) && other.recipe?.dependencies.includes(project.id) &&
        !['sleeping', 'exited', 'registered', 'frozen'].includes(other.state))) {
      throw new Fault('BUSY', 'An active unselected project still uses this dependency.');
    }
    const targets = await composeTargets(project, all);
    const units = await serviceTargets(project, all);
    const external = await observeSupervisors(project, all, await scan(false));
    if (external.some(target => !target.shared && (target.kind === 'task' ? target.active : !['Running', 'Paused', 'Stopped'].includes(target.state)))) {
      throw new Fault('BUSY', 'A scheduled task or service is active or transitioning. Wait for a stable state before freezing.');
    }
    project.state = 'freezing';
    project.frozenContainers ??= [];
    this.pending(job, project, 'freeze barrier started');
    await this.pauseSupervisors(job, project, external);
    for (const target of units.filter(unit => unit.timer && unit.state.ActiveState === 'active')) {
      await this.changeUnit(job, project, 'stop', target, 'stoppedUnits');
    }
    const afterTimers = await serviceTargets(project, all);
    for (const target of afterTimers.filter(unit => !unit.shared && !unit.timer && unit.state.ActiveState === 'active' && unit.state.FreezerState !== 'frozen')) {
      await this.changeUnit(job, project, 'freeze', target, 'frozenUnits');
    }
    for (const target of targets) {
      this.check(job);
      if (target.shared) { this.record(job, project, `${target.project}/${target.service}`, 'shared'); continue; }
      if (!target.running || target.paused) continue;
      this.pending(job, project, `pause container ${target.id}`);
      await containerAction('pause', target.id);
      project.frozenContainers.push(target.id);
      this.record(job, project, target.id, 'frozen');
    }
    let previous;
    const deadline = Date.now() + 10000;
    do {
      this.check(job);
      const rows = await scan(false);
      await this.track(project, rows);
      const servicePids = new Set([...(await Promise.all(units.map(systemdPids))).flat(), ...external.map(target => target.pid)]);
      const members = visible(rows, project).filter(row => !servicePids.has(row.pid));
      if (!members.length && !targets.some(t => t.running && !t.shared) && !units.some(u => !u.shared && u.state.ActiveState === 'active') &&
          !external.some(t => !t.shared && (t.state === 'Running' || t.state === 'Paused' || t.enabled))) {
        throw new Fault('NOT_FOUND', 'No live owned resources are available to freeze.');
      }
      for (const member of members.filter(row => !suspended(row))) {
        this.check(job);
        this.pending(job, project, `freeze process ${key(member)}`, { kind: 'process', verb: 'freeze', identity: identity(member) });
        if (await control('freeze', member)) project.members.find(row => matches(row, member)).suspended = true;
        this.record(job, project, String(member.pid), 'freeze-requested');
      }
      const signature = members.map(key).sort().join(',');
      if (signature === previous && members.every(suspended)) {
        const verified = await serviceTargets(project, all);
        if (verified.some(u => !u.shared && (u.timer ? u.state.ActiveState === 'active' : u.state.ActiveState === 'active' && u.state.FreezerState !== 'frozen'))) {
          throw new Fault('PARTIAL', 'A user systemd unit changed state during the freeze barrier.');
        }
        const current = await observeSupervisors(project, all, rows);
        if (current.some(t => !t.shared && (t.kind === 'task' ? t.enabled || t.active : !['Paused', 'Stopped'].includes(t.state)))) {
          throw new Fault('PARTIAL', 'A supervised workload or task remains active.');
        }
        project.state = 'frozen';
        this.record(job, project, project.id, 'frozen');
        return;
      }
      previous = signature;
      await delay(125);
    } while (Date.now() < deadline);
    throw new Fault('PARTIAL', 'Freeze barrier did not converge. Inspect history and resume the resources this operation suspended.');
  }

  async resume(job, project) {
    const targets = await composeTargets(project, this.store.projects());
    const units = await serviceTargets(project, this.store.projects());
    const external = await observeSupervisors(project, this.store.projects(), await scan(false));
    project.state = 'resuming';
    this.pending(job, project, 'resume recorded suspensions');
    await this.restoreSupervisors(job, project, external, 'resume', 'pausedSupervisors');
    await this.restoreUnits(job, project, units, 'thaw', 'frozenUnits');
    const rows = await scan(false);
    for (const member of project.members.filter(m => m.suspended)) {
      this.check(job);
      const live = alive(rows, member);
      this.pending(job, project, `resume process ${key(member)}`, { kind: 'process', verb: 'resume', identity: identity(member) });
      if (live) {
        await control('resume', member);
        if ((await scan(false)).some(row => matches(row, member) && suspended(row))) throw new Fault('PARTIAL', 'Process remains suspended.');
      }
      delete member.suspended;
      this.record(job, project, String(member.pid), live ? 'resumed' : 'exited');
    }
    for (const id of [...(project.frozenContainers ?? [])]) {
      this.check(job);
      const target = targets.find(t => t.id === id && !t.shared);
      if (!target) throw new Fault('DENIED', 'Container is outside current exclusive ownership.');
      this.pending(job, project, `resume container ${id}`);
      if (target.paused) await containerAction('unpause', id);
      project.frozenContainers = project.frozenContainers.filter(value => value !== id);
      this.record(job, project, id, 'resumed');
    }
    const after = visible(await scan(false), project);
    const currentTargets = await composeTargets(project, this.store.projects());
    const currentUnits = await serviceTargets(project, this.store.projects());
    const currentExternal = await observeSupervisors(project, this.store.projects(), await scan(false));
    if (after.some(row => suspended(row) || ['t', 'M', '?'].includes(row.state)) || currentTargets.some(t => !t.shared && t.paused) ||
        currentUnits.some(unit => unit.state?.FreezerState === 'frozen') || currentExternal.some(target => !target.shared && target.state === 'Paused')) {
      throw new Fault('PARTIAL', 'A member remains externally suspended or its execution state cannot be verified.');
    }
    if (after.length) await this.ready(job, project);
    await this.restoreUnits(job, project, units, 'start', 'stoppedUnits');
    await this.restoreSupervisors(job, project, external, 'enable', 'disabledTasks');
    project.state = after.length || targets.some(t => t.running) || currentUnits.some(unit => unit.state?.ActiveState === 'active') || external.some(t => t.state === 'Running' || t.state === 'Paused')
      ? (project.root ? 'running' : 'adopted') : 'exited';
    this.record(job, project, project.id, project.state);
  }

  async sleep(job, project, input) {
    if (!project.recipe) throw new Fault('UNAVAILABLE', 'Add an approved restart recipe before sleep. Freeze preserves a workload without a recipe.');
    if (project.state === 'sleeping') { this.record(job, project, project.id, 'sleeping'); return; }
    const all = this.store.projects();
    if (all.some(other => other.id !== project.id && other.recipe?.dependencies.includes(project.id) && !['sleeping', 'exited', 'registered'].includes(other.state))) {
      throw new Fault('BUSY', 'An active project still uses this dependency.');
    }
    const targets = await composeTargets(project, all);
    const units = await serviceTargets(project, all);
    if (units.some(u => !u.shared && u.state.FreezerState === 'frozen')) throw new Fault('BUSY', 'Resume the systemd services before graceful shutdown.');
    if (targets.some(target => !target.shared && target.running) && input.force !== true) {
      throw new Fault('DENIED', 'Docker stop can force termination after its deadline. Review the exclusive containers and supply --force.');
    }
    const before = await scan();
    await this.track(project, before);
    const external = await observeSupervisors(project, all, before);
    if (external.some(t => !t.shared && (t.kind === 'task' ? t.active : !['Running', 'Stopped'].includes(t.state)))) {
      throw new Fault('BUSY', 'Resume paused services and wait for active tasks or service transitions before shutdown.');
    }
    const externalPids = new Set(external.map(t => t.pid));
    const members = visible(before, project).filter(row => !externalPids.has(row.pid));
    if (members.some(suspended)) throw new Fault('BUSY', 'Resume the project before graceful shutdown.');
    if (windows && members.length && !project.recipe.stop && input.force !== true) throw new Fault('UNSUPPORTED', 'Windows requires an application shutdown command or explicit --force approval.');
    project.sleepingIntent = true;
    project.state = 'sleeping-in-progress';
    this.pending(job, project, 'disable managed restart and begin shutdown');
    for (const target of external.filter(t => !t.shared && t.kind === 'task' && t.enabled)) await this.changeSupervisor(job, project, 'disable', target, 'disabledTasks');
    const activeUnits = units.filter(unit => !unit.shared && unit.state.ActiveState === 'active');
    for (const target of activeUnits.filter(unit => unit.timer)) await this.changeUnit(job, project, 'stop', target, 'stoppedUnits');
    const servicePids = new Set((await Promise.all(activeUnits.map(systemdPids))).flat());
    const portKeys = new Set(members.flatMap(row => row.ports.map(port => `${port.address}:${port.port}`)));
    if (members.length && project.recipe.stop) {
      const env = launchEnv(project.recipe, process.env);
      const executablePath = await executable(project.recipe.stop[0], project.cwd, env);
      this.check(job);
      this.pending(job, project, 'run reviewed application shutdown command', { kind: 'shutdown' });
      await command(executablePath, project.recipe.stop.slice(1), { cwd: project.cwd, env, timeout: project.recipe.timeout });
      this.record(job, project, project.id, 'shutdown-command-completed');
    } else if (!windows) {
      for (const row of [...members].reverse().filter(row => !servicePids.has(row.pid))) {
        this.check(job);
        this.pending(job, project, `request shutdown of process ${key(row)}`);
        try { await control('stop', row); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        this.record(job, project, String(row.pid), 'shutdown-requested');
      }
    }
    const afterTimers = await serviceTargets(project, all);
    for (const target of afterTimers.filter(unit => !unit.shared && !unit.timer && unit.state.ActiveState === 'active')) {
      await this.changeUnit(job, project, 'stop', target, 'stoppedUnits');
    }
    for (const target of external.filter(t => !t.shared && t.state === 'Running')) await this.changeSupervisor(job, project, 'stop', target, 'stoppedSupervisors');
    let remaining = members;
    const deadline = Date.now() + project.recipe.timeout;
    while (remaining.length && Date.now() < deadline && !(windows && !project.recipe.stop && input.force)) {
      this.check(job);
      await delay(125);
      const rows = await scan(false);
      await this.track(project, rows);
      remaining = visible(rows, project);
    }
    if (remaining.length && input.force === true) {
      for (const row of remaining) {
        if (!members.some(target => matches(target, row))) throw new Fault('PARTIAL', 'New processes appeared outside the reviewed force scope.');
        this.check(job);
        this.pending(job, project, `force stop process ${key(row)}`);
        try { await control('force', row); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        this.record(job, project, String(row.pid), 'force-stop-requested');
      }
      await delay(200);
    }
    const after = await scan();
    await this.track(project, after);
    if (visible(after, project).length) throw new Fault('PARTIAL', 'Owned processes remain after the shutdown deadline.');
    for (const target of targets) {
      this.check(job);
      if (target.shared) { this.record(job, project, `${target.project}/${target.service}`, 'shared'); continue; }
      if (!target.running) continue;
      this.pending(job, project, `stop container ${target.id}`);
      await containerAction('stop', target.id, project.recipe.timeout);
      project.stoppedContainers = [...new Set([...(project.stoppedContainers ?? []), target.id])];
      this.record(job, project, target.id, 'stopped');
    }
    for (const port of portKeys) {
      const owner = after.some(row => row.ports.some(value => `${value.address}:${value.port}` === port));
      this.record(job, project, port, owner ? 'still-observed' : 'absent-from-authorized-scan');
    }
    project.state = 'sleeping';
    this.record(job, project, project.id, 'sleeping');
  }

  async kill(job, project, input) {
    if (input.confirm !== true || input.ids?.length !== 1 || !input.members?.length) {
      throw new Fault('DENIED', 'Force termination requires confirmation for one project and its exact reviewed process identities.');
    }
    const configuration = project.recipe;
    const all = this.store.projects();
    const dependents = all.some(other => other.id !== project.id && other.recipe?.dependencies?.includes(project.id) &&
      !['sleeping', 'exited', 'registered'].includes(other.state));
    if (configuration?.containers?.length || configuration?.systemd?.length || configuration?.supervisors?.length || dependents) {
      throw new Fault('DENIED', 'Use the service or dependency shutdown workflow for this project.');
    }
    const rows = await scan(false);
    await this.track(project, rows);
    const targets = visible(rows, project);
    const approved = new Set(input.members.map(key));
    if (!targets.length || targets.length !== approved.size || targets.some(row => !approved.has(key(row)))) {
      throw new Fault('DENIED', 'Project ownership changed. Inspect the current processes and confirm again.');
    }
    this.check(job);
    project.sleepingIntent = true;
    project.state = 'terminating';
    this.pending(job, project, 'disable managed restart before force termination');
    for (const row of targets.sort((a, b) => Number(Boolean(matches(a, project.root))) - Number(Boolean(matches(b, project.root))))) {
      this.check(job);
      this.pending(job, project, `force terminate process ${key(row)}`, { kind: 'process', verb: 'force', identity: identity(row) });
      try { await control('force', row); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      this.record(job, project, String(row.pid), 'force-stop-requested');
    }
    const deadline = Date.now() + 3000;
    do {
      const current = await scan(false);
      await this.track(project, current);
      if (!visible(current, project).length) {
        project.state = project.recipe ? 'sleeping' : 'exited';
        this.record(job, project, project.id, project.state);
        return;
      }
      await delay(100);
    } while (Date.now() < deadline);
    throw new Fault('PARTIAL', 'Processes remain after force termination. Inspect the project before another action.');
  }

  async wake(job, project) {
    if (project.state === 'running') { await this.ready(job, project); this.record(job, project, project.id, 'already-running'); return; }
    if (!['sleeping', 'exited', 'partial'].includes(project.state)) throw new Fault('BUSY', 'Only a stopped project with a reviewed recipe can wake.');
    if (visible(await scan(false), project).length) throw new Fault('BUSY', 'Verified processes already exist. Reconcile before relaunching.');
    const targets = await composeTargets(project, this.store.projects());
    const units = await serviceTargets(project, this.store.projects());
    const external = await observeSupervisors(project, this.store.projects(), await scan(false));
    await this.restoreSupervisors(job, project, external, 'start', 'stoppedSupervisors');
    await this.restoreUnits(job, project, units.filter(u => !u.timer), 'start', 'stoppedUnits', true);
    for (const id of [...(project.stoppedContainers ?? [])]) {
      this.check(job);
      const target = targets.find(t => t.id === id && !t.shared);
      if (!target) throw new Fault('DENIED', 'Stopped container is outside current exclusive ownership.');
      this.pending(job, project, `start container ${id}`);
      if (!target.running) await containerAction('start', id);
      project.stoppedContainers = project.stoppedContainers.filter(value => value !== id);
      this.record(job, project, id, 'started');
    }
    await this.launch(job, project);
    try {
      await this.restoreUnits(job, project, units.filter(u => u.timer), 'start', 'stoppedUnits', true);
      await this.restoreSupervisors(job, project, external, 'enable', 'disabledTasks');
    } catch (error) { project.state = 'partial'; throw error; }
  }

  async changeSupervisor(job, project, action, target, field, remove = false) {
    this.check(job);
    this.pending(job, project, `${action} ${target.key}`, { kind: 'supervisor', verb: action, key: target.key, field, remove,
      ...(target.process ? { identity: identity(target.process) } : {}), ...(target.pid ? { pid: target.pid } : {}) });
    await supervisorAction(action, target, project);
    const previous = project[field] ?? [];
    project[field] = remove ? previous.filter(key => key !== target.key) : [...new Set([...previous, target.key])];
    if (action === 'pause') {
      project.pausedSupervisorIdentities ??= {};
      project.pausedSupervisorIdentities[target.key] = target.process ? identity(target.process) : { pid: target.pid };
    }
    if (action === 'resume' && project.pausedSupervisorIdentities) delete project.pausedSupervisorIdentities[target.key];
    this.record(job, project, target.name, action);
  }

  async pauseSupervisors(job, project, targets) {
    for (const target of targets.filter(t => !t.shared && t.kind === 'task' && t.enabled)) await this.changeSupervisor(job, project, 'disable', target, 'disabledTasks');
    for (const target of targets.filter(t => !t.shared && t.state === 'Running')) await this.changeSupervisor(job, project, 'pause', target, 'pausedSupervisors');
  }

  async restoreSupervisors(job, project, targets, action, field) {
    for (const key of [...(project[field] ?? [])]) {
      const target = targets.find(t => t.key === key && !t.shared);
      if (!target) throw new Fault('DENIED', 'The previously changed resource is outside current exclusive ownership.');
      const pausedIdentity = project.pausedSupervisorIdentities?.[key];
      if (action === 'resume' && pausedIdentity && (target.pid !== pausedIdentity.pid ||
          (pausedIdentity.birth && !matches(target.process, pausedIdentity)))) {
        throw new Fault('DENIED', 'The previously paused supervisor process was replaced.');
      }
      if (action === 'enable' ? target.enabled : target.state === 'Running') {
        project[field] = project[field].filter(value => value !== key);
        if (action === 'resume' && project.pausedSupervisorIdentities) delete project.pausedSupervisorIdentities[key];
        this.record(job, project, target.name, 'already-restored');
      } else await this.changeSupervisor(job, project, action, target, field, true);
    }
  }

  async changeUnit(job, project, action, target, field, remove = false) {
    this.check(job);
    this.pending(job, project, `${action} systemd user unit ${target.unit}`);
    await serviceAction(action, target, project.recipe?.timeout ?? 10000);
    const previous = project[field] ?? [];
    project[field] = remove ? previous.filter(name => name !== target.unit) : [...new Set([...previous, target.unit])];
    this.record(job, project, target.unit, ({ start: 'started', stop: 'stopped', freeze: 'frozen', thaw: 'resumed' })[action]);
  }

  async restoreUnits(job, project, units, action, field, subset = false) {
    for (const unit of [...(project[field] ?? [])]) {
      const target = units.find(t => t.unit === unit && !t.shared);
      if (!target && subset) continue;
      if (!target) throw new Fault('DENIED', 'Previously changed systemd unit is outside current exclusive ownership.');
      const already = action === 'thaw' ? target.state.FreezerState === 'running' : target.state.ActiveState === 'active';
      if (already) {
        project[field] = project[field].filter(name => name !== unit);
        this.record(job, project, unit, 'already-active');
      } else await this.changeUnit(job, project, action, target, field, true);
    }
  }

  async capture(job, project, input) {
    const rows = await scan(false);
    await this.track(project, rows);
    const root = alive(rows, project.root);
    const targets = await composeTargets(project, this.store.projects());
    const backend = input.backend ?? 'criu';
    if (project.recipe?.systemd?.length || project.recipe?.supervisors?.length) throw new Fault('UNSUPPORTED', 'A process checkpoint cannot capture registered external supervisors.');
    if (!['criu', 'docker'].includes(backend)) throw new Fault('USAGE', 'Choose the criu or docker checkpoint backend.');
    if (backend === 'criu') {
      if (project.excluded.length || visible(rows, project).some(row => row.state === 'T' || row.state === 't')) {
        throw new Fault('UNSUPPORTED', 'Checkpoint requires an exclusive running tree with no excluded or suspended members.');
      }
      if (root) {
        const descendants = new Set([root.pid]);
        let count;
        do { count = descendants.size; rows.filter(row => descendants.has(row.parent)).forEach(row => descendants.add(row.pid)); }
        while (descendants.size > count);
        if (visible(rows, project).some(row => !descendants.has(row.pid)) || [...descendants].some(pid => !visible(rows, project).some(row => row.pid === pid))) {
          throw new Fault('UNSUPPORTED', 'CRIU tree scope differs from the verified owned process set.');
        }
      }
    }
    const verify = async target => {
      if (!alive(await scan(false), target)) throw new Fault('NOT_FOUND', 'The checkpoint root identity changed.');
      const namespace = {};
      for (const name of ['pid', 'mnt', 'net', 'user']) {
        const [own, member] = await Promise.all([readlink(`/proc/self/ns/${name}`), readlink(`/proc/${target.pid}/ns/${name}`)]).catch(() => []);
        if (!own || own !== member) throw new Fault('UNSUPPORTED', `CRIU capture requires the same ${name} namespace.`);
        namespace[name] = own;
      }
      return namespace;
    };
    const id = await checkpoint(this.state, project, root, backend, targets, id => {
      this.check(job);
      this.pending(job, project, `checkpoint ${id}`);
    }, verify);
    this.record(job, project, id, 'captured');
  }

  async restore(job, project, input) {
    if (project.recipe?.systemd?.length || project.recipe?.supervisors?.length) throw new Fault('UNSUPPORTED', 'Restore requires the original process and container scope.');
    if (visible(await scan(false), project).length) throw new Fault('BUSY', 'Stop the active workload before restoring a checkpoint.');
    if (project.recipe?.ready && await listening(project.recipe.ready)) throw new Fault('BUSY', 'The original readiness port is already active.');
    const targets = await composeTargets(project, this.store.projects());
    project.state = 'restoring';
    const pid = await restore(this.state, project, input.checkpoint, targets, id => {
      this.check(job);
      this.pending(job, project, `restore checkpoint ${id}`);
    });
    if (pid) {
      const rows = await scan(false);
      const root = rows.find(row => row.pid === pid && !stopped(row));
      if (!root) throw new Fault('PARTIAL', 'Restored root identity could not be observed.');
      project.root = identity(root);
      project.members = [{ ...identity(root), source: 'launched' }];
      project.cgroup = undefined;
      await this.track(project, rows);
      await this.ready(job, project);
    }
    project.state = 'running';
    this.record(job, project, input.checkpoint, 'restored');
  }

  async reconcile(job, ids) {
    const rows = await scan(false);
    const projects = ids?.length ? ids.map(id => this.store.project(id)) : this.store.projects();
    job.op.projects = projects.map(p => p.id);
    for (const project of projects) {
      this.check(job);
      await this.track(project, rows);
      const live = visible(rows, project);
      const units = await serviceTargets(project, this.store.projects());
      const containers = await composeTargets(project, this.store.projects());
      const external = await observeSupervisors(project, this.store.projects(), rows);
      const effect = project.uncertainEffect;
      if (effect?.kind === 'shutdown' && !live.length) delete project.uncertainEffect;
      if (effect?.kind === 'launch') {
        if (live.length) await this.ready(job, project);
        delete project.uncertainEffect;
      }
      if (effect?.kind === 'process') {
        const row = alive(rows, effect.identity);
        const member = project.members.find(item => matches(item, effect.identity));
        if (!row || !member || !suspended(row)) {
          if (member) delete member.suspended;
          delete project.uncertainEffect;
        } else if (effect.verb === 'freeze') this.record(job, project, String(row.pid), 'unconfirmed-suspension');
        else if (member.suspended) delete project.uncertainEffect;
      }
      if (effect?.kind === 'supervisor') {
        const target = external.find(item => item.key === effect.key && !item.shared);
        if (target && (effect.verb === 'enable' ? target.enabled : effect.verb === 'resume' ? target.state === 'Running' && target.pid === effect.pid : false)) {
          project[effect.field] = (project[effect.field] ?? []).filter(value => value !== effect.key);
          delete project.uncertainEffect;
        }
        if (target && (effect.verb === 'disable' ? target.enabled && !target.active :
          effect.verb === 'pause' || effect.verb === 'stop' ? target.state === 'Running' && target.pid === effect.pid :
            effect.verb === 'start' ? target.state === 'Stopped' : effect.verb === 'resume' && target.state === 'Paused' && target.pid === effect.pid)) {
          delete project.uncertainEffect;
        }
      }
      const servicePids = new Set((await Promise.all(units.map(systemdPids))).flat());
      if (project.uncertainEffect || live.some(row => suspended(row) || ['t', 'M', '?'].includes(row.state)) || project.frozenContainers?.length || project.frozenUnits?.length || project.pausedSupervisors?.length) {
        const isFrozen = live.filter(row => !servicePids.has(row.pid)).every(suspended) && containers.every(c => c.shared || !c.running || c.paused) &&
          units.every(u => u.shared || u.state.ActiveState !== 'active' || (u.state.FreezerState === 'frozen' && !u.timer));
        project.state = !project.uncertainEffect && project.state === 'frozen' && isFrozen ? 'frozen' : 'partial';
      } else if (live.length) project.state = project.root ? 'running' : 'adopted';
      else if (runningService(containers, units)) project.state = 'running';
      else if (project.state !== 'sleeping') project.state = 'exited';
      this.record(job, project, project.id, project.state);
    }
  }
}
