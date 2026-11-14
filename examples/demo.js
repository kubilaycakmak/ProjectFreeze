import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), 'pf-demo-'));
const cli = fileURLToPath(new URL('../bin/projectfreeze.js', import.meta.url));
const worker = fileURLToPath(new URL('./workload.js', import.meta.url));
const marker = join(base, 'stop');
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const env = { ...process.env, PROJECTFREEZE_HOME: join(base, 'state'), PF_DEMO_PORT: String(port), PF_DEMO_STOP_FILE: marker };
const recipe = join(base, 'recipe.json');
const start = [process.execPath, worker];
const stop = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "stop")', marker];
await writeFile(join(base, 'package.json'), '{}');
await writeFile(recipe, JSON.stringify({ cwd: base, argv: start, stop, env: ['PF_DEMO_PORT', 'PF_DEMO_STOP_FILE'],
  ready: { address: '127.0.0.1', port } }));
const run = async (...args) => {
  const result = await exec(process.execPath, [cli, '--json', ...args], { env, windowsHide: true }).catch(error => error);
  const reply = JSON.parse(result.stdout);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error ?? reply.data));
  return reply.data;
};
let id;
try {
  console.log(`Discovery found ${(await run('discover')).length} candidate project(s) before managed launch.`);
  ({ projects: [id] } = await run('run', '--recipe', recipe));
  console.log(`Launch ${id} ${JSON.stringify((await run('inspect', id)).ports)}`);
  for (const command of ['freeze', 'resume', 'sleep', 'wake', 'sleep']) {
    if (command === 'wake') await unlink(marker);
    console.log(`${command} ${(await run(command, id)).status}`);
  }
} finally {
  if (id) {
    await run('resume', id).catch(() => {});
    await run('sleep', id).catch(() => {});
  }
  await run('daemon', 'stop').catch(() => {});
  await delay(500);
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
}
