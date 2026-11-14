import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { scan } from '../src/platform.js';
import { observeSupervisors, supervisorAction, supervisorTargets } from '../src/supervisors.js';

const exec = promisify(execFile);
const name = `ProjectFreezeFixture-${process.pid}`;

test('real macOS LaunchAgent pause, resume, stop, and start', {
  skip: process.platform !== 'darwin' || process.env.PF_TEST_LAUNCHD !== '1', timeout: 60000
}, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf-agent-')));
  const plist = join(cwd, `${name}.plist`);
  const domain = `gui/${process.getuid()}`;
  const ctl = (...args) => exec('/bin/launchctl', args);
  const project = { id: 'fixture', cwd, recipe: { timeout: 15000, supervisors: [{ kind: 'launchd', name, plist, shared: false }] } };
  const target = async () => (await observeSupervisors(project, [project], await scan(false)))[0];
  try {
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>90</string></array>
<key>WorkingDirectory</key><string>${cwd}</string><key>ThrottleInterval</key><integer>1</integer></dict></plist>`, { mode: 0o600 });
    await ctl('bootstrap', domain, plist);
    await supervisorTargets(project, [project], true);
    await supervisorAction('start', await target(), project);
    await supervisorAction('pause', await target(), project);
    assert.equal((await target()).state, 'Paused');
    await supervisorAction('resume', await target(), project);
    await supervisorAction('stop', await target(), project);
    assert.equal((await target()).state, 'Stopped');
    await supervisorAction('start', await target(), project);
    assert.equal((await target()).state, 'Running');
    await writeFile(plist, ' ' , { flag: 'a' });
    await assert.rejects(target, error => error.code === 'DENIED');
  } finally {
    await ctl('kill', 'SIGCONT', `${domain}/${name}`).catch(() => {});
    await ctl('bootout', `${domain}/${name}`).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('real Windows Task Scheduler and SCM controls preserve reviewed ownership', {
  skip: process.platform !== 'win32' || process.env.PF_TEST_WINDOWS_SUPERVISORS !== '1', timeout: 120000
}, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pf service ')));
  const script = join(cwd, 'fixture.ps1');
  const exe = join(cwd, 'fixture.exe');
  const source = join(cwd, 'fixture.cs');
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (verb) => exec(ps, ['-NoProfile', '-NonInteractive', '-File', script, verb, name, cwd], { windowsHide: true });
  const project = { id: 'fixture', cwd, recipe: { timeout: 18000, supervisors: [
    { kind: 'task', name: `\\${name}`, shared: false }, { kind: 'scm', name, shared: false }
  ] } };
  const targets = () => observeSupervisors(project, [project], []);
  try {
    await writeFile(source, `using System.ServiceProcess;
class Fixture : ServiceBase {
  public Fixture() { ServiceName = "${name}"; CanPauseAndContinue = true; CanStop = true; }
  protected override void OnStart(string[] args) {}
  protected override void OnPause() {}
  protected override void OnContinue() {}
  protected override void OnStop() {}
  static void Main() { Run(new Fixture()); }
}`);
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await exec(compiler, ['/nologo', `/out:${exe}`, '/r:System.ServiceProcess.dll', source]);
    await copyFile(process.execPath, join(cwd, 'node.exe'));
    await writeFile(script, `param($Verb,$Name,$Root)
$ErrorActionPreference = 'Stop'
if ($Verb -eq 'create') {
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute (Join-Path $Root 'node.exe') -Argument '--version' -WorkingDirectory $Root
  $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal | Out-Null
  $binary = '"' + (Join-Path $Root 'fixture.exe') + '"'
  New-Service -Name $Name -BinaryPathName $binary -StartupType Manual | Out-Null
  $service = Get-CimInstance Win32_Service -Filter "Name='$Name'"
  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ StartName='NT AUTHORITY\\LocalService'; StartPassword='' }
  if ($result.ReturnValue -ne 0) { throw "Service account configuration failed: $($result.ReturnValue)" }
  $access = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl = [IO.Directory]::GetAccessControl($Root)
  $acl.AddAccessRule($access)
  [IO.Directory]::SetAccessControl($Root,$acl)
} else {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  & sc.exe continue $Name | Out-Null
  & sc.exe stop $Name | Out-Null
  & sc.exe delete $Name | Out-Null
}`);
    await run('create');
    for (const policy of project.recipe.supervisors) {
      try { await supervisorTargets({ ...project, supervisorPins: project.supervisorPins ??= {}, recipe: { ...project.recipe, supervisors: [policy] } }, [project], true); }
      catch (error) { error.message = `${policy.kind} enrollment: ${error.message}`; throw error; }
    }
    const act = async (verb, kind) => supervisorAction(verb, (await targets()).find(t => t.kind === kind), project);
    await act('disable', 'task');
    assert.equal((await targets())[0].enabled, false);
    await act('enable', 'task');
    await act('start', 'scm');
    await act('pause', 'scm');
    assert.equal((await targets())[1].state, 'Paused');
    await act('resume', 'scm');
    await act('stop', 'scm');
    assert.equal((await targets())[1].state, 'Stopped');
  } finally {
    await run('delete').catch(() => {});
    await rm(cwd, { recursive: true, force: true, maxRetries: 8 });
  }
});
