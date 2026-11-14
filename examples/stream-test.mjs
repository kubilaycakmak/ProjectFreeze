import { createServer } from 'node:http';
import { access, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const [mode, path, recipePort] = process.argv.slice(2);
if (mode === '--stop') {
  await writeFile(path, '', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
} else if (mode === '--recipe') {
  const file = resolve(path);
  const cwd = dirname(file);
  const port = parsePort(recipePort ?? 8788, 1);
  const script = fileURLToPath(import.meta.url);
  const marker = join(cwd, `.stream-stop-${port}`);
  const recipe = { cwd, argv: [process.execPath, script, String(port), marker], stop: [process.execPath, script, '--stop', marker],
    ready: { address: host, port }, timeout: 12000 };
  await writeFile(file, `${JSON.stringify(recipe, null, 2)}\n`, { flag: 'wx' });
  console.log(file);
} else {
  await serve(parsePort(mode ?? 8788, 0), path);
}

function parsePort(value, minimum) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < minimum || port > 65535) throw new RangeError(`Pass a TCP port between ${minimum} and 65535.`);
  return port;
}

async function serve(port, marker) {
  let count = 0;
  let closing = false;
  const clients = new Set();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/stream') {
      response.writeHead(404).end('Use GET /stream.\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    clients.add(response);
    response.on('close', () => clients.delete(response));
  });
  const timer = setInterval(() => {
    const line = `#${++count} ${new Date().toISOString()} PID=${process.pid}\n`;
    for (const client of clients) if (!client.writableNeedDrain) client.write(line);
  }, 1000);
  timer.unref();
  const watch = marker && setInterval(async () => {
    if (await access(marker).then(() => true, () => false)) close();
  }, 150);
  watch?.unref();

  server.once('error', error => {
    console.error(`Could not listen on ${host}:${port} (${error.code ?? error.message}).`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`PID=${process.pid} http://${host}:${server.address().port}/stream`));
  function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    clearInterval(watch);
    for (const client of clients) client.end();
    server.close(async () => {
      if (marker) await unlink(marker).catch(error => { if (error.code !== 'ENOENT') process.exitCode = 1; });
    });
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
