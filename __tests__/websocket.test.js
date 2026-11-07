process.env.API_KEY = 'test-key';
jest.mock('dockerode');

const http = require('http');
const { Readable } = require('stream');
const WebSocket = require('ws');
const Docker = require('dockerode');
const { setupLogWebSocket } = require('../server');

const TEST_KEY = 'test-key';
const FAKE_CID = 'abc123def456';

// Single Docker instance created at server.js module load
const mockDocker = Docker.mock.results[0].value;
const defaultDemux = mockDocker.modem.demuxStream;

// The shared mock's demuxStream just ends its outputs. These tests substitute a
// piping implementation so the log stream's bytes actually reach the handler's
// `out` PassThrough (demux framing itself is docker-modem's job, not ours).
const pipeDemux = (stream, out, err) => { stream.pipe(out); stream.pipe(err); };

function makeReadable(text) {
  const s = new Readable();
  s.push(text);
  s.push(null);
  return s;
}

// Mock getContainer to behave like the real daemon: only the expected id exists.
// Unknown ids surface as a rejected logs() promise (dockerode's HTTP 404), not a
// synchronous throw — the server's .catch path is what must handle them.
function stubKnownContainer(containerId) {
  mockDocker.getContainer.mockImplementation((id) => {
    if (id !== containerId) {
      return { logs: jest.fn().mockRejectedValue(new Error(`no such container: ${id}`)) };
    }
    return { logs: jest.fn().mockResolvedValue(makeReadable('hello-log-line\n')) };
  });
}

let server;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer();
    setupLogWebSocket(server);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Run one ws client session and collect what happens to it
function wsSession(url, { headers = { 'x-api-key': TEST_KEY }, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const result = { messages: [], closeCode: null, statusCode: null, error: null };
    const done = () => { clearTimeout(timer); try { ws.terminate(); } catch {} resolve(result); };
    const timer = setTimeout(done, timeoutMs);
    ws.on('message', d => result.messages.push(d.toString()));
    ws.on('close', code => { result.closeCode = code; done(); });
    ws.on('error', e => { result.error = e.message; done(); });
    ws.on('unexpected-response', (req, res) => { result.statusCode = res.statusCode; done(); });
  });
}

// Connect and resolve with the first message received, then close the client
function firstMessage(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-api-key': TEST_KEY } });
    const fail = (e) => { clearTimeout(timer); try { ws.terminate(); } catch {} reject(e); };
    const timer = setTimeout(() => fail(new Error('timed out waiting for first ws message')), timeoutMs);
    ws.on('message', d => {
      clearTimeout(timer);
      const text = d.toString();
      ws.close();
      ws.on('close', () => resolve(text));
    });
    ws.on('error', fail);
    ws.on('unexpected-response', (req, res) => fail(new Error(`unexpected HTTP ${res.statusCode}`)));
  });
}

beforeAll(() => {
  // keep jest output pristine — the handler logs each connection
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
});

afterEach(async () => {
  mockDocker.modem.demuxStream.mockImplementation(defaultDemux);
  if (server) {
    const s = server;
    server = null;
    await new Promise(r => s.close(r));
    if (s.closeAllConnections) s.closeAllConnections();
  }
});

describe('WebSocket /logs streaming', () => {
  test('sub-path connect /logs/<id> with valid key streams log lines', async () => {
    const port = await startServer();
    stubKnownContainer(FAKE_CID);
    mockDocker.modem.demuxStream.mockImplementation(pipeDemux);

    const first = await firstMessage(`ws://127.0.0.1:${port}/logs/${FAKE_CID}`);

    expect(first).toContain('hello-log-line');
  });

  test('query connect /logs?container=<id> streams log lines (same as sub-path)', async () => {
    const port = await startServer();
    stubKnownContainer(FAKE_CID);
    mockDocker.modem.demuxStream.mockImplementation(pipeDemux);

    const first = await firstMessage(`ws://127.0.0.1:${port}/logs?container=${FAKE_CID}`);

    expect(first).toContain('hello-log-line');
  });

  test('missing/invalid key is rejected with 401 before upgrade', async () => {
    const port = await startServer();

    const badKey = await wsSession(`ws://127.0.0.1:${port}/logs/${FAKE_CID}`, { headers: { 'x-api-key': 'wrong-key' } });
    expect(badKey.statusCode).toBe(401);
    expect(badKey.messages).toEqual([]);

    const noKey = await wsSession(`ws://127.0.0.1:${port}/logs/${FAKE_CID}`, { headers: {} });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.messages).toEqual([]);
  });

  test('non-/logs path is rejected with 404 before auth', async () => {
    const port = await startServer();

    const result = await wsSession(`ws://127.0.0.1:${port}/other`);

    expect(result.statusCode).toBe(404);
    expect(result.messages).toEqual([]);
  });

  test('/logs with no id (neither sub-path nor query) is rejected with close 1008', async () => {
    const port = await startServer();
    mockDocker.getContainer.mockImplementation((id) => {
      throw new Error(`no such container: ${id}`);
    });

    const result = await wsSession(`ws://127.0.0.1:${port}/logs`);

    expect(result.messages).toEqual([]); // never reaches a container
    expect(result.closeCode).toBe(1008);
  });

  test('unknown container id sends Error then closes', async () => {
    const port = await startServer();
    stubKnownContainer(FAKE_CID);

    const result = await wsSession(`ws://127.0.0.1:${port}/logs/ghost-container`);

    expect(result.messages[0]).toContain('Error:');
    expect(result.messages[0]).toContain('no such container: ghost-container');
    expect(result.closeCode).not.toBeNull();
  });
});
