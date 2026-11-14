import { join } from 'node:path';
import { command, linux, windows } from './platform.js';
import { Fault } from './errors.js';

async function systemdServices() {
  const scopes = ['system', 'user'];
  const results = await Promise.allSettled(scopes.map(async scope => {
    const output = await command('/usr/bin/systemctl', [`--${scope}`, '--no-pager', '--no-legend', '--plain', '--full',
      'list-units', '--type=service', '--state=running'], { timeout: 5000 });
    return output.split('\n').flatMap(line => {
      const match = line.trim().match(/^(\S+\.service)\s+\S+\s+\S+\s+running(?:\s+(.*))?$/);
      return match ? [{ name: match[1], description: match[2], manager: `systemd (${scope})`, pid: null }] : [];
    });
  }));
  const unavailable = scopes.filter((_, index) => results[index].status === 'rejected');
  if (unavailable.length === scopes.length) throw new Fault('UNAVAILABLE', 'No local systemd manager is accessible.');
  return { rows: results.flatMap(result => result.status === 'fulfilled' ? result.value : []), unavailable };
}

export async function localServices() {
  if (linux) return systemdServices();
  if (windows) {
    const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new();
      Get-CimInstance Win32_Service -Filter "State='Running'" | Select-Object Name,DisplayName,ProcessId | ForEach-Object { $_ | ConvertTo-Json -Compress }`;
    const output = await command(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    return { rows: output.split(/\r?\n/).filter(Boolean).map(line => {
      const row = JSON.parse(line);
      return { name: row.Name, description: row.DisplayName, manager: 'Windows SCM', pid: row.ProcessId || null };
    }), unavailable: [] };
  }
  const output = await command('/bin/launchctl', ['list']);
  return { rows: output.split('\n').flatMap(line => {
    const [pid, , name] = line.trim().split(/\s+/);
    return /^\d+$/.test(pid) && +pid > 0 && name ? [{ name, manager: 'launchd (current domain)', pid: +pid }] : [];
  }), unavailable: [] };
}
