import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { bindAddress } from '../src/recipe.js';

const host = bindAddress(process.env.PF_DEMO_HOST ?? '127.0.0.1', process.env.PF_DEMO_PUBLIC === '1');
const port = Number(process.env.PF_DEMO_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PF_DEMO_PORT to an integer from 1 to 65535.');
const publicBind = !['127.0.0.1', '::1'].includes(host);
const handler = (request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  const found = ['GET', 'HEAD'].includes(request.method) && request.url === '/health';
  response.writeHead(found ? 200 : 404);
  response.end(found ? 'ok\n' : 'not found\n');
};
let server;
if (publicBind) {
  const keyPath = process.env.PF_DEMO_TLS_KEY;
  const certPath = process.env.PF_DEMO_TLS_CERT;
  if (!keyPath || !certPath) throw new Error('Public binding requires certificate and private key file references.');
  if (process.platform !== 'win32' && (await stat(keyPath)).mode & 0o077) throw new Error('Restrict the TLS key file to its owner.');
  server = https({ key: await readFile(keyPath), cert: await readFile(certPath), minVersion: 'TLSv1.2' }, handler);
} else server = http(handler);
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.maxHeadersCount = 32;
server.on('connect', (_request, socket) => socket.destroy());
server.on('upgrade', (_request, socket) => socket.destroy());
server.listen({ host, port, exclusive: true });

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
if (process.env.PF_DEMO_STOP_FILE) {
  const timer = setInterval(async () => {
    if (await stat(process.env.PF_DEMO_STOP_FILE).then(() => true, () => false)) { clearInterval(timer); close(); }
  }, 200);
  timer.unref();
}
