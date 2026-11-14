import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, port] = process.argv.slice(2);
if (mode === 'stop') {
  writeFileSync(join(process.cwd(), 'stop.request'), 'stop');
} else if (mode === 'worker') {
  writeFileSync(join(process.cwd(), 'worker.pid'), String(process.pid));
  setInterval(() => { if (existsSync('stop.request')) process.exit(0); }, 125);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker'], { stdio: 'ignore', windowsHide: true });
  const server = createServer((_, response) => response.end('ready'));
  server.listen(+port, '127.0.0.1');
  const timer = setInterval(() => { if (existsSync('stop.request')) stop(); }, 125);
  function stop() { clearInterval(timer); server.close(); child.unref(); }
  process.on('SIGTERM', stop);
}
