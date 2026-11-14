import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';

const port = Number(process.env.PF_DEMO_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PF_DEMO_PORT to an integer from 1 to 65535.');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  const found = ['GET', 'HEAD'].includes(request.method) && request.url === '/health';
  response.writeHead(found ? 200 : 404);
  response.end(found ? 'ok\n' : 'not found\n');
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.maxHeadersCount = 32;
server.on('connect', (_request, socket) => socket.destroy());
server.on('upgrade', (_request, socket) => socket.destroy());
server.listen({ host: '127.0.0.1', port, exclusive: true });

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
if (process.env.PF_DEMO_STOP_FILE) {
  const timer = setInterval(async () => {
    if (await stat(process.env.PF_DEMO_STOP_FILE).then(() => true, () => false)) { clearInterval(timer); close(); }
  }, 200);
  timer.unref();
}
