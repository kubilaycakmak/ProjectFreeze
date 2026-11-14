import { createInterface } from 'node:readline';
import { problem } from './errors.js';
import { request, waitOperation } from './ipc.js';

const id = { type: 'string' };
const ids = { type: 'array', items: id, minItems: 1, maxItems: 32 };
const identity = { type: 'object', properties: { pid: { type: 'integer', minimum: 2 }, birth: id, boot: id }, required: ['pid', 'birth', 'boot'] };
const recipe = { type: 'object', properties: {
  argv: { type: 'array', items: id, minItems: 1 }, cwd: id, env: { type: 'array', items: id }, dependencies: ids,
  stop: { type: 'array', items: id }, timeout: { type: 'integer', minimum: 100, maximum: 120000 },
  ready: { type: 'object', properties: { address: { enum: ['127.0.0.1', '::1'] }, port: { type: 'integer', minimum: 1, maximum: 65535 } }, required: ['address', 'port'] },
  restart: { enum: ['never', 'on-failure'] }, cgroup: id,
  containers: { type: 'array', items: { type: 'object', properties: { project: id, service: id, shared: { type: 'boolean' } }, required: ['project', 'service', 'shared'] } }
}, required: ['argv', 'cwd'], additionalProperties: false };
const tool = (name, description, properties = {}, required = [], mutation = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: !mutation, destructiveHint: mutation, openWorldHint: false }, mutation
});
const tools = [
  tool('list', 'List projects and live resources in local authorized scope.'),
  tool('discover', 'Find candidate identities and evidence for explicit adoption.'),
  tool('inspect', 'Inspect resource identities, candidates, and recent operations.', { id }, ['id']),
  tool('history', 'Read recent durable operations.'),
  tool('operation', 'Read one operation and its per-resource outcomes.', { id }, ['id']),
  tool('cancel', 'Request cancellation at the next resource boundary.', { id }, ['id'], true),
  tool('adopt', 'Associate reviewed identities with a project. Obtain user approval for the exact set.',
    { cwd: id, members: { type: 'array', items: identity, minItems: 1 }, exclude: { type: 'array', items: identity }, confirm: { const: true }, recipe }, ['cwd', 'members', 'confirm'], true),
  tool('run', 'Launch a reviewed local executable with literal arguments.', { recipe }, ['recipe'], true),
  tool('freeze', 'Suspend owned resources and preserve memory and bound sockets.', { ids }, ['ids'], true),
  tool('resume', 'Release suspensions recorded by ProjectFreeze.', { ids }, ['ids'], true),
  tool('sleep', 'Gracefully stop owned resources. Force requires specific user approval.', { ids, force: { type: 'boolean' } }, ['ids'], true),
  tool('wake', 'Restart from durable launch recipes.', { ids }, ['ids'], true),
  tool('checkpoint', 'Capture process state using a supported local backend.', { ids, backend: { enum: ['criu', 'docker'] } }, ['ids'], true),
  tool('restore', 'Restore a verified local checkpoint.', { ids, checkpoint: id }, ['ids', 'checkpoint'], true),
  tool('reconcile', 'Review durable ownership against the current host state.', { ids }, [], true)
];
const byName = new Map(tools.map(entry => [entry.name, entry]));
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export async function serve() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const active = new Map();
  let initialized = false;
  let negotiated = false;
  const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const rpcError = (id, code, message) => send({ id, error: { code, message } });
  lines.on('close', () => { for (const entry of active.values()) entry.abort.abort(); });
  lines.on('line', raw => {
    let message;
    if (Buffer.byteLength(raw) > 128 * 1024) { rpcError(null, -32600, 'Request exceeds size limit.'); return; }
    try { message = JSON.parse(raw); } catch { rpcError(null, -32700, 'Invalid JSON.'); return; }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { rpcError(null, -32600, 'Invalid request.'); return; }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && negotiated) initialized = true;
      if (method === 'notifications/cancelled') {
        const entry = active.get(params?.requestId);
        entry?.abort.abort();
        if (entry?.operation) void request('cancel', { id: entry.operation }).catch(() => {});
      }
      return;
    }
    if (!['number', 'string'].includes(typeof id)) { rpcError(null, -32600, 'Invalid request ID.'); return; }
    const result = data => send({ id, result: data });
    if (method === 'initialize') {
      if (!params || typeof params.protocolVersion !== 'string' || negotiated) { rpcError(id, -32602, 'Invalid initialize parameters.'); return; }
      negotiated = true;
      result({ protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
        serverInfo: { name: 'projectfreeze', version: '0.1.0-dev.0' }, capabilities: { tools: {} },
        instructions: 'Use discover and inspect before adopting or controlling a project. Obtain specific approval for ambiguous adoption or force termination.' });
      return;
    }
    if (method === 'ping') { result({}); return; }
    if (!initialized) { rpcError(id, -32002, 'Server has not initialized.'); return; }
    if (method === 'tools/list') { result({ tools: tools.map(({ mutation, ...entry }) => entry) }); return; }
    if (method !== 'tools/call') { rpcError(id, -32601, 'Unknown method.'); return; }
    const entry = byName.get(params?.name);
    const input = params?.arguments ?? {};
    if (!entry || !object(input) || Object.keys(input).some(key => !Object.hasOwn(entry.inputSchema.properties, key)) ||
        entry.inputSchema.required.some(key => !Object.hasOwn(input, key))) { rpcError(id, -32602, 'Invalid tool or arguments.'); return; }
    if (active.has(id) || active.size >= 32) { rpcError(id, -32000, 'Too many requests or duplicate request ID.'); return; }
    const context = { abort: new AbortController(), operation: undefined };
    active.set(id, context);
    void (async () => {
      let data = await request(entry.name, input);
      if (entry.mutation && entry.name !== 'cancel') {
        context.operation = data.id;
        if (context.abort.signal.aborted) await request('cancel', { id: data.id }).catch(() => {});
        const token = params?._meta?.progressToken;
        let progress = 0;
        data = await waitOperation(data.id, op => {
          if (!context.abort.signal.aborted && ['string', 'number'].includes(typeof token)) {
            send({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: op.pending ?? op.status } });
          }
        }, context.abort.signal);
      }
      const payload = { schemaVersion: 1, data };
      if (!context.abort.signal.aborted) result({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
        ...(entry.mutation && !['complete', undefined].includes(data.status) ? { isError: true } : {}) });
    })().catch(error => {
      if (!context.abort.signal.aborted) result({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, error: problem(error) }) }] });
    }).finally(() => active.delete(id));
  });
}
