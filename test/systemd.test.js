import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { serviceAction, serviceTargets, unitState } from '../src/systemd.js';

const exec = promisify(execFile);
const ctl = (...args) => exec('/usr/bin/systemctl', ['--user', '--no-pager', '--no-ask-password', ...args], { timeout: 15000 });

test('systemd user adapter freezes an owned service and restores its timer', {
  skip: process.platform !== 'linux' || process.env.PF_TEST_SYSTEMD !== '1', timeout: 45000
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pf-systemd-'));
  const name = `projectfreeze-${process.pid}`;
  const unit = `${name}.service`;
  const timer = `${name}.timer`;
  const serviceFile = join(cwd, unit);
  const timerFile = join(cwd, timer);
  const policies = [{ unit, shared: false }, { unit: timer, shared: false }];
  const project = { id: 'fixture', cwd, recipe: { systemd: policies } };
  const targets = () => serviceTargets(project, [project]);
  try {
    await writeFile(serviceFile, `[Unit]\nDescription=ProjectFreeze isolated test service\n[Service]\nExecStart=/usr/bin/sleep 180\nWorkingDirectory=${cwd}\nRestart=on-failure\nSendSIGKILL=no\n`, { mode: 0o600 });
    await writeFile(timerFile, `[Unit]\nDescription=ProjectFreeze isolated test timer\n[Timer]\nOnActiveSec=120\nUnit=${unit}\n`, { mode: 0o600 });
    await ctl('link', serviceFile, timerFile);
    await ctl('start', unit, timer);
    const [, activation] = await targets();
    assert.equal(activation.state.ActiveState, 'active');
    await serviceAction('stop', activation, 6000);
    const [service] = await targets();
    await serviceAction('freeze', service, 6000);
    assert.equal((await unitState(unit)).FreezerState, 'frozen');
    assert.equal((await unitState(timer)).ActiveState, 'inactive');
    const [frozen, inactive] = await targets();
    await serviceAction('thaw', frozen, 6000);
    await serviceAction('start', inactive, 6000);
    assert.equal((await unitState(timer)).ActiveState, 'active');
    const [active] = await targets();
    await serviceAction('stop', active, 6000);
    assert.equal((await unitState(unit)).ActiveState, 'inactive');
    const shared = await serviceTargets(project, [project, { id: 'other', recipe: { systemd: policies } }]);
    assert.equal(shared[0].shared, true);
    assert.equal(shared[1].shared, true);
  } finally {
    await ctl('thaw', unit).catch(() => {});
    await ctl('stop', timer, unit).catch(() => {});
    await ctl('disable', timer, unit).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
    await ctl('daemon-reload').catch(() => {});
  }
});
