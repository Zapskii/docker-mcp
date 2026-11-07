const { Readable } = require('stream');

function makeReadable(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

const mockContainer = {
  top:        jest.fn().mockResolvedValue({ Titles: ['UID', 'PID', 'CMD'], Processes: [['root', '123', 'nginx: master process']] }),
  stop:       jest.fn().mockResolvedValue({}),
  start:      jest.fn().mockResolvedValue({}),
  restart:    jest.fn().mockResolvedValue({}),
  remove:     jest.fn().mockResolvedValue({}),
  rename:     jest.fn().mockResolvedValue({}),
  logs:       jest.fn().mockResolvedValue(makeReadable(Buffer.from(''))),
  inspect:    jest.fn().mockResolvedValue({ Id: 'abc123', Name: '/test' }),
  stats:      jest.fn().mockResolvedValue({
    cpu_stats:    { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
    precpu_stats: { cpu_usage: { total_usage: 900  }, system_cpu_usage: 9000  },
    memory_stats: { usage: 104857600, limit: 1073741824 }
  }),
  exec: jest.fn().mockResolvedValue({
    start:   jest.fn().mockResolvedValue(makeReadable(Buffer.from('hello'))),
    inspect: jest.fn().mockResolvedValue({ ExitCode: 0 })
  }),
  getArchive: jest.fn().mockImplementation(() =>
    Promise.resolve(makeReadable(Buffer.from('fake-tar')))
  ),
  putArchive: jest.fn().mockResolvedValue({}),
};

const mockImage = {
  inspect: jest.fn().mockResolvedValue({ Id: 'sha256:abc', RepoTags: ['test:latest'] }),
  remove:  jest.fn().mockResolvedValue({}),
  tag:     jest.fn().mockResolvedValue({}),
  history: jest.fn().mockResolvedValue([]),
};

const mockVolume  = {
  remove:  jest.fn().mockResolvedValue({}),
  inspect: jest.fn().mockResolvedValue({ Name: 'mock-volume', Mountpoint: '/var/lib/docker/volumes/mock-volume/_data' }),
};

const mockNetwork = {
  remove:     jest.fn().mockResolvedValue({}),
  connect:    jest.fn().mockResolvedValue({}),
  disconnect: jest.fn().mockResolvedValue({}),
  inspect:    jest.fn().mockResolvedValue({ Id: 'net1234567890', Name: 'mock-net', Driver: 'bridge', Scope: 'local', IPAM: { Config: [] }, Containers: {} }),
};

const Docker = jest.fn().mockImplementation(() => ({
  listContainers:  jest.fn().mockResolvedValue([]),
  getContainer:    jest.fn().mockReturnValue(mockContainer),
  createContainer: jest.fn().mockResolvedValue({ ...mockContainer, id: 'newcontainer123' }),
  pull:            jest.fn().mockImplementation((image, cb) => cb(null, makeReadable(Buffer.from('')))),
  listImages:      jest.fn().mockResolvedValue([]),
  getImage:        jest.fn().mockReturnValue(mockImage),
  listVolumes:     jest.fn().mockResolvedValue({ Volumes: [] }),
  createVolume:    jest.fn().mockResolvedValue({}),
  getVolume:       jest.fn().mockReturnValue(mockVolume),
  listNetworks:    jest.fn().mockResolvedValue([]),
  getEvents:       jest.fn().mockResolvedValue(makeReadable(Buffer.from(''))),
  checkAuth:       jest.fn().mockImplementation((opts, cb) => cb(null, { Status: 'Login Succeeded' })),
  createNetwork:   jest.fn().mockResolvedValue({}),
  getNetwork:      jest.fn().mockReturnValue(mockNetwork),
  pruneImages:     jest.fn().mockResolvedValue({ ImagesDeleted: [], SpaceReclaimed: 0 }),
  pruneContainers: jest.fn().mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 }),
  df: jest.fn().mockResolvedValue({
    LayersSize: 1000,
    Images: [
      { Id: 'img-a', Size: 500, Containers: 1 },
      { Id: 'img-b', Size: 500, Containers: 0 }
    ],
    Containers: [
      { Id: 'c1', Names: ['/web'], Image: 'nginx', SizeRw: 100, State: 'running' },
      { Id: 'c2', Names: ['/old'], Image: 'nginx', SizeRw: 100, State: 'exited' }
    ],
    Volumes: [
      { Name: 'v1', SizeUsage: 300 },
      { Name: 'v2' }
    ],
    BuildCache: [
      { ID: 'bc1', Size: 300, InUse: false },
      { ID: 'bc2', Size: 700, InUse: true }
    ]
  }),
  info: jest.fn().mockResolvedValue({
    ServerVersion: '24.0.0', OperatingSystem: 'Linux', Architecture: 'x86_64',
    NCPU: 4, MemTotal: 8589934592,
    ContainersRunning: 1, ContainersStopped: 2, ContainersPaused: 0,
    Images: 5, Driver: 'overlay2'
  }),
  modem: {
    demuxStream:    jest.fn((stream, out, err) => { out.end(); err.end(); stream.resume(); }),
    followProgress: jest.fn((stream, cb) => cb(null, [])),
    // Verbose /system/df is optional — tests that need it override this
    dial:           jest.fn((opts, cb) => cb(new Error('verbose df unavailable'))),
  },
}));

module.exports = Docker;
