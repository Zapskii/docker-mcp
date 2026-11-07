process.env.API_KEY = 'test-key';
process.env.API_KEY_TESTAGENT = 'agent-key-123';
jest.mock('dockerode');

const request = require('supertest');
const { app } = require('../server');

const AUTH = { 'x-api-key': 'test-key' };

describe('Health check', () => {
  it('returns 200 without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports the server version', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBe('2.13.6');
  });
});

describe('Auth', () => {
  it('rejects requests without API key', async () => {
    const res = await request(app).post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });
});

describe('MCP initialize', () => {
  it('returns Mcp-Session-Id header', async () => {
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1' } } });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeDefined();
    expect(res.body.result.protocolVersion).toBe('2025-03-26');
  });

  it('returns SSE format when Accept includes text/event-stream', async () => {
    const res = await request(app).post('/mcp')
      .set({ ...AUTH, Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1' } } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch('text/event-stream');
    expect(res.text).toMatch(/^data: /);
  });
});

describe('JSON-RPC error status codes (transport vs protocol)', () => {
  it('returns 200 with result:{} for ping (MCP keepalive)', async () => {
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('returns 200 with SSE error envelope for unknown method', async () => {
    const res = await request(app).post('/mcp')
      .set({ ...AUTH, Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('-32601');
    expect(res.headers['content-type']).toMatch('text/event-stream');
  });

  it('returns 200 with JSON error envelope for tool handler failures', async () => {
    const Docker = require('dockerode');
    const mockDocker = Docker.mock.results[0].value;
    mockDocker.getContainer.mockImplementationOnce(() => {
      throw new Error('no such container: missing');
    });
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'missing' } } });
    expect(res.status).toBe(200);
    expect(res.body.error).toEqual({ code: -32603, message: 'no such container: missing' });
  });

  it('propagates a handler error code (e.g. -32000) instead of always -32603', async () => {
    const Docker = require('dockerode');
    const mockDocker = Docker.mock.results[0].value;
    const coded = new Error('recreate in progress for web');
    coded.code = -32000;
    mockDocker.getContainer.mockImplementationOnce(() => { throw coded; });
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 9, method: 'tools/call',
              params: { name: 'docker_container_recreate', arguments: { id: 'web' } } });
    expect(res.status).toBe(200);
    expect(res.body.error).toEqual({ code: -32000, message: 'recreate in progress for web' });
  });

  it('returns 200 with parse error envelope for malformed JSON', async () => {
    const res = await request(app).post('/mcp').set(AUTH)
      .set('Content-Type', 'application/json').send('{"jsonrpc":"2.0",');
    expect(res.status).toBe(200);
    expect(res.body.error).toEqual({ code: -32700, message: expect.any(String) });
  });
});

describe('Notifications', () => {
  it('returns 202 with no body for notifications', async () => {
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
  });
});

describe('parseApiKeys', () => {
  const { parseApiKeys } = require('../server');

  it('maps API_KEY_<NAME> vars to lowercase agent names', () => {
    const keys = parseApiKeys({ API_KEY_CLAUDE: 'k1', API_KEY_CI: 'k2' });
    expect(keys.get('k1')).toBe('claude');
    expect(keys.get('k2')).toBe('ci');
    expect(keys.size).toBe(2);
  });

  it('maps legacy API_KEY to the default agent', () => {
    const keys = parseApiKeys({ API_KEY: 'legacy' });
    expect(keys.get('legacy')).toBe('default');
  });

  it('returns an empty map when no keys are set', () => {
    expect(parseApiKeys({}).size).toBe(0);
  });

  it('authenticates a named key', async () => {
    const res = await request(app).post('/mcp')
      .set({ 'x-api-key': 'agent-key-123' })
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(200);
  });
});

describe('tools/call audit logging', () => {
  it('logs one JSON line with tool name and duration', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_ps', arguments: {} } });
    const line = spy.mock.calls.map(c => c[0]).find(s => typeof s === 'string' && s.includes('"tool":"docker_ps"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line)).toMatchObject({ tool: 'docker_ps', ok: true });
    expect(typeof JSON.parse(line).duration_ms).toBe('number');
    spy.mockRestore();
  });
});

describe('Session TTL sweep', () => {
  const { sessions, sweepSessions } = require('../server');

  it('removes sessions idle beyond 1 hour, keeps fresh ones', () => {
    sessions.set('stale-test', { created: Date.now(), lastSeen: Date.now() - 61 * 60 * 1000 });
    sessions.set('fresh-test', { created: Date.now(), lastSeen: Date.now() });
    sweepSessions();
    expect(sessions.has('stale-test')).toBe(false);
    expect(sessions.has('fresh-test')).toBe(true);
    sessions.delete('fresh-test');
  });

  it('refreshes lastSeen on each authenticated POST', async () => {
    const init = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const sid = init.headers['mcp-session-id'];
    await new Promise(r => setTimeout(r, 10));
    await request(app).post('/mcp').set({ ...AUTH, 'Mcp-Session-Id': sid })
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(sessions.get(sid).lastSeen).toBeGreaterThan(sessions.get(sid).created);
    sessions.delete(sid);
  });
});

describe('agent identity in audit log', () => {
  it('records the authenticated agent name', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/mcp').set({ 'x-api-key': 'agent-key-123' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_ps', arguments: {} } });
    const line = spy.mock.calls.map(c => c[0])
      .find(s => typeof s === 'string' && s.includes('"tool":"docker_ps"'));
    expect(JSON.parse(line)).toMatchObject({ tool: 'docker_ps', agent: 'testagent', ok: true });
    spy.mockRestore();
  });

  it('health reports the number of configured agents', async () => {
    const res = await request(app).get('/health');
    expect(res.body.agents).toBeGreaterThanOrEqual(2); // test-key + agent-key-123
  });
});

describe('JSONL audit log', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  let auditPath;

  beforeEach(() => {
    auditPath = path.join(os.tmpdir(), `audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.AUDIT_LOG = auditPath;
    delete process.env.AUDIT_READ_TOOLS;
  });
  afterEach(() => {
    delete process.env.AUDIT_LOG;
    delete process.env.AUDIT_READ_TOOLS;
  });

  const readLines = () =>
    fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse) : [];

  it('appends one JSONL line per mutating call with key fingerprint and args summary', async () => {
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'abc123' } } });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'docker_remove', ok: true, agent: 'default', key_fp: 'test…-key' });
    expect(lines[0].args.id).toBe('abc123');
    expect(typeof lines[0].ts).toBe('string');
  });

  it('never writes the full API key', async () => {
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'abc123' } } });
    const raw = fs.readFileSync(auditPath, 'utf8');
    expect(raw).not.toContain('test-key');
  });

  it('skips read tools unless AUDIT_READ_TOOLS is set', async () => {
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'docker_ps', arguments: {} } });
    expect(readLines()).toHaveLength(0);
    process.env.AUDIT_READ_TOOLS = '1';
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'docker_ps', arguments: {} } });
    expect(readLines()).toHaveLength(1);
  });

  it('logs errors with ok:false and the message', async () => {
    const Docker = require('dockerode');
    const mockDocker = Docker.mock.results[0].value;
    mockDocker.getContainer.mockImplementationOnce(() => { throw new Error('no such container: gone'); });
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'gone' } } });
    const lines = readLines();
    expect(lines[0].ok).toBe(false);
    expect(lines[0].error).toContain('no such container');
  });

  it('truncates long argument values', async () => {
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_pull', arguments: { image: 'x'.repeat(100) } } });
    const lines = readLines();
    expect(lines[0].args.image.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(lines[0].args.image.endsWith('…')).toBe(true);
  });

  it('warns once (does not fail the call) when the audit file is not writable', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AUDIT_LOG = '/nonexistent-audit-dir/audit.jsonl';
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'abc' } } });
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/\[audit\].*\/nonexistent-audit-dir\/audit\.jsonl is not writable.*DROPPED/);
    spy.mockRestore();
  });

  it('records the confirm flag in the args summary', async () => {
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_remove', arguments: { id: 'abc', confirm: true } } });
    const lines = readLines();
    expect(lines[0].args.confirm).toBe('true');
  });
});

describe('two-phase confirm for destructive tools', () => {
  const Docker = require('dockerode');

  beforeEach(() => {
    process.env.CONFIRM_TOOLS = 'docker_remove,docker_volume_rm';
  });
  afterEach(() => {
    delete process.env.CONFIRM_TOOLS;
    delete process.env.CONFIRM_TTL_S;
  });

  const callRemove = (args, id = 1) =>
    request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id, method: 'tools/call',
              params: { name: 'docker_remove', arguments: args } });

  it('returns a confirm token instead of executing on the first call', async () => {
    const DockerMock = Docker.mock.results[0].value;
    const callsBefore = DockerMock.getContainer.mock.calls.length;
    const res = await callRemove({ id: 'abc' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.result.content[0].text);
    expect(data.confirm_required).toBe(true);
    expect(data.confirm_token).toMatch(/^[0-9a-f]{32}$/);
    expect(data.expires_s).toBe(60);
    expect(res.body.result.structuredContent).toEqual(data);
    expect(DockerMock.getContainer.mock.calls.length).toBe(callsBefore);
  });

  it('executes when the same call is repeated with the token', async () => {
    const first = JSON.parse((await callRemove({ id: 'abc' })).body.result.content[0].text);
    const res = await callRemove({ id: 'abc', confirm_token: first.confirm_token });
    const DockerMock = Docker.mock.results[0].value;
    expect(DockerMock.getContainer).toHaveBeenCalledWith('abc');
    expect(res.body.result.content[0].text).toContain('Removed');
  });

  it('rejects a token bound to different args', async () => {
    const first = JSON.parse((await callRemove({ id: 'abc' })).body.result.content[0].text);
    const DockerMock = Docker.mock.results[0].value;
    const callsBefore = DockerMock.getContainer.mock.calls.length;
    const res = await callRemove({ id: 'OTHER', confirm_token: first.confirm_token }, 2);
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toMatch(/confirm token/i);
    expect(DockerMock.getContainer.mock.calls.length).toBe(callsBefore);
  });

  it('rejects a made-up token', async () => {
    const res = await callRemove({ id: 'abc', confirm_token: 'deadbeef' }, 3);
    expect(res.body.error).toMatchObject({ code: -32000, message: expect.stringMatching(/confirm token/i) });
  });

  it('tokens are single-use', async () => {
    const first = JSON.parse((await callRemove({ id: 'abc' })).body.result.content[0].text);
    await callRemove({ id: 'abc', confirm_token: first.confirm_token }, 2);
    const DockerMock = Docker.mock.results[0].value;
    const callsAfterFirstUse = DockerMock.getContainer.mock.calls.length;
    const res = await callRemove({ id: 'abc', confirm_token: first.confirm_token }, 3);
    expect(res.body.error).toMatchObject({ code: -32000 });
    expect(DockerMock.getContainer.mock.calls.length).toBe(callsAfterFirstUse);
  });

  it('expired tokens are rejected', async () => {
    process.env.CONFIRM_TTL_S = '-1';
    const first = JSON.parse((await callRemove({ id: 'abc' })).body.result.content[0].text);
    const res = await callRemove({ id: 'abc', confirm_token: first.confirm_token }, 2);
    expect(res.body.error).toMatchObject({ code: -32000 });
  });

  it('read tools are unaffected', async () => {
    const res = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'docker_ps', arguments: {} } });
    expect(res.body.result).toBeDefined();
    expect(res.body.result.content[0].text).not.toContain('confirm_token');
  });

  it('unlisted destructive tools are unaffected', async () => {
    process.env.CONFIRM_TOOLS = 'docker_volume_rm';
    const res = await callRemove({ id: 'abc' });
    expect(res.body.result.content[0].text).toContain('Removed');
  });

  it('confirm: true flag does not change the token args binding', async () => {
    const first = JSON.parse((await callRemove({ id: 'abc' })).body.result.content[0].text);
    // The execute call carries confirm:true (required-field pattern) in
    // addition to the token — the token must still match the original args
    const res = await callRemove({ id: 'abc', confirm: true, confirm_token: first.confirm_token }, 2);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.content[0].text).toContain('Removed');
  });
});

describe('GET /mcp', () => {
  it('returns 405 — server-initiated SSE is not offered', async () => {
    const res = await request(app).get('/mcp').set(AUTH);
    expect(res.status).toBe(405);
  });
});

describe('API_KEY env var', () => {
  it('is set in the test environment', () => {
    expect(process.env.API_KEY).toBe('test-key');
  });
});

describe('Request body size limit', () => {
  it('returns 413 for payloads over 1 MB', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list',
                      params: { x: 'a'.repeat(1_100_000) } });
    const res = await request(app).post('/mcp').set(AUTH)
      .set('Content-Type', 'application/json').send(payload);
    expect(res.status).toBe(413);
  });
});

describe('Batch JSON-RPC', () => {
  let sessionId;
  beforeEach(async () => {
    const init = await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1' } } });
    sessionId = init.headers['mcp-session-id'];
  });

  it('processes an array of requests and returns array of responses', async () => {
    const res = await request(app).post('/mcp')
      .set({ ...AUTH, 'Mcp-Session-Id': sessionId })
      .send([
        { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }
      ]);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(10);
    expect(res.body[1].id).toBe(11);
  });

  it('returns 202 for a batch of only notifications', async () => {
    const res = await request(app).post('/mcp')
      .set({ ...AUTH, 'Mcp-Session-Id': sessionId })
      .send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(res.status).toBe(202);
  });
});

describe('docker_login audit redaction', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  let auditPath;

  beforeEach(() => {
    auditPath = path.join(os.tmpdir(), `audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.AUDIT_LOG = auditPath;
    delete process.env.AUDIT_READ_TOOLS;
  });
  afterEach(() => {
    delete process.env.AUDIT_LOG;
    delete process.env.AUDIT_READ_TOOLS;
  });

  it('redacts password-like args from the audit log', async () => {
    const { REGISTRY_AUTH } = require('../server');
    REGISTRY_AUTH.clear();
    await request(app).post('/mcp').set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'docker_login', arguments: { username: 'ci', password: 'super-secret-token' } } });
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines[0].args.password).toBe('[REDACTED]');
    expect(JSON.stringify(lines)).not.toContain('super-secret-token');
    REGISTRY_AUTH.clear();
  });
});

describe('REST /run registry credentials', () => {
  it('passes stored registry creds as authconfig when pre-pulling', async () => {
    const { REGISTRY_AUTH } = require('../server');
    const mockDocker = require('dockerode').mock.results[0].value;
    REGISTRY_AUTH.clear();
    REGISTRY_AUTH.set('registry.example.com', { username: 'ci', password: 'tok' });
    mockDocker.pull.mockImplementationOnce((...args) => {
      args[args.length - 1](null, { on: () => {}, destroy: () => {} });
    });
    mockDocker.modem.followProgress.mockImplementationOnce((stream, cb) => cb(null, []));
    try {
      const res = await request(app).post('/run').set(AUTH)
        .send({ image: 'registry.example.com/team/app:1' });
      expect(res.status).toBe(200);
      expect(mockDocker.pull).toHaveBeenCalledWith(
        'registry.example.com/team/app:1',
        { authconfig: { username: 'ci', password: 'tok', serveraddress: 'https://registry.example.com' } },
        expect.any(Function)
      );
    } finally {
      REGISTRY_AUTH.clear();
    }
  });
});
