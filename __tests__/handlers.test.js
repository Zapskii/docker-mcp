process.env.API_KEY = 'test-key';
jest.mock('dockerode');

const Docker = require('dockerode');
const { handleMCPTool, MCP_TOOLS, RECREATE_LOCKS, REGISTRY_AUTH } = require('../server');

// server.js calls `new Docker(...)` at module load — that's results[0].value.
// The mock returns a plain object (not `this`), so mock.instances[0] is empty;
// mock.results[0].value holds the actual object with all mock methods.
let mockDocker;
let factoryDefaultContainer; // the factory's mockContainer — captured before any stubbing
beforeAll(() => {
  mockDocker = Docker.mock.results[0].value;
  factoryDefaultContainer = mockDocker.getContainer();
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe('docker_image_prune', () => {
  it('prunes only dangling images when all=false', async () => {
    await handleMCPTool('docker_image_prune', { all: false });
    expect(mockDocker.pruneImages).toHaveBeenCalledWith(
      { filters: { dangling: { 'true': true } } }
    );
  });

  it('prunes all unused images when all=true', async () => {
    await handleMCPTool('docker_image_prune', { all: true });
    expect(mockDocker.pruneImages).toHaveBeenCalledWith(
      { filters: { dangling: ['false'] } }
    );
  });
});

describe('docker_volume_ls', () => {
  it('returns empty array when Docker returns Volumes: null', async () => {
    mockDocker.listVolumes.mockResolvedValueOnce({ Volumes: null });
    const result = await handleMCPTool('docker_volume_ls', {});
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });
});

describe('docker_stats', () => {
  it('reports memory in MiB for single container', async () => {
    const result = await handleMCPTool('docker_stats', { id: 'mycontainer' });
    expect(result.content[0].text).toContain('100.00MiB');
    expect(result.content[0].text).toContain('1024.00MiB');
  });

  it('reports memory in MiB in the all-containers path', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([{ Id: 'abc', Names: ['/web'] }]);
    mockDocker.getContainer.mockReturnValueOnce({
      stats: jest.fn().mockResolvedValue({
        cpu_stats:    { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
        precpu_stats: { cpu_usage: { total_usage: 900  }, system_cpu_usage: 9000  },
        memory_stats: { usage: 104857600, limit: 1073741824 }
      })
    });
    const result = await handleMCPTool('docker_stats', {});
    expect(result.content[0].text).toContain('1024.00MiB');
  });

  it('scales CPU% by online_cpus like docker stats', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      stats: jest.fn().mockResolvedValue({
        cpu_stats:    { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 900  }, system_cpu_usage: 9000 },
        memory_stats: { usage: 104857600, limit: 1073741824 }
      })
    });
    const result = await handleMCPTool('docker_stats', { id: 'mycontainer' });
    expect(result.content[0].text).toContain('CPU: 40.00%');
  });
});

describe('docker_exec', () => {
  it('includes exit code 0 in result', async () => {
    const result = await handleMCPTool('docker_exec', { id: 'mycontainer', command: ['echo', 'hi'] });
    expect(result.content[0].text).toContain('Exit code: 0');
  });

  it('includes non-zero exit code when command fails', async () => {
    const { Readable } = require('stream');
    mockDocker.getContainer.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue({
        start:   jest.fn().mockResolvedValue(Readable.from([])),
        inspect: jest.fn().mockResolvedValue({ ExitCode: 127 })
      })
    });
    const result = await handleMCPTool('docker_exec', { id: 'mycontainer', command: ['notacommand'] });
    expect(result.content[0].text).toContain('Exit code: 127');
  });
});

describe('healthcheck params', () => {
  it('maps healthcheck to Healthconfig on docker_run', async () => {
    await handleMCPTool('docker_run', {
      image: 'alpine', pull: false, name: 'hc1',
      healthcheck: { test: 'curl -f http://localhost', interval_s: 30, timeout_s: 5, retries: 3, start_period_s: 10 }
    });
    const cfg = mockDocker.createContainer.mock.calls[0][0];
    expect(cfg.Healthcheck).toEqual({
      Test: ['CMD-SHELL', 'curl -f http://localhost'],
      Interval: 30e9, Timeout: 5e9, Retries: 3, StartPeriod: 10e9
    });
  });

  it('accepts test as an array (exec form) and omits unset fields', async () => {
    await handleMCPTool('docker_run', {
      image: 'alpine', pull: false,
      healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost'], interval_s: 15 }
    });
    const cfg = mockDocker.createContainer.mock.calls[0][0];
    expect(cfg.Healthcheck).toEqual({ Test: ['CMD', 'curl', '-f', 'http://localhost'], Interval: 15e9 });
  });

  it('leaves Healthcheck off docker_run when not requested', async () => {
    await handleMCPTool('docker_run', { image: 'alpine', pull: false });
    const cfg = mockDocker.createContainer.mock.calls[0][0];
    expect(cfg.Healthcheck).toBeUndefined();
  });

  it('docker_container_update rejects healthcheck (the update API ignores it)', async () => {
    await expect(handleMCPTool('docker_container_update', { id: 'c1', healthcheck: { test: 'true', interval_s: 15 } }))
      .rejects.toThrow(/nothing to update/i);
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });

  it('container_update still errors when nothing is given', async () => {
    await expect(handleMCPTool('docker_container_update', { id: 'c1' })).rejects.toThrow(/nothing to update/i);
  });

  it('schemas document the healthcheck object', () => {
    const run = MCP_TOOLS.find(x => x.name === 'docker_run').inputSchema;
    expect(run.properties.healthcheck).toBeDefined();
    expect(run.properties.healthcheck.properties.test).toBeDefined();
    const upd = MCP_TOOLS.find(x => x.name === 'docker_container_update').inputSchema;
    expect(upd.properties.healthcheck).toBeUndefined();
  });
});

describe('docker_run pull option', () => {
  it('skips pull when pull=false', async () => {
    await handleMCPTool('docker_run', { image: 'nginx', pull: false });
    expect(mockDocker.pull).not.toHaveBeenCalled();
  });

  it('pulls by default when pull is not specified', async () => {
    await handleMCPTool('docker_run', { image: 'nginx' });
    expect(mockDocker.pull).toHaveBeenCalledWith('nginx', expect.any(Function));
  });

  it('returns a job_id for mode=async instead of starting synchronously', async () => {
    const result = await handleMCPTool('docker_run', { image: 'nginx', pull: false, mode: 'async' });
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBeDefined();
    expect(data.type).toBe('run');
  });

  it('passes stored registry creds as authconfig when pre-pulling', async () => {
    REGISTRY_AUTH.clear();
    await handleMCPTool('docker_login', {
      registry: 'registry.example.com', username: 'ci', password: 'tok'
    });
    mockDocker.pull.mockImplementationOnce((...args) => {
      args[args.length - 1](null, { on: () => {}, destroy: () => {} });
    });
    mockDocker.modem.followProgress.mockImplementationOnce((stream, cb) => cb(null, []));
    try {
      await handleMCPTool('docker_run', { image: 'registry.example.com/team/app:1' });
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

describe('docker_container_prune', () => {
  it('prunes stopped containers and returns result', async () => {
    mockDocker.pruneContainers.mockResolvedValueOnce(
      { ContainersDeleted: ['abc123', 'def456'], SpaceReclaimed: 2048 }
    );
    const result = await handleMCPTool('docker_container_prune', {});
    expect(mockDocker.pruneContainers).toHaveBeenCalled();
    expect(result.content[0].text).toContain('abc123');
    expect(result.content[0].text).toContain('SpaceReclaimed');
  });
});

describe('docker_rename', () => {
  it('renames a container', async () => {
    const result = await handleMCPTool('docker_rename', { id: 'oldname', name: 'newname' });
    expect(mockDocker.getContainer).toHaveBeenCalledWith('oldname');
    expect(mockDocker.getContainer().rename).toHaveBeenCalledWith({ name: 'newname' });
    expect(result.content[0].text).toContain('newname');
  });
});

describe('docker_system_info', () => {
  it('returns daemon version, CPU and storage info', async () => {
    const result = await handleMCPTool('docker_system_info', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.version).toBe('24.0.0');
    expect(data.cpus).toBe(4);
    expect(data.storageDriver).toBe('overlay2');
    expect(data.memory).toContain('GB');
  });
});

describe('docker_image_tag', () => {
  it('tags an image with repo and tag', async () => {
    const result = await handleMCPTool('docker_image_tag', { source: 'nginx:latest', repo: 'myrepo/nginx', tag: 'v1' });
    expect(mockDocker.getImage).toHaveBeenCalledWith('nginx:latest');
    expect(mockDocker.getImage().tag).toHaveBeenCalledWith({ repo: 'myrepo/nginx', tag: 'v1' });
    expect(result.content[0].text).toContain('myrepo/nginx:v1');
  });

  it('defaults to tag=latest when tag is omitted', async () => {
    await handleMCPTool('docker_image_tag', { source: 'nginx', repo: 'myrepo/nginx' });
    expect(mockDocker.getImage().tag).toHaveBeenCalledWith({ repo: 'myrepo/nginx', tag: 'latest' });
  });
});

describe('docker_network_connect', () => {
  it('connects a container to a network', async () => {
    const result = await handleMCPTool('docker_network_connect', { network: 'mynet', container: 'myapp' });
    expect(mockDocker.getNetwork).toHaveBeenCalledWith('mynet');
    expect(mockDocker.getNetwork().connect).toHaveBeenCalledWith({ Container: 'myapp' });
    expect(result.content[0].text).toContain('myapp');
    expect(result.content[0].text).toContain('mynet');
  });
});

describe('docker_network_disconnect', () => {
  it('disconnects a container from a network', async () => {
    const result = await handleMCPTool('docker_network_disconnect', { network: 'mynet', container: 'myapp' });
    expect(mockDocker.getNetwork().disconnect).toHaveBeenCalledWith({ Container: 'myapp' });
    expect(result.content[0].text).toContain('myapp');
    expect(result.content[0].text).toContain('mynet');
  });
});

describe('docker_copy', () => {
  it('exports a path from a container as base64 tar', async () => {
    const result = await handleMCPTool('docker_copy', {
      id: 'mycontainer', direction: 'from', container_path: '/etc/hosts'
    });
    expect(mockDocker.getContainer).toHaveBeenCalledWith('mycontainer');
    expect(mockDocker.getContainer().getArchive).toHaveBeenCalledWith({ path: '/etc/hosts' });
    expect(result.content[0].text).toContain(Buffer.from('fake-tar').toString('base64'));
  });

  it('imports base64 tar content into a container', async () => {
    const content = Buffer.from('fake-tar').toString('base64');
    const result = await handleMCPTool('docker_copy', {
      id: 'mycontainer', direction: 'to', container_path: '/tmp', content
    });
    expect(mockDocker.getContainer().putArchive).toHaveBeenCalled();
    expect(result.content[0].text).toContain('/tmp');
    expect(result.content[0].text).toContain('mycontainer');
  });

  it('throws when content is missing for direction=to', async () => {
    await expect(
      handleMCPTool('docker_copy', { id: 'mycontainer', direction: 'to', container_path: '/tmp' })
    ).rejects.toThrow('content is required');
  });
});

describe('docker_logs (dockerode 4.x returns a Buffer, not a stream)', () => {
  // Docker multiplexed stream framing: 8-byte header per chunk —
  // [streamType, 0, 0, 0, size uint32BE], streamType: 0=stdin 1=stdout 2=stderr.
  function muxFrame(streamType, text) {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  it('demuxes stdout/stderr frames from a Buffer response', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      logs: jest.fn().mockResolvedValue(Buffer.concat([
        muxFrame(1, 'hello stdout\n'),
        muxFrame(2, 'hello stderr\n'),
        muxFrame(1, 'more stdout\n'),
      ]))
    });
    const result = await handleMCPTool('docker_logs', { id: 'mycontainer' });
    // stdout frames first, then stderr — header bytes stripped
    expect(result.content[0].text).toBe('hello stdout\nmore stdout\nhello stderr\n');
  });

  it('returns plain text unframed output unchanged', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      logs: jest.fn().mockResolvedValue(Buffer.from('plain log line\n'))
    });
    const result = await handleMCPTool('docker_logs', { id: 'mycontainer' });
    expect(result.content[0].text).toBe('plain log line\n');
  });
});

describe('docker_logs since/until/timestamps', () => {
  function logsMock() {
    const logs = jest.fn().mockResolvedValue(Buffer.from('log line\n'));
    mockDocker.getContainer.mockReturnValueOnce({ logs });
    return logs;
  }

  it('parses a duration like 10m into a unix epoch `since`', async () => {
    const logs = logsMock();
    const before = Date.now();
    await handleMCPTool('docker_logs', { id: 'c', since: '10m' });
    const opts = logs.mock.calls[0][0];
    expect(opts.since).toBeGreaterThanOrEqual(Math.floor((before - 10 * 60 * 1000) / 1000) - 1);
    expect(opts.since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('parses RFC3339 timestamps for since/until', async () => {
    const logs = logsMock();
    await handleMCPTool('docker_logs', {
      id: 'c',
      since: '2026-09-04T00:00:00Z',
      until: '2026-09-04T01:00:00Z'
    });
    const opts = logs.mock.calls[0][0];
    expect(opts.since).toBe(Date.parse('2026-09-04T00:00:00Z') / 1000);
    expect(opts.until).toBe(Date.parse('2026-09-04T01:00:00Z') / 1000);
  });

  it('passes timestamps through', async () => {
    const logs = logsMock();
    await handleMCPTool('docker_logs', { id: 'c', timestamps: true, since: '1h' });
    const opts = logs.mock.calls[0][0];
    expect(opts.timestamps).toBe(true);
    expect(opts.since).toBeGreaterThan(0);
  });

  it('omits since/until/timestamps when not requested', async () => {
    const logs = logsMock();
    await handleMCPTool('docker_logs', { id: 'c', tail: 5 });
    const opts = logs.mock.calls[0][0];
    expect(opts.since).toBeUndefined();
    expect(opts.until).toBeUndefined();
    expect(opts.timestamps).toBeUndefined();
  });

  it('rejects an unparseable since value', async () => {
    await expect(
      handleMCPTool('docker_logs', { id: 'c', since: 'not-a-time' })
    ).rejects.toThrow(/since/i);
  });
});

describe('docker_logs response size guard', () => {
  const LOG_MAX = process.env.LOG_MAX_BYTES;
  afterEach(() => {
    if (LOG_MAX === undefined) delete process.env.LOG_MAX_BYTES;
    else process.env.LOG_MAX_BYTES = LOG_MAX;
  });

  it('caps huge log output at the default 64 KB with a truncation notice', async () => {
    const big = 'x'.repeat(200_000);
    mockDocker.getContainer.mockReturnValueOnce({
      logs: jest.fn().mockResolvedValue(Buffer.from(big))
    });
    const result = await handleMCPTool('docker_logs', { id: 'noisy' });
    const text = result.content[0].text;
    expect(text).toContain('[truncated ');
    expect(text).toContain(`of ${Buffer.byteLength(big)} bytes]`);
    expect(Buffer.byteLength(text)).toBeLessThan(200_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(65_000);
  });

  it('respects the LOG_MAX_BYTES override', async () => {
    process.env.LOG_MAX_BYTES = '100';
    mockDocker.getContainer.mockReturnValueOnce({
      logs: jest.fn().mockResolvedValue(Buffer.from('y'.repeat(5000)))
    });
    const result = await handleMCPTool('docker_logs', { id: 'noisy' });
    const text = result.content[0].text;
    expect(Buffer.byteLength(text.split('\n... [truncated')[0])).toBeLessThanOrEqual(100);
    expect(text).toContain('[truncated');
  });

  it('leaves small logs untouched', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      logs: jest.fn().mockResolvedValue(Buffer.from('tiny log\n'))
    });
    const result = await handleMCPTool('docker_logs', { id: 'quiet' });
    expect(result.content[0].text).toBe('tiny log\n');
  });
});

describe('docker_volume_ls in_use_by', () => {
  it('maps mounting container names onto each volume', async () => {
    mockDocker.modem.dial.mockImplementationOnce((opts, cb) =>
      cb(null, { Volumes: [{ Name: 'app_data', UsageData: { Size: 1024 } }] }));
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c1', Names: ['/webui'] },
      { Id: 'c2', Names: ['/webapp'] }
    ]);
    mockDocker.getContainer
      .mockReturnValueOnce({
        inspect: jest.fn().mockResolvedValue({
          Name: '/webui',
          Mounts: [
            { Type: 'volume', Name: 'app_data' },
            { Type: 'bind', Name: null, Source: '/srv' }
          ]
        })
      })
      .mockReturnValueOnce({
        inspect: jest.fn().mockResolvedValue({
          Name: '/webapp',
          Mounts: [{ Type: 'bind', Name: null, Source: '/srv/webapp' }]
        })
      });
    const result = await handleMCPTool('docker_volume_ls', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].in_use_by).toEqual(['webui']);
  });

  it('returns an empty in_use_by for unused volumes', async () => {
    mockDocker.modem.dial.mockImplementationOnce((opts, cb) =>
      cb(null, { Volumes: [{ Name: 'orphan' }] }));
    mockDocker.listContainers.mockResolvedValueOnce([]);
    const result = await handleMCPTool('docker_volume_ls', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].in_use_by).toEqual([]);
  });
});

describe('docker_images repo digests', () => {
  it('includes the registry digest (RepoDigests) per image', async () => {
    mockDocker.listImages.mockResolvedValueOnce([{
      Id: 'sha256:abc123', RepoTags: ['nginx:latest'], Size: 1048576,
      RepoDigests: ['nginx@sha256:deadbeef']
    }]);
    const result = await handleMCPTool('docker_images', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].digests).toEqual(['nginx@sha256:deadbeef']);
  });
});

describe('docker_wait', () => {
  it('is exposed in tools/list with condition + timeout_s', () => {
    const t = MCP_TOOLS.find(x => x.name === 'docker_wait');
    expect(t).toBeDefined();
    expect(t.inputSchema.properties.condition.enum).toEqual(['healthy', 'next-exit']);
    expect(t.inputSchema.required).toContain('timeout_s');
  });

  it('returns the state once the container reports healthy', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
      })
    });
    const result = await handleMCPTool('docker_wait', { id: 'web', condition: 'healthy', timeout_s: 5 });
    const data = JSON.parse(result.content[0].text);
    expect(data.satisfied).toBe(true);
    expect(data.state.health).toBe('healthy');
  });

  it('returns the state once the container exits (next-exit)', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        State: { Running: false, Status: 'exited', ExitCode: 0 }
      })
    });
    const result = await handleMCPTool('docker_wait', { id: 'web', condition: 'next-exit', timeout_s: 5 });
    const data = JSON.parse(result.content[0].text);
    expect(data.satisfied).toBe(true);
    expect(data.state.exit_code).toBe(0);
  });

  it('rejects with a timeout error when the condition is never met', async () => {
    jest.useFakeTimers();
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        State: { Running: true, Health: { Status: 'starting' } }
      })
    });
    const p = handleMCPTool('docker_wait', { id: 'web', condition: 'healthy', timeout_s: 3 });
    const expectation = expect(p).rejects.toThrow(/timed out.*healthy/);
    await jest.advanceTimersByTimeAsync(3500);
    await expectation;
    jest.useRealTimers();
  });

  it('refuses to wait for healthy on a container without a healthcheck', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({ State: { Running: true } })
    });
    await expect(
      handleMCPTool('docker_wait', { id: 'web', condition: 'healthy', timeout_s: 5 })
    ).rejects.toThrow(/no healthcheck/i);
  });

  it('requires a timeout', async () => {
    await expect(
      handleMCPTool('docker_wait', { id: 'web', condition: 'next-exit' })
    ).rejects.toThrow(/timeout_s is required/i);
  });
});

describe('structured output', () => {
  it('JSON tools carry structuredContent mirroring the text payload', async () => {
    for (const [tool, args] of [
      ['docker_ps', { all: true }],
      ['docker_images', {}],
      ['docker_compose_ps', { project: 'myapp' }],
      ['docker_system_df', {}],
      ['docker_outdated', {}],
      ['docker_system_info', {}]
    ]) {
      const result = await handleMCPTool(tool, args);
      expect(result.structuredContent).toBeDefined();
      // MCP clients reject a structuredContent that is not an object
      expect(Array.isArray(result.structuredContent)).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(result.structuredContent).toEqual(Array.isArray(parsed) ? { items: parsed } : parsed);
    }
  });
});

describe('docker_container_update', () => {
  it('is exposed in tools/list', async () => {
    expect(MCP_TOOLS.some(t => t.name === 'docker_container_update')).toBe(true);
  });

  it('applies restart policy via container.update', async () => {
    const update = jest.fn().mockResolvedValue({ Warnings: [] });
    mockDocker.getContainer.mockReturnValueOnce({ update });
    const result = await handleMCPTool('docker_container_update', {
      id: 'mycontainer', restartPolicy: 'always'
    });
    expect(update).toHaveBeenCalledWith({ RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } });
    expect(result.content[0].text).toContain('Updated');
  });

  it('maps no/none to the no-restart policy', async () => {
    const update = jest.fn().mockResolvedValue({ Warnings: [] });
    mockDocker.getContainer.mockReturnValueOnce({ update });
    await handleMCPTool('docker_container_update', {
      id: 'mycontainer', restartPolicy: 'no'
    });
    expect(update).toHaveBeenCalledWith({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } });
  });

  it('rejects an invalid restart policy', async () => {
    await expect(
      handleMCPTool('docker_container_update', { id: 'mycontainer', restartPolicy: 'bogus' })
    ).rejects.toThrow('Invalid restart policy');
  });
});

describe('docker_run restartPolicy', () => {
  it('passes RestartPolicy to createContainer', async () => {
    await handleMCPTool('docker_run', {
      image: 'alpine', restartPolicy: 'always'
    });
    const call = mockDocker.createContainer.mock.calls[0][0];
    expect(call.HostConfig.RestartPolicy).toEqual({ Name: 'always', MaximumRetryCount: 0 });
  });

  it('rejects an invalid restart policy', async () => {
    await expect(
      handleMCPTool('docker_run', { image: 'alpine', restartPolicy: 'bogus' })
    ).rejects.toThrow('Invalid restart policy');
  });
});

describe('docker_container_prune filters', () => {
  it('until and label filters resolve candidates and remove individually', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'aaa', Names: ['/stale'], State: 'exited', Status: 'Exited (0) 2 days ago',
        Created: Math.floor(Date.now() / 1000) - 48 * 3600, Labels: {} }
    ]);
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_container_prune', { filters: { until: '24h', label: 'keep-me' } });
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('dry_run lists matching stopped containers and prunes nothing', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'aaa', Names: ['/stale-one'], State: 'exited', Status: 'Exited (0) 2 days ago' },
      { Id: 'bbb', Names: ['/keepme'], State: 'exited', Status: 'Exited (0) 3 hours ago' }
    ]);
    const result = await handleMCPTool('docker_container_prune', {
      dry_run: true, filters: { name: 'stale' }
    });
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data.dry_run).toBe(true);
    expect(data.would_remove).toHaveLength(1);
    expect(data.would_remove[0].name).toBe('stale-one');
  });

  it('removes name-matched containers individually on a real prune', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'aaa', Names: ['/stale-one'], State: 'exited', Status: 'Exited (0) 2 days ago' },
      { Id: 'bbb', Names: ['/keepme'], State: 'exited', Status: 'Exited (0) 3 hours ago' }
    ]);
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ remove });
    const result = await handleMCPTool('docker_container_prune', { filters: { name: 'stale' } });
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data.ContainersDeleted).toEqual(['aaa']);
  });

  it('keeps the no-filter behavior unchanged', async () => {
    await handleMCPTool('docker_container_prune', {});
    expect(mockDocker.pruneContainers).toHaveBeenCalledWith();
  });
});

describe('docker_image_prune filters', () => {
  it('until and label filters resolve candidates and remove individually', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockDocker.listImages.mockResolvedValueOnce([
      { Id: 'img-old', RepoTags: [], Created: now - 48 * 3600, Labels: {} },
      { Id: 'img-new', RepoTags: [], Created: now - 3600, Labels: {} }
    ]);
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getImage.mockReturnValueOnce({ remove });
    const result = await handleMCPTool('docker_image_prune', { filters: { until: '24h' } });
    expect(mockDocker.pruneImages).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    const data = JSON.parse(result.content[0].text);
    expect(data.ImagesDeleted).toEqual(['img-old']);
  });

  it('dry_run lists dangling images matching name and until', async () => {
    mockDocker.listImages.mockResolvedValueOnce([
      { Id: 'img-old', RepoTags: [], Created: Math.floor(Date.now() / 1000) - 48 * 3600 },
      { Id: 'img-new', RepoTags: [], Created: Math.floor(Date.now() / 1000) - 3600 }
    ]);
    const result = await handleMCPTool('docker_image_prune', {
      dry_run: true, filters: { until: '24h' }
    });
    expect(mockDocker.pruneImages).not.toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data.dry_run).toBe(true);
    expect(data.would_remove.map(i => i.id)).toEqual(['img-old']);
  });
});

describe('docker_container_prune label protection + array filters', () => {
  const containers = [
    { Id: 'aaa', Names: ['/protected'], State: 'exited', Status: 'Exited (0) 2 days ago',
      Labels: { 'com.example.keep': 'yes' } },
    { Id: 'bbb', Names: ['/stale'], State: 'exited', Status: 'Exited (0) 2 days ago', Labels: {} }
  ];

  it('dry_run spares containers carrying the label filter', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(containers);
    const result = await handleMCPTool('docker_container_prune', {
      dry_run: true, filters: ['label=com.example.keep']
    });
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data.would_remove.map(c => c.id)).toEqual(['bbb']);
  });

  it('real prune with label filter removes only unprotected containers', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(containers);
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ remove });
    const result = await handleMCPTool('docker_container_prune', { filters: ['label=com.example.keep'] });
    const data = JSON.parse(result.content[0].text);
    expect(data.ContainersDeleted).toEqual(['bbb']);
  });

  it('accepts the array filter form and maps it to the object form', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'aaa', Names: ['/stale'], State: 'exited', Status: 'Exited (0) 2 days ago',
        Created: Math.floor(Date.now() / 1000) - 48 * 3600, Labels: {} }
    ]);
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_container_prune', { filters: ['until=24h', 'name=stale'] });
    // until is relative to now — just assert the name path drove individual removal
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it('schematizes filters and dry_run for agent discovery on both prune tools', () => {
    for (const t of ['docker_container_prune', 'docker_image_prune']) {
      const props = MCP_TOOLS.find(x => x.name === t).inputSchema.properties;
      expect(props.filters).toBeDefined();
      expect(props.dry_run).toBeDefined();
    }
  });
});

describe('docker_image_prune label protection', () => {
  it('dry_run spares images carrying the label filter', async () => {
    mockDocker.listImages.mockResolvedValueOnce([
      { Id: 'img-keep', RepoTags: ['keep:1'], Created: 1, Labels: { 'com.example.keep': 'yes' } },
      { Id: 'img-drop', RepoTags: [], Created: 1, Labels: {} }
    ]);
    const result = await handleMCPTool('docker_image_prune', {
      dry_run: true, filters: ['label=com.example.keep']
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.would_remove.map(i => i.id)).toEqual(['img-drop']);
  });
});

describe('docker_system_df', () => {
  it('summarizes disk usage totals and reclaimable build cache', async () => {
    const result = await handleMCPTool('docker_system_df', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.images).toEqual({ count: 2, total_size: 1000, active: 1 });
    expect(data.containers).toEqual({ count: 2, running: 1, total_size: 200 });
    expect(data.volumes.count).toBe(2);
    expect(data.volumes.total_size).toBe(300);
    expect(data.build_cache).toEqual({ count: 2, total_size: 1000, reclaimable: 300 });
    expect(data.layers_size).toBe(1000);
  });
});

describe('async jobs', () => {
  const flush = () => new Promise(r => setTimeout(r, 20));
  let origFollow;
  beforeEach(() => { origFollow = mockDocker.modem.followProgress; });
  afterEach(() => { mockDocker.modem.followProgress = origFollow; });

  it('docker_pull with mode=async returns a job id immediately', async () => {
    let finish;
    mockDocker.modem.followProgress = jest.fn((stream, cb) => { finish = () => cb(null, []); });
    const result = await handleMCPTool('docker_pull', { image: 'big:image', mode: 'async' });
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBeDefined();
    expect(data.status).toBe('started');
    finish();
  });

  it('job_status reports running, captures progress, then done', async () => {
    let finish, onProg;
    mockDocker.modem.followProgress = jest.fn((stream, cb, onProgress) => {
      finish = () => cb(null, []);
      onProg = onProgress;
    });
    const started = JSON.parse(
      (await handleMCPTool('docker_pull', { image: 'big:image', mode: 'async' })).content[0].text
    );
    const running = JSON.parse(
      (await handleMCPTool('docker_job_status', { job_id: started.job_id })).content[0].text
    );
    expect(running.status).toBe('running');

    onProg({ id: '1', status: 'Downloading', progress: '[====  ] 50%' });
    finish();
    await flush();
    const done = JSON.parse(
      (await handleMCPTool('docker_job_status', { job_id: started.job_id })).content[0].text
    );
    expect(done.status).toBe('done');
    expect(done.progress.join('\n')).toContain('Downloading');
  });

  it('job_cancel stops a running pull job', async () => {
    let finish;
    mockDocker.modem.followProgress = jest.fn((stream, cb) => { finish = () => cb(null, []); });
    const started = JSON.parse(
      (await handleMCPTool('docker_pull', { image: 'big:image', mode: 'async' })).content[0].text
    );
    const cancel = JSON.parse(
      (await handleMCPTool('docker_job_cancel', { job_id: started.job_id })).content[0].text
    );
    expect(cancel.status).toBe('cancelling');
    await flush();
    const done = JSON.parse(
      (await handleMCPTool('docker_job_status', { job_id: started.job_id })).content[0].text
    );
    expect(done.status).toBe('cancelled');
  });

  it('reports error status with the error message when the operation fails', async () => {
    mockDocker.modem.followProgress = jest.fn((stream, cb) => cb(new Error('pull failed')));
    const started = JSON.parse(
      (await handleMCPTool('docker_pull', { image: 'bad:image', mode: 'async' })).content[0].text
    );
    await flush();
    const done = JSON.parse(
      (await handleMCPTool('docker_job_status', { job_id: started.job_id })).content[0].text
    );
    expect(done.status).toBe('error');
    expect(done.error).toContain('pull failed');
  });

  it('rejects job_status for unknown jobs', async () => {
    await expect(
      handleMCPTool('docker_job_status', { job_id: 'nope' })
    ).rejects.toThrow('Unknown job');
  });

  it('sync mode is unchanged', async () => {
    const result = await handleMCPTool('docker_pull', { image: 'nginx' });
    expect(result.content[0].text).toBe('Pulled: nginx');
  });

  it('exposes mode on pull, build, compose_up and recreate schemas', async () => {
    for (const t of ['docker_pull', 'docker_build', 'docker_compose_up', 'docker_container_recreate']) {
      expect(MCP_TOOLS.find(x => x.name === t).inputSchema.properties.mode).toBeDefined();
    }
  });
});

describe('docker_ps filters', () => {
  it('passes name/label/status filters to listContainers', async () => {
    await handleMCPTool('docker_ps', { all: true, name: 'web', label: 'app=x', status: 'running' });
    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { name: ['web'], label: ['app=x'], status: ['running'] }
    });
  });

  it('omits filters when none are requested', async () => {
    await handleMCPTool('docker_ps', { all: true });
    expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
  });
});

describe('docker_top', () => {
  it('returns the process listing for a container', async () => {
    const result = await handleMCPTool('docker_top', { id: 'web' });
    expect(mockDocker.getContainer).toHaveBeenCalledWith('web');
    expect(mockDocker.getContainer().top).toHaveBeenCalledWith(undefined);
    expect(result.content[0].text).toContain('nginx: master process');
  });

  it('passes ps_args through', async () => {
    await handleMCPTool('docker_top', { id: 'web', ps_args: 'aux' });
    expect(mockDocker.getContainer().top).toHaveBeenCalledWith('aux');
  });
});

describe('docker_compose_ps', () => {
  it('lists services of a compose project via the project label', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'abc', Names: ['/myapp-web-1'], Image: 'nginx', State: 'running',
        Status: 'Up 2 hours', Ports: [{ PublicPort: 3000, PrivatePort: 3000, Type: 'tcp' }],
        Labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'web' } },
      { Id: 'def', Names: ['/myapp-db-1'], Image: 'postgres', State: 'exited',
        Status: 'Exited (0) 3 days ago', Ports: [],
        Labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'db' } }
    ]);
    const result = await handleMCPTool('docker_compose_ps', { project: 'myapp' });
    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true, filters: { label: ['com.docker.compose.project=myapp'] }
    });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);
    expect(data[0].service).toBe('web');
    expect(data[0].state).toBe('running');
    expect(data[1].service).toBe('db');
    expect(data[1].state).toBe('exited');
  });
});

describe('docker_volume_ls real sizes', () => {
  it('reports sizes from verbose system df', async () => {
    mockDocker.modem.dial.mockImplementationOnce((opts, cb) =>
      cb(null, { Volumes: [{ Name: 'data', UsageData: { Size: 12345678, RefCount: 1 } }] }));
    const result = await handleMCPTool('docker_volume_ls', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].name).toBe('data');
    expect(data[0].size).toBe('11.77 MB');
    expect(mockDocker.listVolumes).not.toHaveBeenCalled();
  });

  it('reads sizes from the new VolumeUsage.Items verbose shape (Docker API 1.42+)', async () => {
    mockDocker.modem.dial.mockImplementationOnce((opts, cb) =>
      cb(null, { VolumeUsage: { Items: [{ Name: 'new-shape', UsageData: { Size: 2097152 } }] } }));
    const result = await handleMCPTool('docker_volume_ls', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].name).toBe('new-shape');
    expect(data[0].size).toBe('2.00 MB');
  });

  it('falls back to listVolumes when verbose df is unavailable', async () => {
    mockDocker.listVolumes.mockResolvedValueOnce({
      Volumes: [{ Name: 'v', Driver: 'local', Mountpoint: '/x' }]
    });
    const result = await handleMCPTool('docker_volume_ls', {});
    const data = JSON.parse(result.content[0].text);
    expect(data[0].size).toBe('N/A');
  });
});

describe('quick-win schemas', () => {
  it('exposes compose_ps, top and compose_build in tools/list', () => {
    for (const t of ['docker_compose_ps', 'docker_top', 'docker_compose_build']) {
      expect(MCP_TOOLS.some(x => x.name === t)).toBe(true);
    }
  });

  it('docker_ps schema documents name, label and status filters', () => {
    const props = MCP_TOOLS.find(x => x.name === 'docker_ps').inputSchema.properties;
    expect(props.name).toBeDefined();
    expect(props.label).toBeDefined();
    expect(props.status).toBeDefined();
  });
});

describe('docker_outdated', () => {
  const containers = [
    { Id: 'c1', Names: ['/web'], Image: 'nginx:latest', State: 'running' },
    { Id: 'c2', Names: ['/app'], Image: 'myapp-web:latest', State: 'running' }
  ];

  function mockFetch({ remoteDigest = 'sha256:remotedigest', status = 200 } = {}) {
    return jest.fn(async (url, opts) => {
      if (String(url).includes('auth.docker.io')) {
        return { ok: true, status: 200, json: async () => ({ token: 'tok123' }) };
      }
      return {
        ok: status < 400, status,
        headers: { get: h => h.toLowerCase() === 'docker-content-digest' ? remoteDigest : null },
        json: async () => ({ errors: [{ message: 'manifest unknown' }] })
      };
    });
  }

  it('reports update_available when the remote digest differs from local', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(containers);
    mockDocker.getImage.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        Id: 'sha256:localimage', RepoDigests: ['docker.io/library/nginx@sha256:localdigest']
      })
    });
    const fetchMock = mockFetch();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    const web = data.containers.find(c => c.name === 'web');
    expect(web.local_digest).toBe('sha256:localdigest');
    expect(web.remote_digest).toBe('sha256:remotedigest');
    expect(web.update_available).toBe(true);
    expect(data.updates_available).toBe(1);
  });

  it('returns a clean error entry for locally built images (no registry digest)', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(containers);
    mockDocker.getImage.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({ Id: 'sha256:app', RepoDigests: [] })
    });
    const fetchMock = mockFetch();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    const app = data.containers.find(c => c.name === 'app');
    expect(app.update_available).toBeNull();
    expect(data.not_assessed).toBe(2); // neither mocked image has a registry digest
    expect(app.error).toMatch(/no registry digest/i);
    // the nginx container still got checked
    expect(data.containers.find(c => c.name === 'web')).toBeDefined();
  });

  it('surfaces a 404 as a per-container error, not a crash', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([containers[0]]);
    mockDocker.getImage.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        Id: 'sha256:l', RepoDigests: ['docker.io/library/nginx@sha256:l']
      })
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch({ status: 404 }));
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    expect(data.containers[0].error).toMatch(/not found|manifest/i);
    expect(data.containers[0].update_available).toBeNull();
  });

  it('reports false only when the comparison actually ran', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([containers[0]]);
    mockDocker.getImage.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        Id: 'sha256:l', RepoDigests: ['docker.io/library/nginx@sha256:same']
      })
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch({ remoteDigest: 'sha256:same' }));
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    expect(data.containers[0].update_available).toBe(false);
    expect(data.not_assessed).toBe(0);
  });

  it('does not compare a digest-pinned image with itself', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c3', Names: ['/pinned'], Image: 'example/app@sha256:abc', State: 'running' }
    ]);
    const fetchMock = mockFetch({ remoteDigest: 'sha256:abc' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.containers[0]).toMatchObject({ pinned: true, update_available: null, local_digest: 'sha256:abc' });
    expect(data.not_assessed).toBe(1);
  });

  it('flags a bare image ID as untagged rather than locally built', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c4', Names: ['/old'], Image: 'sha256:1b1d34d0a9c0', State: 'running' }
    ]);
    const fetchMock = mockFetch();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const result = await handleMCPTool('docker_outdated', {});
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.containers[0]).toMatchObject({ untagged: true, update_available: null });
    expect(data.containers[0].error).toBeUndefined();
    expect(data.not_assessed).toBe(1);
  });

  it('checks only the named container when id is given', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(containers);
    mockDocker.getImage.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({ Id: 'sha256:app', RepoDigests: [] })
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch());
    const result = await handleMCPTool('docker_outdated', { id: 'app' });
    jest.restoreAllMocks();
    const data = JSON.parse(result.content[0].text);
    expect(data.containers).toHaveLength(1);
    expect(data.containers[0].name).toBe('app');
  });

  it('is exposed in tools/list with a schema', () => {
    const t = MCP_TOOLS.find(x => x.name === 'docker_outdated');
    expect(t).toBeDefined();
    expect(t.inputSchema.properties.id).toBeDefined();
  });
});

describe('docker_volume_backup', () => {
  const cp = require('child_process');
  let execSpy;

  afterEach(() => { if (execSpy) execSpy.mockRestore(); });

  it('streams the volume as tar via a helper container and reports bytes + sha256', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(null, 'ab'.repeat(32) + '\n1048576\n', ''));
    const result = await handleMCPTool('docker_volume_backup', {
      name: 'app_data', out_path: '/srv/backups/app_data.tar'
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.bytes).toBe(1048576);
    expect(data.sha256).toBe('ab'.repeat(32));
    const call = execSpy.mock.calls[0];
    expect(call[0]).toBe('docker');
    expect(call[1][0]).toBe('run');
    expect(call[1]).toContain('app_data:/volume:ro');
    expect(call[1]).toContain('/srv/backups:/backup');
    expect(call[1].join(' ')).toContain("tar cf '/backup/app_data.tar'");
  });

  it('uses gzip when requested', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(null, 'a'.repeat(64) + '\n10\n', ''));
    const result = await handleMCPTool('docker_volume_backup', {
      name: 'app_data', out_path: '/srv/backups/p.tar.gz', gzip: true
    });
    expect(execSpy.mock.calls[0][1].join(' ')).toContain('tar czf');
    expect(execSpy.mock.calls[0][1].join(' ')).toContain('p.tar.gz');
    const data = JSON.parse(result.content[0].text);
    expect(data.gzip).toBe(true);
  });

  it('refuses a relative out_path', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    await expect(
      handleMCPTool('docker_volume_backup', { name: 'v', out_path: 'backups/v.tar' })
    ).rejects.toThrow(/absolute/i);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('reports a missing volume as a clean error', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    mockDocker.getVolume.mockReturnValueOnce({
      inspect: jest.fn().mockRejectedValue(new Error('no such volume: missing'))
    });
    await expect(
      handleMCPTool('docker_volume_backup', { name: 'missing', out_path: '/tmp/x.tar' })
    ).rejects.toThrow('no such volume');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing backup file', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(new Error('exit 3'), '', 'ERROR_EXISTS\n'));
    await expect(
      handleMCPTool('docker_volume_backup', { name: 'v', out_path: '/tmp/exists.tar' })
    ).rejects.toThrow(/already exists/i);
  });

  it('is exposed in tools/list', () => {
    expect(MCP_TOOLS.some(t => t.name === 'docker_volume_backup')).toBe(true);
  });
});

describe('docker_compose_pull / docker_compose_restart', () => {
  const stack = [
    { Id: 'c1', Names: ['/myapp-app-1'], Image: 'myapp/app:latest', State: 'exited',
      Labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'app' } },
    { Id: 'c2', Names: ['/myapp-db-1'], Image: 'postgres:16', State: 'exited',
      Labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'db' } },
    { Id: 'c3', Names: ['/other'], Image: 'nginx', State: 'running', Labels: {} }
  ];

  it('pulls the images of a compose project and reports per-image results', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([stack[0], stack[1]]);
    const result = await handleMCPTool('docker_compose_pull', { project: 'myapp' });
    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true, filters: { label: ['com.docker.compose.project=myapp'] }
    });
    expect(mockDocker.pull).toHaveBeenCalledWith('myapp/app:latest', expect.any(Function));
    expect(mockDocker.pull).toHaveBeenCalledWith('postgres:16', expect.any(Function));
    expect(mockDocker.pull).toHaveBeenCalledTimes(2);
    const text = result.content[0].text;
    expect(text).toContain('myapp/app:latest');
    expect(text).toContain('postgres:16');
  });

  it('supports async mode for long pulls', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([stack[0]]);
    const result = await handleMCPTool('docker_compose_pull', { project: 'myapp', mode: 'async' });
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBeDefined();
    expect(data.status).toBe('started');
  });

  it('restarts every container of the project', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([stack[0], stack[1]]);
    const restart = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValue({ restart });
    const result = await handleMCPTool('docker_compose_restart', { project: 'myapp' });
    expect(restart).toHaveBeenCalledTimes(2);
    const data = JSON.parse(result.content[0].text);
    expect(data.restarted).toEqual(['myapp-app-1', 'myapp-db-1']);
  });

  it('errors clearly when the project has no containers', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await expect(
      handleMCPTool('docker_compose_pull', { project: 'ghost' })
    ).rejects.toThrow(/no containers/i);
    await expect(
      handleMCPTool('docker_compose_restart', { project: 'ghost' })
    ).rejects.toThrow(/no containers/i);
  });

  it('exposes both tools in tools/list', () => {
    for (const t of ['docker_compose_pull', 'docker_compose_restart']) {
      expect(MCP_TOOLS.find(x => x.name === t)).toBeDefined();
    }
  });

  it('does not attempt to pull digest-only (locally built) images', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c1', Names: ['/app-1'], Image: 'sha256:6b599ca3e974', State: 'exited', Labels: {} },
      { Id: 'c2', Names: ['/db-1'], Image: 'postgres:16', State: 'exited', Labels: {} }
    ]);
    const result = await handleMCPTool('docker_compose_pull', { project: 'myapp' });
    expect(mockDocker.pull).toHaveBeenCalledTimes(1); // only postgres:16
    const text = result.content[0].text;
    expect(text).toMatch(/sha256:6b599ca3e974.*(no tag to pull|locally built)/is);
    expect(result.structuredContent).toEqual({
      project: 'myapp',
      images: [
        { image: 'sha256:6b599ca3e974', ok: false, error: expect.stringMatching(/no tag to pull|locally built/i) },
        { image: 'postgres:16', ok: true }
      ]
    });
  });
});

describe('docker_container_recreate', () => {
  // A test below installs a ref-mapping getContainer implementation; it
  // survives clearAllMocks, so restore the factory default afterwards — later
  // unstubbed getContainer calls must not receive null
  afterAll(() => {
    mockDocker.getContainer.mockImplementation(() => factoryDefaultContainer);
  });

  const oldInfo = {
    Id:   'old1234567890',
    Name: '/web',
    Image: 'sha256:oldimage',
    Config: { Image: 'nginx:latest', Env: ['A=1'] },
    HostConfig: { Binds: ['/data:/data'], RestartPolicy: { Name: 'always' }, NetworkMode: 'bridge' },
    // Real inspect shape: no top-level NetworkingConfig, attachments live here
    NetworkSettings: { Networks: { bridge: { Aliases: null, IPAMConfig: null } } },
    State: { Running: true }
  };

  function makeOld(info = oldInfo) {
    return {
      inspect: jest.fn().mockResolvedValue(info),
      stop:    jest.fn().mockResolvedValue({}),
      rename:  jest.fn().mockResolvedValue({}),
      start:   jest.fn().mockResolvedValue({})
    };
  }

  it('recreates the container with the captured config and renames the old one aside', async () => {
    const oldC = makeOld();
    const newC = {
      start:   jest.fn().mockResolvedValue({}),
      remove:  jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', Image: 'sha256:newimage', State: { Running: true } })
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce(newC);

    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });

    expect(mockDocker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'web',
      Image: 'nginx:latest',
      Env: ['A=1'],
      HostConfig: oldInfo.HostConfig
    }));
    // inspect has no NetworkingConfig to forward — passing it was a no-op
    expect(mockDocker.createContainer.mock.calls[0][0]).not.toHaveProperty('NetworkingConfig');
    expect(oldC.stop).toHaveBeenCalled();
    expect(oldC.rename).toHaveBeenCalledWith({ name: 'web-old' });
    expect(newC.start).toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data.recreated).toBe(true);
    expect(data.new_id).toBe('new4567890123');
    expect(data.backup_name).toBe('web-old');
  });

  describe('network re-attachment', () => {
    const multiInfo = {
      ...oldInfo,
      NetworkSettings: { Networks: {
        bridge:        { Aliases: null, IPAMConfig: null },
        'app-net': { Aliases: null, IPAMConfig: null }
      } }
    };

    function stubNew() {
      return {
        id:      'new4567890123',
        start:   jest.fn().mockResolvedValue({}),
        remove:  jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: true } })
      };
    }

    async function recreate(oldC, newC) {
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);
      return handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
    }

    it('re-attaches networks NetworkMode does not cover, before starting', async () => {
      const oldC = makeOld(multiInfo);
      const newC = stubNew();
      const net = mockDocker.getNetwork();

      const result = await recreate(oldC, newC);

      expect(mockDocker.getNetwork).toHaveBeenCalledWith('app-net');
      expect(net.connect).toHaveBeenCalledWith({
        Container: 'new4567890123',
        EndpointConfig: { Aliases: ['web'] }
      });
      // the container must never run without its networks
      expect(net.connect.mock.invocationCallOrder[0])
        .toBeLessThan(newC.start.mock.invocationCallOrder[0]);
      expect(JSON.parse(result.content[0].text).networks).toEqual(['app-net']);
    });

    it('preserves network-scoped aliases and a static IP', async () => {
      const info = {
        ...multiInfo,
        NetworkSettings: { Networks: {
          bridge:        { Aliases: null, IPAMConfig: null },
          'app-net': { Aliases: ['cache', 'web'], IPAMConfig: { IPv4Address: '10.99.0.9' } }
        } }
      };
      const net = mockDocker.getNetwork();

      await recreate(makeOld(info), stubNew());

      expect(net.connect).toHaveBeenCalledWith({
        Container: 'new4567890123',
        EndpointConfig: { Aliases: ['cache', 'web'], IPAMConfig: { IPv4Address: '10.99.0.9' } }
      });
    });

    it('preserves the primary network aliases and static IP via NetworkingConfig', async () => {
      const info = {
        ...oldInfo,
        HostConfig: { ...oldInfo.HostConfig, NetworkMode: 'app-net' },
        NetworkSettings: { Networks: {
          'app-net': { Aliases: ['cache', 'web'], IPAMConfig: { IPv4Address: '10.99.0.9' } }
        } }
      };

      await recreate(makeOld(info), stubNew());

      expect(mockDocker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
        NetworkingConfig: { EndpointsConfig: {
          'app-net': { Aliases: ['cache', 'web'], IPAMConfig: { IPv4Address: '10.99.0.9' } }
        } }
      }));
      expect(mockDocker.getNetwork).not.toHaveBeenCalled(); // primary is not double-attached
    });

    it('does not re-attach a network already covered by NetworkMode', async () => {
      const info = {
        ...oldInfo,
        HostConfig: { ...oldInfo.HostConfig, NetworkMode: 'myapp_default' },
        NetworkSettings: { Networks: {
          'myapp_default': { Aliases: ['app'], IPAMConfig: null }
        } }
      };

      const result = await recreate(makeOld(info), stubNew());

      expect(mockDocker.getNetwork).not.toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text).networks).toEqual([]);
    });

    it('rolls back when re-attaching a network fails', async () => {
      const oldC = makeOld(multiInfo);
      const newC = stubNew();
      mockDocker.getNetwork().connect.mockRejectedValueOnce(new Error('network app-net not found'));

      const result = await recreate(oldC, newC);
      const data = JSON.parse(result.content[0].text);

      expect(data.rolled_back).toBe(true);
      expect(data.error).toMatch(/not found/);
      expect(newC.remove).toHaveBeenCalled();      // half-built container cleaned up
      expect(newC.start).not.toHaveBeenCalled();   // never started without its network
      expect(oldC.start).toHaveBeenCalled();       // previous container back up
    });
  });

  it('does not stop an already-stopped container, nor restart it on rollback', async () => {
    const oldC = makeOld({ ...oldInfo, State: { Running: false } });
    const newC = {
      start:  jest.fn().mockRejectedValue(new Error('port already allocated')),
      remove: jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce(newC);

    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
    const data = JSON.parse(result.content[0].text);

    expect(data.rolled_back).toBe(true);
    expect(oldC.stop).not.toHaveBeenCalled();
    expect(oldC.start).not.toHaveBeenCalled();
  });

  it('pulls the image before recreating by default', async () => {
    const oldC = makeOld();
    const newC = {
      start: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: true } })
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce(newC);

    await handleMCPTool('docker_container_recreate', { id: 'web' });
    expect(mockDocker.pull).toHaveBeenCalledWith('nginx:latest', expect.any(Function));
  });

  it('rolls back to the renamed backup when the new container exits', async () => {
    const oldC = makeOld();
    const newC = {
      start: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: false } })
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce(newC);

    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });

    expect(newC.remove).toHaveBeenCalled();
    expect(oldC.rename).toHaveBeenCalledWith({ name: 'web' });   // rename back
    expect(oldC.start).toHaveBeenCalled();                        // old container running again
    const data = JSON.parse(result.content[0].text);
    expect(data.recreated).toBe(false);
    expect(data.rolled_back).toBe(true);
  });

  it('rolls back when starting the new container throws', async () => {
    const oldC = makeOld();
    const newC = {
      start:  jest.fn().mockRejectedValue(new Error('port already allocated')),
      remove: jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce(newC);

    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
    const data = JSON.parse(result.content[0].text);
    expect(data.rolled_back).toBe(true);
    expect(oldC.start).toHaveBeenCalled();
  });

  it('refuses to overwrite an existing container with the backup name', async () => {
    mockDocker.getContainer.mockReturnValueOnce(makeOld()).mockReturnValueOnce(makeOld());
    mockDocker.listContainers.mockResolvedValueOnce([{ Names: ['/web-old'] }]);
    await expect(
      handleMCPTool('docker_container_recreate', { id: 'web' })
    ).rejects.toThrow('backup name');
    expect(mockDocker.createContainer).not.toHaveBeenCalled();
  });

  it('keeps working after the rename-aside by holding the old container by ID', async () => {
    // Regression: recreating by NAME breaks rollback — after the old container
    // is renamed aside, a handle bound to the old name 404s on rename-back/start
    const nameHandle = { // what getContainer('web') hands back — stale after rename
      inspect: jest.fn().mockResolvedValue({ ...oldInfo }),
      stop:    jest.fn().mockResolvedValue({}),
      rename:  jest.fn().mockResolvedValue({}),
      start:   jest.fn().mockRejectedValue(new Error('(HTTP code 404) no such container: web'))
    };
    const idHandle = {   // what getContainer(<id>) hands back — stable across renames
      inspect: jest.fn().mockResolvedValue({ ...oldInfo }),
      stop:    jest.fn().mockResolvedValue({}),
      rename:  jest.fn().mockResolvedValue({}),
      start:   jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockImplementation(ref =>
      ref === 'web' ? nameHandle : ref === 'old1234567890' ? idHandle : null);
    mockDocker.createContainer.mockResolvedValueOnce({
      start: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: false } })
    });

    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
    const data = JSON.parse(result.content[0].text);
    expect(data.rolled_back).toBe(true);
    // stop/rename use whichever handle; but rename-back and restart must go
    // through the ID-bound handle
    expect(idHandle.rename).toHaveBeenCalledWith({ name: 'web' });
    expect(idHandle.start).toHaveBeenCalled();
    expect(data.notes.join('\n')).not.toMatch(/rename-back failed/);
  });

  describe('healthcheck-aware rollback', () => {
    const healthInfo = {
      ...oldInfo,
      Config: { ...oldInfo.Config, Healthcheck: { Test: ['CMD', 'true'] } }
    };

    function makeOldHealth() {
      return {
        inspect: jest.fn().mockResolvedValue(healthInfo),
        stop:    jest.fn().mockResolvedValue({}),
        rename:  jest.fn().mockResolvedValue({}),
        start:   jest.fn().mockResolvedValue({})
      };
    }

    it('succeeds only once the new container reports healthy', async () => {
      const oldC = makeOldHealth();
      let calls = 0;
      const newC = {
        start: jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockImplementation(async () => {
          calls++;
          return { Id: 'new4567890123', State: { Running: true, Health: { Status: calls >= 2 ? 'healthy' : 'starting' } } };
        })
      };
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);

      const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 30 });
      const data = JSON.parse(result.content[0].text);
      expect(data.recreated).toBe(true);
      expect(data.health).toBe('healthy');
      expect(oldC.start).not.toHaveBeenCalled();  // no rollback
    });

    it('rolls back when the healthcheck never reaches healthy', async () => {
      const oldC = makeOldHealth();
      const newC = {
        start: jest.fn().mockResolvedValue({}),
        remove: jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockResolvedValue({
          Id: 'new4567890123', State: { Running: true, Health: { Status: 'unhealthy' } }
        })
      };
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);

      const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 2 });
      const data = JSON.parse(result.content[0].text);
      expect(data.recreated).toBe(false);
      expect(data.rolled_back).toBe(true);
      expect(data.error).toMatch(/healthy/i);
      expect(newC.remove).toHaveBeenCalled();
      expect(oldC.start).toHaveBeenCalled();
    });

    it('treats Test NONE as no healthcheck', async () => {
      const info = { ...oldInfo, Config: { ...oldInfo.Config, Healthcheck: { Test: ['NONE'] } } };
      const oldC = makeOld(info);
      const newC = {
        start:  jest.fn().mockResolvedValue({}),
        remove: jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: true } })
      };
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);

      const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
      const data = JSON.parse(result.content[0].text);

      expect(data.recreated).toBe(true);
      expect(data.health).toBeUndefined();
      expect(oldC.start).not.toHaveBeenCalled();
    });

    it('derives the default timeout from the healthcheck interval', async () => {
      const info = {
        ...oldInfo,
        Config: { ...oldInfo.Config, Healthcheck: { Test: ['CMD', 'true'], Interval: 1e9 } }
      };
      const oldC = makeOld(info);
      const newC = {
        start:  jest.fn().mockResolvedValue({}),
        remove: jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockResolvedValue({
          Id: 'new4567890123', State: { Running: true, Health: { Status: 'unhealthy' } }
        })
      };
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);

      // no start_timeout_s: two intervals (2s), not the old flat 30s
      const result = await handleMCPTool('docker_container_recreate', { id: 'web' });
      const data = JSON.parse(result.content[0].text);
      expect(data.rolled_back).toBe(true);
      expect(data.error).toMatch(/within 2s/);
    });

    it('keeps the run-watching behavior for containers without a healthcheck', async () => {
      const oldC = makeOld();
      const newC = {
        start: jest.fn().mockResolvedValue({}),
        inspect: jest.fn().mockResolvedValue({ Id: 'new4567890123', State: { Running: true } })
      };
      mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
      mockDocker.createContainer.mockResolvedValueOnce(newC);

      const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 5 });
      const data = JSON.parse(result.content[0].text);
      expect(data.recreated).toBe(true);
      expect(data.health).toBeUndefined();
    });
  });
});

describe('per-container recreate lock', () => {
  afterEach(() => { RECREATE_LOCKS.clear(); });

  it('rejects a second recreate of the same container with a -32000 error', async () => {
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        Id: 'old1234567890', Name: '/web',
        Config: { Image: 'nginx:latest' }, HostConfig: {}, NetworkingConfig: {},
        State: { Running: true }
      })
    });
    RECREATE_LOCKS.set('web', { ts: Date.now() });
    try {
      await handleMCPTool('docker_container_recreate', { id: 'web' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.message).toMatch(/recreate in progress for web/);
      expect(e.code).toBe(-32000);
    }
    expect(mockDocker.createContainer).not.toHaveBeenCalled();
  });

  it('releases the lock after a successful recreate', async () => {
    const oldC = {
      inspect: jest.fn().mockResolvedValue({
        Id: 'old1234567890', Name: '/web',
        Config: { Image: 'nginx:latest' }, HostConfig: {}, NetworkingConfig: {},
        State: { Running: true }
      }),
      stop: jest.fn().mockResolvedValue({}),
      rename: jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce({
      start: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new123', State: { Running: true } })
    });
    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 3 });
    expect(JSON.parse(result.content[0].text).recreated).toBe(true);
    expect(RECREATE_LOCKS.has('web')).toBe(false);
  });

  it('releases the lock when the recreate rolls back', async () => {
    const oldC = {
      inspect: jest.fn().mockResolvedValue({
        Id: 'old1234567890', Name: '/web',
        Config: { Image: 'nginx:latest' }, HostConfig: {}, NetworkingConfig: {},
        State: { Running: true }
      }),
      stop: jest.fn().mockResolvedValue({}),
      rename: jest.fn().mockResolvedValue({}),
      start: jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce({
      start: jest.fn().mockRejectedValue(new Error('port in use')),
      inspect: jest.fn().mockResolvedValue({ Id: 'new123', State: { Running: false } })
    });
    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 3 });
    expect(JSON.parse(result.content[0].text).rolled_back).toBe(true);
    expect(RECREATE_LOCKS.has('web')).toBe(false);
  });

  it('does not release a lock taken over by another caller', async () => {
    const foreign = { ts: Date.now(), token: 'foreign' };
    const oldC = {
      inspect: jest.fn().mockResolvedValue({
        Id: 'old1234567890', Name: '/web',
        Config: { Image: 'nginx:latest' }, HostConfig: {}, NetworkingConfig: {},
        State: { Running: true }
      }),
      stop: jest.fn().mockResolvedValue({}),
      rename: jest.fn().mockResolvedValue({})
    };
    mockDocker.getContainer.mockReturnValueOnce(oldC).mockReturnValueOnce(oldC);
    mockDocker.createContainer.mockResolvedValueOnce({
      start: jest.fn().mockImplementation(async () => {
        RECREATE_LOCKS.set('web', foreign); // another caller took over mid-run
      }),
      inspect: jest.fn().mockResolvedValue({ Id: 'new123', State: { Running: true } })
    });

    await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 3 });

    expect(RECREATE_LOCKS.get('web')).toBe(foreign);
  });

  it('takes over a lock older than the 5 minute TTL', async () => {
    RECREATE_LOCKS.set('web', { ts: Date.now() - 6 * 60 * 1000 });
    mockDocker.getContainer.mockReturnValueOnce({
      inspect: jest.fn().mockResolvedValue({
        Id: 'old1234567890', Name: '/web',
        Config: { Image: 'nginx:latest' }, HostConfig: {}, NetworkingConfig: {},
        State: { Running: true }
      }),
      stop: jest.fn().mockResolvedValue({}),
      rename: jest.fn().mockResolvedValue({})
    });
    mockDocker.createContainer.mockResolvedValueOnce({
      start: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({ Id: 'new123', State: { Running: true } })
    });
    const result = await handleMCPTool('docker_container_recreate', { id: 'web', start_timeout_s: 3 });
    expect(JSON.parse(result.content[0].text).recreated).toBe(true);
  });
});

describe('docker_exec timeout', () => {
  it('rejects with a timeout error when the command never finishes', async () => {
    jest.useFakeTimers();
    const { PassThrough } = require('stream');
    const neverEnding = new PassThrough(); // never 'end'
    mockDocker.getContainer.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue({
        start:   jest.fn().mockResolvedValue(neverEnding),
        inspect: jest.fn().mockResolvedValue({ ExitCode: 0 })
      })
    });
    const p = handleMCPTool('docker_exec', { id: 'mycontainer', command: ['sleep', '999'], timeout: 2 });
    const expectation = expect(p).rejects.toThrow('Exec timed out');
    await jest.advanceTimersByTimeAsync(2001);
    await expectation;
    jest.useRealTimers();
  });
});

describe('confirm: true required on destructive tools', () => {
  const CONFIRM_REQUIRED = ['docker_image_rm', 'docker_volume_rm', 'docker_network_rm', 'docker_compose_down'];
  afterEach(() => { delete process.env.CONFIRM_REQUIRED_TOOLS; });

  it('rejects docker_volume_rm without confirm, naming the volume', async () => {
    await expect(handleMCPTool('docker_volume_rm', { name: 'data' }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining("volume 'data'") });
    expect(mockDocker.getVolume).not.toHaveBeenCalled();
  });

  it('executes docker_volume_rm with confirm: true', async () => {
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getVolume.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_volume_rm', { name: 'data', confirm: true });
    expect(remove).toHaveBeenCalled();
  });

  it('rejects docker_image_rm without confirm and executes with it', async () => {
    await expect(handleMCPTool('docker_image_rm', { name: 'web:2' }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining("image 'web:2'") });
    expect(mockDocker.getImage).not.toHaveBeenCalled();
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getImage.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_image_rm', { name: 'web:2', confirm: true });
    expect(remove).toHaveBeenCalled();
  });

  it('rejects docker_network_rm without confirm', async () => {
    await expect(handleMCPTool('docker_network_rm', { name: 'mesh' }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining("network 'mesh'") });
    expect(mockDocker.getNetwork).not.toHaveBeenCalled();
  });

  it('compose_down without confirm lists the affected containers', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c1', Names: ['/demo-app-1'], Image: 'a', State: 'running',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.project.working_dir': '/srv/demo' } },
      { Id: 'c2', Names: ['/demo-db-1'], Image: 'b', State: 'running',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.project.working_dir': '/srv/demo' } }
    ]);
    await expect(handleMCPTool('docker_compose_down', { project: 'demo' }))
      .rejects.toMatchObject({
        code: -32000,
        message: expect.stringMatching(/demo-app-1[\s\S]*demo-db-1/)
      });
  });

  it('compose_down with only project_dir resolves containers via the working_dir label', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([
      { Id: 'c1', Names: ['/app-1'], Image: 'a', State: 'running',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.project.working_dir': '/srv/demo' } },
      { Id: 'c2', Names: ['/other'], Image: 'b', State: 'running', Labels: {} }
    ]);
    await expect(handleMCPTool('docker_compose_down', { project_dir: '/srv/demo' }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining('app-1') });
  });

  it('CONFIRM_REQUIRED_TOOLS=off disables the requirement', async () => {
    process.env.CONFIRM_REQUIRED_TOOLS = 'off';
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getVolume.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_volume_rm', { name: 'data' });
    expect(remove).toHaveBeenCalled();
  });

  it('CONFIRM_REQUIRED_TOOLS narrows the default set', async () => {
    process.env.CONFIRM_REQUIRED_TOOLS = 'docker_image_rm';
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getVolume.mockReturnValueOnce({ remove });
    await handleMCPTool('docker_volume_rm', { name: 'data' }); // not listed → no confirm needed
    expect(remove).toHaveBeenCalled();
  });

  it('schemas advertise the confirm flag on the four tools', () => {
    for (const t of CONFIRM_REQUIRED) {
      const schema = MCP_TOOLS.find(x => x.name === t).inputSchema;
      expect(schema.properties.confirm).toEqual({
        type: 'boolean',
        description: expect.stringMatching(/confirm: true/)
      });
    }
  });
});

describe('compose addressing: project or project_dir', () => {
  const cp = require('child_process');
  let execSpy;
  const wdStack = [
    { Id: 'c1', Names: ['/demo-app-1'], Image: 'a', State: 'running',
      Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.service': 'app',
                'com.docker.compose.project.working_dir': '/srv/demo' } }
  ];

  afterEach(() => { if (execSpy) execSpy.mockRestore(); });

  it('compose_up with project name resolves the working_dir label', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'up output', ''));
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    const result = await handleMCPTool('docker_compose_up', { project: 'demo', detach: true });
    expect(execSpy.mock.calls[0][2]).toMatchObject({ cwd: '/srv/demo' });
    expect(result.content[0].text).toContain('up output');
  });

  it('compose_up async with project name also resolves the working_dir label', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'up output', ''));
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    const result = await handleMCPTool('docker_compose_up', { project: 'demo', mode: 'async' });
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBeDefined();
  });

  it('compose_down with project name resolves the working_dir label', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'down output', ''));
    // confirm:true skips the preview listing — composeCwd does the only lookup
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    const result = await handleMCPTool('docker_compose_down', { project: 'demo', confirm: true });
    expect(execSpy.mock.calls[0][2]).toMatchObject({ cwd: '/srv/demo' });
    expect(result.content[0].text).toContain('down output');
  });

  it('compose_build with project name resolves the working_dir label', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'build output', ''));
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    await handleMCPTool('docker_compose_build', { project: 'demo' });
    expect(execSpy.mock.calls[0][2]).toMatchObject({ cwd: '/srv/demo' });
  });

  it('errors when the project has no containers', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await expect(handleMCPTool('docker_compose_up', { project: 'ghost' })).rejects.toThrow(/no containers found/i);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('errors when neither project nor project_dir is given', async () => {
    await expect(handleMCPTool('docker_compose_up', {})).rejects.toThrow(/project or project_dir/i);
    await expect(handleMCPTool('docker_compose_build', {})).rejects.toThrow(/project or project_dir/i);
  });

  it('compose_logs accepts project (label-resolved cwd)', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'log line', ''));
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    const result = await handleMCPTool('docker_compose_logs', { project: 'demo', tail: 50 });
    expect(execSpy.mock.calls[0][1]).toEqual(['compose', 'logs', '--no-color', '--tail', '50']);
    expect(execSpy.mock.calls[0][2]).toMatchObject({ cwd: '/srv/demo' });
    expect(result.content[0].text).toContain('log line');
  });

  it('compose_logs still accepts file (backward compatible)', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'log line', ''));
    await handleMCPTool('docker_compose_logs', { file: '/srv/demo/docker-compose.yml', service: 'app' });
    expect(execSpy.mock.calls[0][1]).toContain('/srv/demo/docker-compose.yml');
    expect(execSpy.mock.calls[0][1]).toContain('app');
  });

  it('compose_logs passes since through', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, 'log line', ''));
    mockDocker.listContainers.mockResolvedValueOnce(wdStack);
    await handleMCPTool('docker_compose_logs', { project: 'demo', since: '10m' });
    expect(execSpy.mock.calls[0][1]).toContain('--since');
    expect(execSpy.mock.calls[0][1]).toContain('10m');
  });

  it('every compose tool schema accepts project or project_dir', () => {
    for (const t of ['docker_compose_up', 'docker_compose_down', 'docker_compose_build', 'docker_compose_logs']) {
      const s = MCP_TOOLS.find(x => x.name === t).inputSchema;
      expect(s.properties.project).toBeDefined();
      expect(s.properties.project_dir).toBeDefined();
    }
    const logs = MCP_TOOLS.find(x => x.name === 'docker_compose_logs').inputSchema;
    expect(logs.properties.since).toBeDefined();
  });
});

describe('docker_events', () => {
  const EVENTS = [
    { time: 1796100000, Type: 'container', Action: 'start',
      Actor: { ID: 'abcdef1234567890', Attributes: { name: 'web', image: 'nginx' } } },
    { time: 1796100060, Type: 'container', Action: 'die',
      Actor: { ID: 'abcdef1234567890', Attributes: { name: 'web', exitCode: '137' } } },
    { time: 1796100120, Type: 'image', Action: 'pull',
      Actor: { ID: 'nginx:latest', Attributes: { name: 'nginx:latest' } } }
  ];

  function withEvents(events) {
    mockDocker.modem.followProgress.mockImplementationOnce((stream, cb) => cb(null, events));
  }

  it('lists structured events from the default 10m window', async () => {
    withEvents(EVENTS);
    const result = await handleMCPTool('docker_events', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(3);
    expect(data.events[0]).toMatchObject({ time: 1796100000, type: 'container', action: 'start', actor_name: 'web' });
    expect(mockDocker.getEvents).toHaveBeenCalledWith(expect.objectContaining({
      since: expect.any(Number),
      until: expect.any(Number)
    }));
    expect(data.events[0].actor_id).toBe('abcdef123456');
  });

  it('maps since/until and passes filters', async () => {
    withEvents([]);
    await handleMCPTool('docker_events', {
      since: '2026-09-04T00:00:00Z',
      until: '2026-09-04T01:00:00Z',
      filters: { container: 'abcdef', type: 'container', event: 'die' }
    });
    expect(mockDocker.getEvents).toHaveBeenCalledWith({
      since: Date.parse('2026-09-04T00:00:00Z') / 1000,
      until: Date.parse('2026-09-04T01:00:00Z') / 1000,
      filters: { container: ['abcdef'], type: ['container'], event: ['die'] }
    });
  });

  it('applies tail to keep only the last N events', async () => {
    withEvents(EVENTS);
    const result = await handleMCPTool('docker_events', { tail: 2 });
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    expect(data.events[0].action).toBe('die');
  });
});

describe('docker_volume_restore', () => {
  const cp = require('child_process');
  let execSpy;

  afterEach(() => { if (execSpy) execSpy.mockRestore(); });

  it('restores a backup into the volume via a helper container and reports counts + tree hash', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(null, 'FILES 3\nDIRS 1\ncd'.repeat(1) + 'd'.repeat(62) + '\n', ''));
    const result = await handleMCPTool('docker_volume_restore', {
      name: 'app_data', backup_path: '/srv/backups/app_data.tar'
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.volume).toBe('app_data');
    expect(data.files).toBe(3);
    expect(data.dirs).toBe(1);
    expect(data.tree_sha256).toMatch(/^[0-9a-f]{64}$/);
    const argv = execSpy.mock.calls[0][1];
    expect(argv).toContain('app_data:/volume');
    expect(argv.join(' ')).not.toContain('/volume:ro');
    expect(argv).toContain('/srv/backups:/backup:ro');
    expect(argv.join(' ')).toContain("tar xf '/backup/app_data.tar' -C /volume");
    expect(argv.join(' ')).toContain('rm -rf');
  });

  it('detects .gz backups and extracts with tar xzf', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(null, 'FILES 0\nDIRS 0\n' + 'a'.repeat(64) + '\n', ''));
    await handleMCPTool('docker_volume_restore', {
      name: 'v', backup_path: '/srv/backups/v.tar.gz'
    });
    expect(execSpy.mock.calls[0][1].join(' ')).toContain('tar xzf');
  });

  it('refuses a non-empty target without confirm: true', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(new Error('exit 4'), '', 'ERROR_NOT_EMPTY\n'));
    await expect(
      handleMCPTool('docker_volume_restore', { name: 'v', backup_path: '/tmp/v.tar' })
    ).rejects.toMatchObject({ code: -32000, message: /confirm: true/ });
  });

  it('passes CONFIRM=1 to the helper when confirm is true', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(null, 'FILES 0\nDIRS 0\n' + 'a'.repeat(64) + '\n', ''));
    await handleMCPTool('docker_volume_restore', {
      name: 'v', backup_path: '/tmp/v.tar', confirm: true
    });
    expect(execSpy.mock.calls[0][1]).toContain('-e');
    expect(execSpy.mock.calls[0][1]).toContain('CONFIRM=1');
  });

  it('refuses a relative backup_path', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    await expect(
      handleMCPTool('docker_volume_restore', { name: 'v', backup_path: 'backups/v.tar' })
    ).rejects.toThrow(/absolute/i);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('reports a missing volume as a clean error', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    mockDocker.getVolume.mockReturnValueOnce({
      inspect: jest.fn().mockRejectedValue(new Error('no such volume: missing'))
    });
    await expect(
      handleMCPTool('docker_volume_restore', { name: 'missing', backup_path: '/tmp/x.tar' })
    ).rejects.toThrow('no such volume');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('reports a missing backup file cleanly', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(new Error('exit 2'), '', 'ERROR_NOFILE\n'));
    await expect(
      handleMCPTool('docker_volume_restore', { name: 'v', backup_path: '/tmp/nope.tar' })
    ).rejects.toThrow(/backup file/i);
  });

  it('is exposed in tools/list with a confirm flag', () => {
    const t = MCP_TOOLS.find(t => t.name === 'docker_volume_restore');
    expect(t).toBeDefined();
    expect(t.inputSchema.properties.confirm).toBeDefined();
    expect(t.inputSchema.required).toContain('name');
    expect(t.inputSchema.required).toContain('backup_path');
  });
});

describe('docker_exec workdir/user/env', () => {
  // Each test stubs its own container: the shared mock's exec start() stream
  // is single-use (an already-consumed readable never fires 'end' again).
  function stubExec() {
    const { Readable } = require('stream');
    const execFn = jest.fn().mockResolvedValue({
      start:   jest.fn().mockResolvedValue(Readable.from([])),
      inspect: jest.fn().mockResolvedValue({ ExitCode: 0 })
    });
    mockDocker.getContainer.mockReturnValueOnce({ exec: execFn });
    return execFn;
  }

  it('passes WorkingDir, User and Env to the exec', async () => {
    const execFn = stubExec();
    await handleMCPTool('docker_exec', {
      id: 'mycontainer', command: ['pwd'],
      workdir: '/etc', user: 'nobody', env: ['FOO=bar', 'BAZ=qux']
    });
    expect(execFn).toHaveBeenCalledWith(expect.objectContaining({
      WorkingDir: '/etc', User: 'nobody', Env: ['FOO=bar', 'BAZ=qux']
    }));
  });

  it('omits the fields when not provided', async () => {
    const execFn = stubExec();
    await handleMCPTool('docker_exec', { id: 'mycontainer', command: ['ls'] });
    const cfg = execFn.mock.calls[0][0];
    expect(cfg.WorkingDir).toBeUndefined();
    expect(cfg.User).toBeUndefined();
    expect(cfg.Env).toBeUndefined();
  });

  it('schemas document workdir, user and env', () => {
    const s = MCP_TOOLS.find(t => t.name === 'docker_exec').inputSchema;
    expect(s.properties.workdir).toBeDefined();
    expect(s.properties.user).toBeDefined();
    expect(s.properties.env.type).toBe('array');
  });
});

describe('docker_images dangling filter', () => {
  it('passes a dangling filter to listImages when requested', async () => {
    await handleMCPTool('docker_images', { dangling: true });
    expect(mockDocker.listImages).toHaveBeenCalledWith({ filters: { dangling: ['true'] } });
  });

  it('lists all images when not requested', async () => {
    await handleMCPTool('docker_images', {});
    expect(mockDocker.listImages).toHaveBeenCalledWith();
  });

  it('documents dangling in the schema', () => {
    expect(MCP_TOOLS.find(t => t.name === 'docker_images').inputSchema.properties.dangling).toBeDefined();
  });
});

describe('docker_volume_ls label filter', () => {
  it('passes a label filter to listVolumes when given', async () => {
    await handleMCPTool('docker_volume_ls', { label: 'app=web' });
    expect(mockDocker.listVolumes).toHaveBeenCalledWith({ filters: { label: ['app=web'] } });
  });

  it('passes a bare label key without a value', async () => {
    await handleMCPTool('docker_volume_ls', { label: 'keep' });
    expect(mockDocker.listVolumes).toHaveBeenCalledWith({ filters: { label: ['keep'] } });
  });

  it('lists all volumes when no label is given', async () => {
    await handleMCPTool('docker_volume_ls', {});
    expect(mockDocker.listVolumes).toHaveBeenCalledWith();
  });

  it('documents label in the schema', () => {
    expect(MCP_TOOLS.find(t => t.name === 'docker_volume_ls').inputSchema.properties.label).toBeDefined();
  });
});

describe('docker_login', () => {
  beforeEach(() => { REGISTRY_AUTH.clear(); });

  it('validates credentials via checkAuth and reports success without echoing the password', async () => {
    const result = await handleMCPTool('docker_login', {
      username: 'alice', password: 'hunter2'
    });
    expect(mockDocker.checkAuth).toHaveBeenCalledWith(expect.objectContaining({
      username: 'alice', password: 'hunter2', serveraddress: 'https://index.docker.io/v1/'
    }), expect.any(Function));
    expect(result.content[0].text).toContain('alice');
    expect(result.content[0].text).not.toContain('hunter2');
  });

  it('rejects bad credentials', async () => {
    mockDocker.checkAuth.mockImplementationOnce((opts, cb) => cb(new Error('authentication failed')));
    await expect(
      handleMCPTool('docker_login', { username: 'alice', password: 'wrong' })
    ).rejects.toThrow(/authentication failed/i);
  });

  it('builds an https serveraddress for a custom registry', async () => {
    await handleMCPTool('docker_login', {
      registry: 'registry.example.com', username: 'ci', password: 'tok'
    });
    expect(mockDocker.checkAuth).toHaveBeenCalledWith(expect.objectContaining({
      serveraddress: 'https://registry.example.com'
    }), expect.any(Function));
  });

  it('docker_pull passes stored creds as authconfig for that registry', async () => {
    await handleMCPTool('docker_login', {
      registry: 'registry.example.com', username: 'ci', password: 'tok'
    });
    mockDocker.pull.mockImplementationOnce((...args) => {
      args[args.length - 1](null, { on: () => {}, destroy: () => {} });
    });
    mockDocker.modem.followProgress.mockImplementationOnce((stream, cb) => cb(null, []));
    await handleMCPTool('docker_pull', { image: 'registry.example.com/team/app:1' });
    expect(mockDocker.pull).toHaveBeenCalledWith(
      'registry.example.com/team/app:1',
      { authconfig: { username: 'ci', password: 'tok', serveraddress: 'https://registry.example.com' } },
      expect.any(Function)
    );
  });

  it('docker_pull stays credential-free for public images', async () => {
    mockDocker.pull.mockImplementationOnce((...args) => {
      args[args.length - 1](null, { on: () => {}, destroy: () => {} });
    });
    mockDocker.modem.followProgress.mockImplementationOnce((stream, cb) => cb(null, []));
    await handleMCPTool('docker_pull', { image: 'nginx' });
    expect(mockDocker.pull).toHaveBeenCalledWith('nginx', expect.any(Function));
  });

  it('is exposed in tools/list', () => {
    expect(MCP_TOOLS.some(t => t.name === 'docker_login')).toBe(true);
    const s = MCP_TOOLS.find(t => t.name === 'docker_login').inputSchema;
    expect(s.required).toEqual(['username', 'password']);
  });
});

describe('docker_copy host directions', () => {
  const cp = require('child_process');
  let execSpy;

  afterEach(() => { if (execSpy) execSpy.mockRestore(); });

  it('from_host shells out to docker cp with the host path as source', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, '', ''));
    const result = await handleMCPTool('docker_copy', {
      id: 'web', direction: 'from_host',
      host_path: '/srv/backups/file.bin', container_path: '/data/'
    });
    const argv = execSpy.mock.calls[0][1];
    expect(argv).toEqual(['cp', '/srv/backups/file.bin', 'web:/data/']);
    expect(result.content[0].text).toContain('/data/');
  });

  it('to_host shells out to docker cp with the host path as destination', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) => cb(null, '', ''));
    await handleMCPTool('docker_copy', {
      id: 'web', direction: 'to_host',
      container_path: '/var/log/app.log', host_path: '/app/transfer/app.log'
    });
    expect(execSpy.mock.calls[0][1]).toEqual(['cp', 'web:/var/log/app.log', '/app/transfer/app.log']);
  });

  it('refuses a relative host_path', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation(() => {});
    await expect(
      handleMCPTool('docker_copy', { id: 'web', direction: 'from_host', host_path: 'rel.bin', container_path: '/data/' })
    ).rejects.toThrow(/absolute/i);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('surfaces docker cp failures cleanly', async () => {
    execSpy = jest.spyOn(cp, 'execFile').mockImplementation((bin, argv, opts, cb) =>
      cb(new Error('lstat /nope: no such file or directory'), '', ''));
    await expect(
      handleMCPTool('docker_copy', { id: 'web', direction: 'from_host', host_path: '/nope', container_path: '/data/' })
    ).rejects.toThrow(/no such file/);
  });

  it('still supports the base64 directions unchanged', async () => {
    const result = await handleMCPTool('docker_copy', { id: 'mycontainer', direction: 'from', container_path: '/etc/hosts' });
    expect(result.content[0].text).toContain('Base64 tar of /etc/hosts');
  });

  it('schema documents host_path and the new directions', () => {
    const s = MCP_TOOLS.find(t => t.name === 'docker_copy').inputSchema;
    expect(s.properties.host_path).toBeDefined();
    expect(s.properties.direction.enum).toEqual(['from', 'to', 'from_host', 'to_host']);
  });
});

describe('quick wins: image history + network inspect', () => {
  it('docker_image_history lists layers newest-first with size and creator', async () => {
    mockDocker.getImage().history.mockResolvedValueOnce([
      { Id: 'sha256:top', Created: 1796000000, CreatedBy: 'RUN apt-get install', Size: 10485760, Tags: ['myapp:latest'] },
      { Id: 'sha256:base', Created: 1795000000, CreatedBy: 'FROM node:20-alpine', Size: 0, Tags: null }
    ]);
    const result = await handleMCPTool('docker_image_history', { image: 'myapp:latest' });
    expect(mockDocker.getImage).toHaveBeenCalledWith('myapp:latest');
    const data = JSON.parse(result.content[0].text);
    expect(data.layers).toHaveLength(2);
    expect(data.layers[0]).toMatchObject({ created_by: 'RUN apt-get install', size_bytes: 10485760 });
    expect(data.layers[0].tags).toEqual(['myapp:latest']);
    expect(data.layers[1].tags).toEqual([]);
  });

  it('docker_network_inspect reports driver, scope, subnet and attached containers', async () => {
    mockDocker.getNetwork().inspect.mockResolvedValueOnce({
      Id: 'net1234567890abcdef',
      Name: 'demonet',
      Driver: 'bridge',
      Scope: 'local',
      IPAM: { Config: [{ Subnet: '10.98.0.0/16' }] },
      Containers: {
        'abc123': { Name: 'demo-app-1', IPv4Address: '10.98.0.2/16' }
      }
    });
    const result = await handleMCPTool('docker_network_inspect', { name: 'demonet' });
    expect(mockDocker.getNetwork).toHaveBeenCalledWith('demonet');
    const data = JSON.parse(result.content[0].text);
    expect(data).toMatchObject({
      id: 'net1234567890abcdef', name: 'demonet', driver: 'bridge', scope: 'local', subnet: '10.98.0.0/16'
    });
    expect(data.containers).toEqual([{ id: 'abc123', name: 'demo-app-1', ipv4: '10.98.0.2/16' }]);
  });

  it('both are exposed in tools/list', () => {
    expect(MCP_TOOLS.find(t => t.name === 'docker_image_history')).toBeDefined();
    expect(MCP_TOOLS.find(t => t.name === 'docker_network_inspect')).toBeDefined();
    expect(MCP_TOOLS.find(t => t.name === 'docker_image_history').inputSchema.required).toEqual(['image']);
    expect(MCP_TOOLS.find(t => t.name === 'docker_network_inspect').inputSchema.required).toEqual(['name']);
  });
});

describe('compose addressing gap: compose_ps + compose_restart', () => {
  const stack = [
    { Id: 'c1111111111111', Names: ['/demo-app-1'], Image: 'nginx', State: 'running', Status: 'Up',
      Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.service': 'app',
                'com.docker.compose.project.working_dir': '/srv/demo' }, Ports: [] }
  ];

  it('docker_compose_ps accepts project_dir', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(stack);
    const result = await handleMCPTool('docker_compose_ps', { project_dir: '/srv/demo' });
    // project_dir resolution lists ALL containers (no label filter) and
    // filters on the working_dir label client-side
    expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
    expect(JSON.parse(result.content[0].text)[0].service).toBe('app');
  });

  it('docker_compose_restart accepts project_dir', async () => {
    mockDocker.listContainers.mockResolvedValueOnce(stack);
    const restart = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ restart });
    const result = await handleMCPTool('docker_compose_restart', { project_dir: '/srv/demo' });
    expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
    expect(restart).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).restarted).toEqual(['demo-app-1']);
  });

  it('docker_compose_restart still errors when nothing matches', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await expect(
      handleMCPTool('docker_compose_restart', { project_dir: '/nope' })
    ).rejects.toThrow(/No containers found/);
  });
});

describe('v2.12 quick wins', () => {
  it('docker_stop passes the signal through to container.stop', async () => {
    const stop = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ stop });
    await handleMCPTool('docker_stop', { id: 'web', signal: 'SIGKILL' });
    expect(stop).toHaveBeenCalledWith({ signal: 'SIGKILL' });
  });

  it('docker_stop without signal keeps the bare call', async () => {
    const stop = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ stop });
    await handleMCPTool('docker_stop', { id: 'web' });
    expect(stop).toHaveBeenCalledWith();
  });

  it('docker_stop schema documents the signal param', () => {
    const s = MCP_TOOLS.find(t => t.name === 'docker_stop').inputSchema;
    expect(s.properties.signal).toBeDefined();
  });

  it('docker_copy description documents host-path resolution context', () => {
    const d = MCP_TOOLS.find(t => t.name === 'docker_copy').description;
    expect(d).toMatch(/docker-mcp container's own filesystem/i);
  });

  it('docker_events description documents the daemon event buffer', () => {
    const d = MCP_TOOLS.find(t => t.name === 'docker_events').description;
    expect(d).toMatch(/buffer/i);
  });
});

describe('v2.13.3: self-guard on the server\'s own container', () => {
  const { callToolLogged, setSelfContainerIdForTests } = require('../server');
  const SELF_ID = 'a'.repeat(64);

  // The guard resolves the server's own container id (forced via the test
  // hook — the hostname heuristic doesn't arm outside a container), then
  // inspects the call target. Stub the lookups: anything named
  // 'self-container' inspects as SELF_ID; everything else as a different id.
  beforeEach(() => {
    setSelfContainerIdForTests(SELF_ID);
    mockDocker.getContainer.mockImplementation((id) => {
      const isSelf = id === 'self-container';
      return {
        inspect: jest.fn().mockResolvedValue({ Id: isSelf ? SELF_ID : 'target-full-id' }),
        remove: jest.fn().mockResolvedValue({}),
        rename: jest.fn().mockResolvedValue({})
      };
    });
  });

  it('stays inert when self cannot be resolved (non-container env)', async () => {
    setSelfContainerIdForTests(undefined); // back to the hostname heuristic — off on the host
    const remove = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockReturnValueOnce({ inspect: jest.fn().mockResolvedValue({ Id: 'x' }), remove });
    await handleMCPTool('docker_remove', { id: 'whatever' });
    expect(remove).toHaveBeenCalled();
  });

  it('docker_remove refuses to remove the server\'s own container', async () => {
    await expect(callToolLogged('docker_remove', { id: 'self-container' }, 't', 'k'))
      .rejects.toThrow(/is this MCP server's own container/);
  });

  it('the refusal names the target and the tool', async () => {
    await expect(callToolLogged('docker_remove', { id: 'self-container' }, 't', 'k'))
      .rejects.toThrow(/docker_remove refused: 'self-container'/);
  });

  it('docker_rename refuses to rename the server\'s own container', async () => {
    await expect(callToolLogged('docker_rename', { id: 'self-container', name: 'x' }, 't', 'k'))
      .rejects.toThrow(/own container/);
  });

  it('docker_container_recreate refuses to recreate the server\'s own container', async () => {
    await expect(callToolLogged('docker_container_recreate', { id: 'self-container' }, 't', 'k'))
      .rejects.toThrow(/own container/);
  });

  it('the refusal carries JSON-RPC code -32000', async () => {
    await expect(callToolLogged('docker_remove', { id: 'self-container' }, 't', 'k'))
      .rejects.toMatchObject({ code: -32000 });
  });

  it('docker_remove proceeds for non-self containers', async () => {
    const result = await callToolLogged('docker_remove', { id: 'other-container' }, 't', 'k');
    expect(result.content[0].text).toContain('Removed: other-container');
  });

  it('runs BEFORE the confirm-token flow, so no token is burned on a refusal', async () => {
    const prev = process.env.CONFIRM_TOOLS;
    process.env.CONFIRM_TOOLS = 'docker_remove';
    try {
      // Without the guard-first ordering this would resolve with a
      // confirm_required token instead of rejecting
      await expect(callToolLogged('docker_remove', { id: 'self-container' }, 't', 'k'))
        .rejects.toThrow(/own container/);
    } finally {
      if (prev === undefined) delete process.env.CONFIRM_TOOLS;
      else process.env.CONFIRM_TOOLS = prev;
    }
  });

  it('docker_stop refuses to stop the server\'s own container', async () => {
    await expect(callToolLogged('docker_stop', { id: 'self-container' }, 't', 'k'))
      .rejects.toThrow(/own container/);
  });

  it('non-guarded tools are unaffected even when the target looks like self', async () => {
    const start = jest.fn().mockResolvedValue({});
    mockDocker.getContainer.mockImplementation((id) => {
      const isSelf = id === 'self-container';
      return { inspect: jest.fn().mockResolvedValue({ Id: isSelf ? SELF_ID : 'target-full-id' }), start };
    });
    await handleMCPTool('docker_start', { id: 'self-container' });
    expect(start).toHaveBeenCalled();
  });
});

describe('v2.13.3: string command normalization', () => {
  it('docker_run wraps a compound string command in /bin/sh -c', async () => {
    await handleMCPTool('docker_run', { image: 'alpine', pull: false, command: 'pwd && whoami' });
    expect(mockDocker.createContainer.mock.calls[0][0].Cmd).toEqual(['/bin/sh', '-c', 'pwd && whoami']);
  });

  it('docker_run wraps a single-word string command as one-element argv', async () => {
    await handleMCPTool('docker_run', { image: 'alpine', pull: false, command: 'nginx' });
    expect(mockDocker.createContainer.mock.calls[0][0].Cmd).toEqual(['nginx']);
  });

  it('docker_run passes command arrays through untouched', async () => {
    await handleMCPTool('docker_run', { image: 'alpine', pull: false, command: ['npm', 'run', 'dev'] });
    expect(mockDocker.createContainer.mock.calls[0][0].Cmd).toEqual(['npm', 'run', 'dev']);
  });

  it('docker_exec wraps a compound string command in /bin/sh -c', async () => {
    const { Readable } = require('stream');
    const exec = jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(Readable.from([])),
      inspect: jest.fn().mockResolvedValue({ ExitCode: 0 })
    });
    mockDocker.getContainer.mockReturnValueOnce({ exec });
    await handleMCPTool('docker_exec', { id: 'c1', command: 'pwd && whoami' });
    expect(exec.mock.calls[0][0].Cmd).toEqual(['/bin/sh', '-c', 'pwd && whoami']);
  });
});

describe('v2.13.3: missing-name errors on destructive rm tools', () => {
  it.each([
    ['docker_image_rm', 'image'],
    ['docker_volume_rm', 'volume'],
    ['docker_network_rm', 'network']
  ])('%s without name fails clearly instead of \'undefined\'', async (tool, label) => {
    await expect(handleMCPTool(tool, {}))
      .rejects.toThrow(new RegExp(`${tool} requires 'name' — the ${label} to remove`));
  });
});

describe('v2.13.4: docker_ps filters — object form + strict validation (F5)', () => {
  it('accepts the prune-style filters object form', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await handleMCPTool('docker_ps', { filters: { name: 'verify-' } });
    expect(mockDocker.listContainers).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { name: ['verify-'] } })
    );
  });

  it('accepts the prune-style string-array filters form', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await handleMCPTool('docker_ps', { filters: ['status=exited', 'name=web'] });
    expect(mockDocker.listContainers).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { status: ['exited'], name: ['web'] } })
    );
  });

  it('merges flat args with the filters object', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await handleMCPTool('docker_ps', { name: 'web', filters: { status: 'running' } });
    expect(mockDocker.listContainers).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { name: ['web'], status: ['running'] } })
    );
  });

  it('rejects unrecognized filter keys with -32000 instead of ignoring them', async () => {
    await expect(handleMCPTool('docker_ps', { filters: { name: 'x', bogus: 'y' } }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringMatching(/unrecognized filter 'bogus'/) });
  });

  it('rejects non-string filter values with -32000', async () => {
    await expect(handleMCPTool('docker_ps', { status: ['running'] }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringMatching(/'status' must be a string/) });
  });

  it('still supports the flat documented form', async () => {
    mockDocker.listContainers.mockResolvedValueOnce([]);
    await handleMCPTool('docker_ps', { name: 'webui' });
    expect(mockDocker.listContainers).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { name: ['webui'] } })
    );
  });
});

describe('v2.13.4: docker_copy direction="to" accepts raw content (F6)', () => {
  const putArchive = () => jest.fn().mockResolvedValue({});
  const containerWith = (put) => mockDocker.getContainer.mockReturnValueOnce({ putArchive: put });

  it('wraps raw base64 content in a tar that lands at container_path', async () => {
    const put = putArchive();
    containerWith(put);
    const raw = Buffer.from('hello world').toString('base64');
    await handleMCPTool('docker_copy', { id: 'c1', direction: 'to', container_path: '/tmp/notes.txt', content: raw });
    expect(put).toHaveBeenCalled();
    const [tarBuf, opts] = put.mock.calls[0];
    expect(opts).toEqual({ path: '/tmp' });                 // extract into the parent dir
    expect(tarBuf.slice(0, 9).toString()).toBe('notes.txt'); // entry name = basename (NUL-padded to 100)
    expect(tarBuf.slice(257, 262).toString()).toBe('ustar');  // valid tar magic
    const size = parseInt(tarBuf.slice(124, 136).toString().trim(), 8);
    expect(size).toBe(11);
    expect(tarBuf.slice(512, 512 + 11).toString()).toBe('hello world');
  });

  it('passes a real tar archive through to the container_path unchanged', async () => {
    const put = putArchive();
    containerWith(put);
    // 512-byte zero header block + end blocks — magic at 257 makes it "a tar"
    const tar = Buffer.alloc(2048);
    tar.write('ustar', 257, 'ascii');
    const b64 = tar.toString('base64');
    await handleMCPTool('docker_copy', { id: 'c1', direction: 'to', container_path: '/data', content: b64 });
    expect(put.mock.calls[0][1]).toEqual({ path: '/data' });
  });

  it('refuses raw content with a directory-style container_path', async () => {
    const raw = Buffer.from('x').toString('base64');
    await expect(handleMCPTool('docker_copy', { id: 'c1', direction: 'to', container_path: '/tmp/', content: raw }))
      .rejects.toThrow(/container_path must be a file path when content is not a tar/);
  });
});

describe('v2.13.4: docker_exec env accepts dict and single string (F8)', () => {
  const execStub = () => {
    const { Readable } = require('stream');
    const exec = jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(Readable.from([])),
      inspect: jest.fn().mockResolvedValue({ ExitCode: 0 })
    });
    mockDocker.getContainer.mockReturnValueOnce({ exec });
    return exec;
  };

  it('converts a {KEY: value} object to KEY=VALUE array', async () => {
    const exec = execStub();
    await handleMCPTool('docker_exec', { id: 'c1', command: ['env'], env: { FOO: 'bar', N: '1' } });
    expect(exec.mock.calls[0][0].Env).toEqual(['FOO=bar', 'N=1']);
  });

  it('accepts a single KEY=VALUE string', async () => {
    const exec = execStub();
    await handleMCPTool('docker_exec', { id: 'c1', command: ['env'], env: 'FOO=bar' });
    expect(exec.mock.calls[0][0].Env).toEqual(['FOO=bar']);
  });

  it('passes an array through untouched', async () => {
    const exec = execStub();
    await handleMCPTool('docker_exec', { id: 'c1', command: ['env'], env: ['A=1'] });
    expect(exec.mock.calls[0][0].Env).toEqual(['A=1']);
  });
});
