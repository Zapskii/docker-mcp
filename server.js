// server.js - Docker MCP Server
const VERSION = '2.13.6';

// Schema fragment for the confirm flag on destructive tools — defined here
// because the MCP_TOOLS array below references it
const CONFIRM_FLAG_SCHEMA = {
  type: 'boolean',
  description: 'Required for this destructive tool: pass confirm: true to proceed. Without it the call is rejected with a description of what would be affected.'
};
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { PassThrough } = require('stream');
const cp = require('child_process');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const WebSocket = require('ws');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Result shape for tools whose payload is a JSON object: the same object goes
// out as human-readable text AND as MCP structuredContent, so agent clients
// can parse it reliably instead of scraping JSON out of a string.
// MCP requires structuredContent to be an object, so list payloads go out as
// { items: [...] } there; strict clients reject the whole result otherwise.
function jsonResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: Array.isArray(obj) ? { items: obj } : obj
  };
}

// Named per-agent API keys: API_KEY_<AGENT>=<secret> (e.g. API_KEY_CLAUDE).
// Legacy API_KEY is accepted as the unnamed 'default' agent.
function parseApiKeys(env = process.env) {
  const keys = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (name === 'API_KEY' && value) keys.set(value, 'default');
    else if (name.startsWith('API_KEY_') && value) keys.set(value, name.slice(8).toLowerCase());
  }
  return keys;
}
const API_KEYS = parseApiKeys();
if (API_KEYS.size === 0 && require.main === module) {
  console.error('FATAL: set API_KEY or at least one API_KEY_<AGENT> env var');
  process.exit(1);
}

// Active MCP sessions — Streamable HTTP transport (2025-03-26)
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // idle sessions are swept after 1 hour

function sweepSessions(now = Date.now()) {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - (s.lastSeen || s.created) > SESSION_TTL_MS) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

function checkAuth(req, res) {
  const providedKey = req.headers['x-api-key'];
  const agent = providedKey && API_KEYS.get(providedKey);
  if (!agent) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized - Invalid or missing API key' }));
    return false;
  }
  req.agentName = agent;
  req.keyFp = keyFingerprint(providedKey);
  return true;
}

// Safe subprocess runner — no shell, no injection risk
function runSafe(bin, argv, cwd, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    cp.execFile(bin, argv, { cwd, timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

// Async job registry — in-memory only (jobs are transient; lost on restart)
const JOBS = new Map();
const JOB_PROGRESS_LIMIT = 50;
const JOB_HISTORY_LIMIT = 100;

// Run `fn(job, signal)` in the background; job_id is returned immediately.
// fn logs progress via job.log(line); callers can abort via the signal.
async function startJob(type, fn) {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job = {
    id, type, status: 'running',
    started_at: new Date().toISOString(), finished_at: null,
    progress: [], result: null, error: null,
    controller,
    signal: controller.signal,
    log: line => {
      if (line == null || line === '') return;
      job.progress.push(String(line));
      if (job.progress.length > JOB_PROGRESS_LIMIT) job.progress.shift();
    }
  };
  JOBS.set(id, job);
  fn(job, controller.signal)
    .then(result => {
      job.status = 'done'; job.result = result;
      job.finished_at = new Date().toISOString();
    })
    .catch(err => {
      job.status = (err.message === 'cancelled' || controller.signal.aborted) ? 'cancelled' : 'error';
      job.error = err.message;
      job.finished_at = new Date().toISOString();
    });
  // Evict oldest finished jobs to bound memory
  if (JOBS.size > JOB_HISTORY_LIMIT) {
    for (const j of JOBS.values()) {
      if (j.status !== 'running') { JOBS.delete(j.id); }
      if (JOBS.size <= JOB_HISTORY_LIMIT) break;
    }
  }
  return { job_id: id, status: 'started', type };
}

// Docker image pull with optional job progress + cancellation
// ── Registry credentials (docker_login) ─────────────────────────────────────
// Stored in memory only — never written to disk; wiped on restart.
const REGISTRY_AUTH = new Map(); // registryHost → {username, password}

// Credentials for an image ref, or null when none are stored for its registry
function registryAuthFor(image) {
  const { registryHost } = parseImageRef(image);
  const creds = REGISTRY_AUTH.get(registryHost);
  if (!creds) return null;
  return { ...creds, serveraddress: registryHost === 'registry-1.docker.io'
    ? 'https://index.docker.io/v1/' : `https://${registryHost}` };
}

function pullImage(image, job, signal) {
  return new Promise((resolve, reject) => {
    const creds = registryAuthFor(image);
    const pullCb = (err, stream) => {
      if (err) return reject(err);
      const onAbort = () => {
        try { stream.destroy(); } catch (_) { /* already gone */ }
        reject(new Error('cancelled'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }
      docker.modem.followProgress(stream, (err, res) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(res);
      }, evt => {
        if (job && (evt.status || evt.progress)) {
          job.log(`${evt.id ? evt.id + ' ' : ''}${evt.status || ''} ${evt.progress || ''}`.trim());
        }
      });
    };
    if (creds) docker.pull(image, { authconfig: creds }, pullCb);
    else docker.pull(image, pullCb);
  });
}

// Like runSafe, but streams output into a job and aborts the child on cancel
function runCancelable(bin, argv, cwd, job, signal, timeout = 600_000) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(bin, argv, { cwd, timeout }, (error, stdout, stderr) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
    const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) { /* exited */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
    child.stdout?.on('data', d => job.log(String(d).trim()));
    child.stderr?.on('data', d => job.log(String(d).trim()));
  });
}

// Demux Docker multiplexed stdout/stderr stream (8-byte binary header per chunk)
function demuxStream(stream) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const out = new PassThrough();
    const err = new PassThrough();
    out.on('data', c => stdout.push(c));
    err.on('data', c => stderr.push(c));
    docker.modem.demuxStream(stream, out, err);
    stream.on('end', () => {
      out.end();
      err.end();
      resolve(Buffer.concat([...stdout, ...stderr]).toString('utf8'));
    });
    stream.on('error', reject);
  });
}

// Demux a complete Docker multiplexed response body held in a Buffer.
// dockerode 4.x resolves logs() with follow:false to a Buffer that still
// carries the 8-byte frame headers ([type, 0, 0, 0, size uint32BE]).
// Unframed input (a plain log string) passes through unchanged.
function demuxBuffer(buf) {
  const stdout = [];
  const stderr = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off];
    const size = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    if (type === 1 || type === 2) (type === 1 ? stdout : stderr).push(payload);
    // type 0 (stdin) and 3+ are not client-visible; skip their payloads
    off += 8 + size;
  }
  // No valid framing found anywhere — treat as plain text
  if (stdout.length === 0 && stderr.length === 0) return buf.toString('utf8');
  return Buffer.concat([...stdout, ...stderr]).toString('utf8');
}

const RESTART_POLICIES = ['no', 'on-failure', 'always', 'unless-stopped'];

function parseRestartPolicy(policy, maxRetries) {
  if (policy === undefined) return undefined;
  if (!RESTART_POLICIES.includes(policy)) {
    throw new Error(`Invalid restart policy: ${policy}. Use one of: ${RESTART_POLICIES.join(', ')}`);
  }
  return { Name: policy, MaximumRetryCount: maxRetries || 0 };
}

// Map a tool-level healthcheck object onto Docker's Healthconfig. `test` is a
// shell string (wrapped in CMD-SHELL) or an exec-form array; *_s values are
// seconds, Docker wants nanoseconds. Unset fields are omitted so the daemon
// keeps its defaults.
function parseHealthcheck(hc) {
  if (!hc) return undefined;
  const out = {};
  if (hc.test !== undefined) out.Test = Array.isArray(hc.test) ? hc.test : ['CMD-SHELL', String(hc.test)];
  if (hc.interval_s !== undefined) out.Interval = hc.interval_s * 1e9;
  if (hc.timeout_s !== undefined) out.Timeout = hc.timeout_s * 1e9;
  if (hc.retries !== undefined) out.Retries = hc.retries;
  if (hc.start_period_s !== undefined) out.StartPeriod = hc.start_period_s * 1e9;
  return Object.keys(out).length ? out : undefined;
}

// docker_exec env: the Docker API wants an array of KEY=VALUE strings, but
// agents naturally pass a { KEY: value } object (like docker_run's env) or a
// single string — accept all three instead of dying in Go unmarshalling
function normalizeEnvArray(env) {
  if (env === undefined || env === null) return undefined;
  if (typeof env === 'string') return [env];
  if (Array.isArray(env)) return env.map(String);
  if (typeof env === 'object') return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const err = new Error("docker_exec 'env' must be an array of KEY=VALUE strings, a { KEY: value } object, or a single KEY=VALUE string");
  err.code = -32000;
  throw err;
}

// The Docker API wants Cmd as an argv array; agents often pass a single
// string. Wrap a string in a shell so compound commands (`a && b`, pipes,
// env expansion) run the way the caller meant them; a single word becomes
// one-element argv; arrays pass through untouched; empty → image default.
function normalizeCommand(command) {
  if (typeof command !== 'string') return command;
  if (command.trim() === '') return undefined;
  return /[\s|&;<>()$`"'*?[\]{}]/.test(command)
    ? ['/bin/sh', '-c', command]
    : [command];
}

// ── docker_outdated: compare local image digests against the registry ───────

// Parse an image reference into registry host / repo / tag (+ optional pinned
// digest). Handles: nginx, nginx:1.25, user/repo:tag, registry:5000/repo:tag,
// ghcr.io/org/repo:tag, repo@sha256:digest.
function parseImageRef(image) {
  let ref = String(image).trim();
  let pinnedDigest = null;
  const at = ref.indexOf('@');
  if (at !== -1) { pinnedDigest = ref.slice(at + 1); ref = ref.slice(0, at); }
  let tag = 'latest';
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) { tag = ref.slice(colon + 1) || 'latest'; ref = ref.slice(0, colon); }
  let fullRepo = ref;                                // repo exactly as written
  let registryHost = 'registry-1.docker.io';
  const first = ref.split('/')[0];
  if (ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registryHost = first;
    fullRepo = ref.slice(first.length + 1);
  }
  if (registryHost === 'docker.io') registryHost = 'registry-1.docker.io';
  const hubRepo = registryHost === 'registry-1.docker.io' && !fullRepo.includes('/')
    ? `library/${fullRepo}`                          // docker hub official namespace
    : fullRepo;
  return { registryHost, hubRepo, fullRepo, tag, pinnedDigest };
}

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json'
].join(', ');

// Anonymous-pull manifest digest for a parsed image ref. Docker Hub gets the
// standard anonymous token flow; other registries are tried directly.
async function fetchRemoteDigest(parsed) {
  const headers = { Accept: MANIFEST_ACCEPT };
  const creds = REGISTRY_AUTH.get(parsed.registryHost);
  if (creds) headers.Authorization = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  if (parsed.registryHost === 'registry-1.docker.io') {
    const auth = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${parsed.hubRepo}:pull`,
      creds ? { headers: { Authorization: headers.Authorization } } : undefined
    );
    if (!auth.ok) throw new Error(`registry auth failed (HTTP ${auth.status})`);
    const { token } = await auth.json();
    if (!token) throw new Error('registry auth returned no token');
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`https://${parsed.registryHost}/v2/${parsed.hubRepo}/manifests/${parsed.pinnedDigest || parsed.tag}`, { headers });
  if (res.status === 401 || res.status === 403) throw new Error('registry requires authentication');
  if (res.status === 404) throw new Error('tag not found in registry (locally built image?)');
  if (res.status === 429) throw new Error('registry rate limit hit — try again later');
  if (!res.ok) throw new Error(`registry error HTTP ${res.status}`);
  const digest = res.headers.get('docker-content-digest');
  if (!digest) throw new Error('registry did not return a digest');
  return digest;
}

// Pick the local registry digest for an image: the RepoDigests entry matching
// the ref (repo as written or in hub-normalized form), else a sole entry.
function localDigestFor(imageInspect, parsed) {
  const digests = imageInspect.RepoDigests || [];
  const stripHub = r => r.replace(/^docker\.io\//, '');
  for (const d of digests) {
    const eq = d.indexOf('@');
    if (eq === -1) continue;
    const repo = stripHub(d.slice(0, eq));
    if (repo === parsed.hubRepo || repo === parsed.fullRepo) return d.slice(eq + 1);
  }
  if (digests.length === 1) return digests[0].slice(digests[0].indexOf('@') + 1);
  return null;
}

const MCP_TOOLS = [
  {
    name: 'docker_ps',
    description: 'List Docker containers',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Show all containers', default: false },
        name: { type: 'string', description: 'Filter by name substring' },
        label: { type: 'string', description: 'Filter by label, e.g. key=value' },
        status: { type: 'string', description: 'Filter by state: created | running | paused | restarting | removing | exited | dead' }
      }
    }
  },
  {
    name: 'docker_run',
    description: 'Run a new container. ports format: { "hostPort": "containerPort" }',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Docker image name' },
        name: { type: 'string', description: 'Container name' },
        command: { type: 'array', items: { type: 'string' }, description: 'Command + args as an array. A single string is accepted and run via /bin/sh -c.' },
        ports: { type: 'object', description: 'Port mappings: { "hostPort": "containerPort" }' },
        env: { type: 'object', description: 'Environment variables' },
        volumes: { type: 'array', description: 'Volume mounts' },
        pull: { type: 'boolean', description: 'Pull image before creating (default true). Set false to use a locally cached image.', default: true },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately and runs in the background — check with docker_job_status' },
        restartPolicy: { type: 'string', description: 'Restart policy: no | on-failure | always | unless-stopped', enum: ['no', 'on-failure', 'always', 'unless-stopped'] },
        maximumRetryCount: { type: 'number', description: 'Retry count for on-failure policy (default 0)' },
        healthcheck: {
          type: 'object',
          description: 'Healthcheck for the new container (usable with docker_wait condition=healthy and recreate rollback)',
          properties: {
            test: { type: ['string', 'array'], description: 'Shell command string (wrapped in CMD-SHELL) or exec-form array, e.g. "curl -f http://localhost/" ' },
            interval_s: { type: 'number', description: 'Seconds between checks (default 30s daemon default)' },
            timeout_s: { type: 'number', description: 'Seconds before a single check counts as failed' },
            retries: { type: 'integer', description: 'Consecutive failures before unhealthy' },
            start_period_s: { type: 'number', description: 'Grace period before failures count toward retries' }
          }
        }
      },
      required: ['image']
    }
  },
  {
    name: 'docker_stop',
    description: 'Stop a container',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        signal: { type: 'string', description: 'Signal to send instead of SIGTERM (e.g. SIGKILL for a hard kill — the container dies with exit code 137)' }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_logs',
    description: 'Get container logs',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        tail: { type: 'integer', default: 100 },
        follow: { type: 'boolean', description: 'Stream logs via WebSocket', default: false },
        since: { type: 'string', description: 'Only show logs after this point: duration relative to now (10m, 1h30m), RFC3339 timestamp, or unix epoch' },
        until: { type: 'string', description: 'Only show logs before this point: duration/RFC3339/epoch (same forms as since)' },
        timestamps: { type: 'boolean', description: 'Prefix each line with an RFC3339 timestamp', default: false }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_events',
    description: 'List recent Docker daemon events (one-shot snapshot, not a live stream). Events come from the daemon\'s in-memory buffer (~256 entries) — it rotates within minutes under event-heavy load, so historical queries (since=30m) only see what is still buffered. Query soon after the events you care about.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start of the window: duration relative to now (10m, 1h), RFC3339 timestamp, or unix epoch (default 10m)' },
        until: { type: 'string', description: 'End of the window: duration/RFC3339/epoch (default now)' },
        filters: {
          type: 'object',
          properties: {
            container: { type: 'string', description: 'Container ID or name' },
            type: { type: 'string', description: 'Event type, e.g. container, image, volume, network' },
            event: { type: 'string', description: 'Action, e.g. start, die, pull, destroy' }
          }
        },
        tail: { type: 'integer', description: 'Keep only the last N events' }
      }
    }
  },
  {
    name: 'docker_exec',
    description: 'Execute command in container',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        command: { type: 'array', items: { type: 'string' }, description: 'Command + args as an array. A single string is accepted and run via /bin/sh -c.' },
        workdir: { type: 'string', description: 'Working directory inside the container for this exec' },
        user: { type: 'string', description: 'User (or user:group) to run the command as' },
        env: { type: 'array', items: { type: 'string' }, description: 'Extra environment variables: array of KEY=VALUE strings, a { KEY: value } object, or a single KEY=VALUE string' },
        timeout: { type: 'number', description: 'Seconds before the exec is killed (default 60)' }
      },
      required: ['id', 'command']
    }
  },
  {
    name: 'docker_images',
    description: 'List Docker images',
    inputSchema: {
      type: 'object',
      properties: {
        dangling: { type: 'boolean', description: 'Only list dangling (untagged, unreferenced) images', default: false }
      }
    }
  },
  {
    name: 'docker_image_history',
    description: 'Show the layer history of an image (newest first): layer command, created timestamp, size, and tags where present',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Image name or ID' }
      },
      required: ['image']
    }
  },
  {
    name: 'docker_login',
    description: 'Log in to a container registry: validates the credentials against the registry, then uses them for subsequent pulls and for docker_outdated digest lookups on private images. Credentials are held in memory only (wiped on restart) and never appear in logs.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', description: 'Registry host (e.g. registry.example.com, ghcr.io). Omit for Docker Hub.' },
        username: { type: 'string', description: 'Registry username' },
        password: { type: 'string', description: 'Registry password or access token (redacted from the audit log)' }
      },
      required: ['username', 'password']
    }
  },
  {
    name: 'docker_pull',
    description: 'Pull a Docker image',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Image name' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately — a 2 GB pull outlives client timeouts; poll docker_job_status' }
      },
      required: ['image']
    }
  },
  {
    name: 'docker_remove',
    description: 'Remove a container',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        force: { type: 'boolean', default: false }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_start',
    description: 'Start a stopped container',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_restart',
    description: 'Restart a container',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        timeout: { type: 'number', description: 'Seconds to wait before killing (default 10)', default: 10 }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_inspect',
    description: 'Get detailed information about a container or image (env vars, mounts, ports, config)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID/name or image name/ID' },
        type: { type: 'string', enum: ['container', 'image'], description: 'What to inspect (default: container)', default: 'container' }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_compose_up',
    description: 'Deploy Docker Compose stack',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name — resolved to the stack directory via the containers\' working_dir label (needs at least one existing container of the project)' },
        project_dir: { type: 'string', description: 'Directory containing docker-compose.yml (alternative to project)' },
        build: { type: 'boolean', description: 'Build images before starting', default: false },
        detach: { type: 'boolean', description: 'Run in background', default: true },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately and runs in the background — check with docker_job_status' }
      }
    }
  },
  {
    name: 'docker_compose_down',
    description: 'Stop and remove Docker Compose stack',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name — resolved to the stack directory via the containers\' working_dir label' },
        project_dir: { type: 'string', description: 'Directory containing docker-compose.yml (alternative to project)' },
        volumes: { type: 'boolean', description: 'Remove named volumes', default: false },
        confirm: CONFIRM_FLAG_SCHEMA
      }
    }
  },
  {
    name: 'docker_compose_logs',
    description: 'Get logs from a Docker Compose stack',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name — resolved to the stack directory via the containers\' working_dir label' },
        project_dir: { type: 'string', description: 'Directory containing docker-compose.yml (alternative to project)' },
        file: { type: 'string', description: 'Legacy: path to a specific docker-compose.yml file (wins over project/project_dir if given)' },
        service: { type: 'string', description: 'Optional: specific service name to get logs for' },
        tail: { type: 'number', description: 'Number of lines from end (default 100)', default: 100 },
        since: { type: 'string', description: 'Only show logs since this duration (e.g. 10m, 1h) or timestamp' }
      }
    }
  },
  {
    name: 'docker_stats',
    description: 'Get container resource usage (CPU, memory, network)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name (optional, shows all if omitted)' }
      }
    }
  },
  {
    name: 'docker_build',
    description: 'Build Docker image from Dockerfile',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Build context directory' },
        dockerfile: { type: 'string', description: 'Path to Dockerfile', default: 'Dockerfile' },
        tag: { type: 'string', description: 'Image tag (e.g., myapp:latest)' },
        build_args: { type: 'object', description: 'Build arguments' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately and runs in the background — check with docker_job_status' }
      },
      required: ['context', 'tag']
    }
  },
  {
    name: 'docker_volume_ls',
    description: 'List Docker volumes',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Only list volumes with this label: key or key=value (e.g. keep=true)' }
      }
    }
  },
  {
    name: 'docker_volume_create',
    description: 'Create a Docker volume',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Volume name' },
        driver: { type: 'string', description: 'Volume driver', default: 'local' }
      },
      required: ['name']
    }
  },
  {
    name: 'docker_volume_rm',
    description: 'Remove a Docker volume',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Volume name' },
        force: { type: 'boolean', description: 'Force removal', default: false },
        confirm: CONFIRM_FLAG_SCHEMA
      },
      required: ['name']
    }
  },
  {
    name: 'docker_network_ls',
    description: 'List Docker networks',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'docker_network_inspect',
    description: 'Inspect a Docker network: driver, scope, IPAM subnet, and attached containers',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Network name or ID' }
      },
      required: ['name']
    }
  },
  {
    name: 'docker_network_create',
    description: 'Create a Docker network',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Network name' },
        driver: { type: 'string', description: 'Network driver', default: 'bridge' }
      },
      required: ['name']
    }
  },
  {
    name: 'docker_network_rm',
    description: 'Remove a Docker network',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Network name' },
        confirm: CONFIRM_FLAG_SCHEMA
      },
      required: ['name']
    }
  },
  {
    name: 'docker_image_prune',
    description: 'Remove unused Docker images',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Remove all unused images, not just dangling', default: false },
        filters: {
          type: ['array', 'object'],
          description: 'Scope the prune: ["until=24h", "label=keep.team=x", "name=nginx"]. label= is PROTECTION — images carrying that label are spared; until= only touches images created before that duration ago; name= restricts to repo tags containing the substring. Also accepts the object form { until, label, name }.',
          items: { type: 'string' }
        },
        dry_run: { type: 'boolean', description: 'List what WOULD be removed without removing anything', default: false }
      }
    }
  },
  {
    name: 'docker_image_rm',
    description: 'Remove a specific Docker image',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Image name or ID (e.g. nginx:latest)' },
        force: { type: 'boolean', description: 'Force removal even if image is used by stopped containers', default: false },
        confirm: CONFIRM_FLAG_SCHEMA
      },
      required: ['name']
    }
  },
  {
    name: 'docker_container_prune',
    description: 'Remove stopped containers (all of them by default, or scoped with filters)',
    inputSchema: {
      type: 'object',
      properties: {
        filters: {
          type: ['array', 'object'],
          description: 'Scope the prune: ["until=24h", "label=keep.team=x", "name=stale"]. label= is PROTECTION — containers carrying that label are spared; until= only touches containers created before that duration ago; name= restricts to names containing the substring. Also accepts the object form { until, label, name }.',
          items: { type: 'string' }
        },
        dry_run: { type: 'boolean', description: 'List what WOULD be removed without removing anything', default: false }
      }
    }
  },
  {
    name: 'docker_rename',
    description: 'Rename a container',
    inputSchema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Container ID or current name' },
        name: { type: 'string', description: 'New container name' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'docker_container_update',
    description: 'Update container settings at runtime (docker update): restart policy, CPU, memory, PIDs limit',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        restartPolicy: { type: 'string', description: 'Restart policy: no | on-failure | always | unless-stopped', enum: ['no', 'on-failure', 'always', 'unless-stopped'] },
        maximumRetryCount: { type: 'number', description: 'Retry count for on-failure policy (default 0)' },
        nanoCpus: { type: 'number', description: 'CPU quota in nanoseconds per second (e.g. 1000000000 = 1 CPU)' },
        cpuShares: { type: 'number', description: 'Relative CPU weight (default 1024)' },
        cpuPeriod: { type: 'number', description: 'CPU CFS period in microseconds' },
        cpuQuota: { type: 'number', description: 'CPU CFS quota in microseconds' },
        cpusetCpus: { type: 'string', description: 'CPUs to use, e.g. "0-2"' },
        memory: { type: 'number', description: 'Memory limit in bytes' },
        memorySwap: { type: 'number', description: 'Total memory+swap limit in bytes (-1 = unlimited)' },
        memoryReservation: { type: 'number', description: 'Soft memory limit in bytes' },
        pidsLimit: { type: 'number', description: 'Max number of processes (-1 = unlimited)' },
        healthcheck: {
          type: 'object',
          description: 'Replace the container healthcheck (usable with docker_wait condition=healthy and recreate rollback)',
          properties: {
            test: { type: ['string', 'array'], description: 'Shell command string (wrapped in CMD-SHELL) or exec-form array, e.g. "curl -f http://localhost/"' },
            interval_s: { type: 'number', description: 'Seconds between checks' },
            timeout_s: { type: 'number', description: 'Seconds before a single check counts as failed' },
            retries: { type: 'integer', description: 'Consecutive failures before unhealthy' },
            start_period_s: { type: 'number', description: 'Grace period before failures count toward retries' }
          }
        }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_system_info',
    description: 'Get Docker daemon info: version, OS, CPU count, total memory, container counts, image count, storage driver',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'docker_image_tag',
    description: 'Tag an existing image with a new repository name and tag',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source image name or ID (e.g. nginx:latest)' },
        repo:   { type: 'string', description: 'Target repository (e.g. myrepo/nginx)' },
        tag:    { type: 'string', description: 'Target tag (default: latest)', default: 'latest' }
      },
      required: ['source', 'repo']
    }
  },
  {
    name: 'docker_network_connect',
    description: 'Connect a running container to a network',
    inputSchema: {
      type: 'object',
      properties: {
        network:   { type: 'string', description: 'Network name or ID' },
        container: { type: 'string', description: 'Container name or ID' }
      },
      required: ['network', 'container']
    }
  },
  {
    name: 'docker_network_disconnect',
    description: 'Disconnect a container from a network',
    inputSchema: {
      type: 'object',
      properties: {
        network:   { type: 'string', description: 'Network name or ID' },
        container: { type: 'string', description: 'Container name or ID' }
      },
      required: ['network', 'container']
    }
  },
  {
    name: 'docker_copy',
    description: 'Copy files between containers, or between a container and host paths. direction="from"/"to": base64 tar in/out (small files only). direction="from_host": copies a host file into the container via docker cp. direction="to_host": copies a container path out to a host path. IMPORTANT: host paths resolve on the docker-mcp container\'s own filesystem (the mcp container is the docker cp client), not the daemon host as seen from SSH — /srv is mounted read-only there and /tmp is writable; for real transfers use the writable /app/transfer mount.',
    inputSchema: {
      type: 'object',
      properties: {
        id:             { type: 'string', description: 'Container ID or name' },
        direction:      { type: 'string', enum: ['from', 'to', 'from_host', 'to_host'], description: '"from"/"to" use base64 tar; "from_host"/"to_host" use host_path via docker cp' },
        container_path: { type: 'string', description: 'Path inside the container' },
        content:        { type: 'string', description: 'Base64-encoded tar archive — required when direction="to"' },
        host_path:      { type: 'string', description: 'Absolute host path — required when direction="from_host" or "to_host"' }
      },
      required: ['id', 'direction', 'container_path']
    }
  },
  {
    name: 'docker_system_df',
    description: 'Docker disk usage: totals and counts for images, containers, volumes and build cache, including reclaimable amounts — informs prune decisions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'docker_compose_ps',
    description: 'Per-project compose status: lists a project\'s services with state, ports and status via the com.docker.compose.project label — one glance tells you whether a stack is up.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name (as in docker compose ls)' }
      },
      required: ['project']
    }
  },
  {
    name: 'docker_compose_build',
    description: 'Build the images of a Docker Compose stack without starting it (sibling of compose_up).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name — resolved to the stack directory via the containers\' working_dir label' },
        project_dir: { type: 'string', description: 'Directory containing docker-compose.yml (alternative to project)' },
        service: { type: 'string', description: 'Build only this service (optional)' }
      }
    }
  },
  {
    name: 'docker_top',
    description: 'Process listing inside a container (docker top).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        ps_args: { type: 'string', description: 'ps arguments passed to the container (optional)' }
      },
      required: ['id']
    }
  },
  {
    name: 'docker_job_status',
    description: 'Check an async job started with mode="async" (pull, build, compose_up, container_recreate): status, recent progress lines and final result.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by the async call' },
        tail:   { type: 'number', description: 'How many recent progress lines to return (default 20)' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'docker_job_cancel',
    description: 'Cancel a running async job (pull, build, compose_up, container_recreate). The underlying pull stream is destroyed / the CLI child process is killed.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job ID to cancel' } },
      required: ['job_id']
    }
  },
  {
    name: 'docker_outdated',
    description: 'Check running containers for image updates: compares each image\'s local registry digest against the digest currently published for the same tag. update_available is true or false only when that comparison ran; it is null when it could not (digest-pinned, bare image ID, locally built, or a registry error), with the reason in note or error, and those containers are counted in not_assessed. A fixed version tag is only compared with itself, so newer releases need a separate check.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Only check this container (name or ID); default: all running containers' },
        all: { type: 'boolean', description: 'Include stopped containers too', default: false }
      }
    }
  },
  {
    name: 'docker_volume_restore',
    description: 'Restore a volume from a backup tar archive (as produced by docker_volume_backup): wipes the target volume and extracts the archive via an alpine helper container, then reports restored file/dir counts and a tree sha256. Refuses a non-empty target unless confirm: true is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Target volume name (must exist)' },
        backup_path: { type: 'string', description: 'Absolute host path to the backup file (e.g. /srv/backups/volume.tar[.gz]); .tar.gz/.tgz auto-detected' },
        confirm: CONFIRM_FLAG_SCHEMA,
        pull: { type: 'boolean', description: 'Pull the alpine helper image if missing (default true)', default: true }
      },
      required: ['name', 'backup_path']
    }
  },
  {
    name: 'docker_volume_backup',
    description: 'Back up a volume to a host path: streams the volume contents as a tar archive via a helper container (which writes the file directly on the host) and returns bytes written + sha256. The "save state before recreate" primitive.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Volume name' },
        out_path: { type: 'string', description: 'Absolute host path for the archive, e.g. /srv/backups/app_data.tar' },
        gzip: { type: 'boolean', description: 'gzip-compress the tar (default false)', default: false },
        pull: { type: 'boolean', description: 'Pull the alpine helper image if missing (default true)', default: true }
      },
      required: ['name', 'out_path']
    }
  },
  {
    name: 'docker_compose_pull',
    description: 'Pull the images of a Docker Compose stack (by project name — no compose file needed; the stack\'s containers are found via the com.docker.compose.project label). Works for stopped stacks. Long pulls → use mode="async" and poll docker_job_status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name (as in docker compose ls)' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately and runs in the background — check with docker_job_status' }
      },
      required: ['project']
    }
  },
  {
    name: 'docker_compose_restart',
    description: 'Restart every container of a Docker Compose stack (by project name — no compose file needed). Restarting a stopped container starts it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Compose project name (as in docker compose ls)' }
      },
      required: ['project']
    }
  },
  {
    name: 'docker_wait',
    description: 'Block until a container reaches a condition: healthy (healthcheck reports healthy) or next-exit (the container stops running). Returns the observed state; throws a timeout error if the deadline passes first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container ID or name' },
        condition: { type: 'string', enum: ['healthy', 'next-exit'], description: 'What to wait for (default next-exit)', default: 'next-exit' },
        timeout_s: { type: 'number', description: 'Seconds before giving up (required)' }
      },
      required: ['id', 'timeout_s']
    }
  },
  {
    name: 'docker_container_recreate',
    description: 'Recreate a container in place on the latest image: captures its full config (env, volumes, ports, restart policy, networks), pulls the image, renames the old container aside as a stopped backup, and starts an identical replacement. Rolls back automatically if the new container fails to start or exits within start_timeout_s.',
    inputSchema: {
      type: 'object',
      properties: {
        id:              { type: 'string', description: 'Container ID or name' },
        pull:            { type: 'boolean', description: 'Pull the image before recreating (default true)', default: true },
        backup_name:     { type: 'string', description: 'Name for the renamed old container (default <name>-old); kept stopped after success so you can roll back or clean up manually' },
        start_timeout_s: { type: 'number', description: 'Seconds to watch the new container for early exit before declaring success (default 30)' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'async returns {job_id} immediately and runs in the background — check with docker_job_status' }
      },
      required: ['id']
    }
  },
];

async function recreateRollback(old, name, newContainer, err, backupName) {
  const notes = [];
  if (newContainer) {
    try { await newContainer.remove({ force: true }); notes.push('removed failed new container'); }
    catch (e) { notes.push(`could not remove new container: ${e.message}`); }
  }
  try { await old.rename({ name }); notes.push(`renamed backup back to '${name}'`); }
  catch (e) { notes.push(`rename-back failed: ${e.message}`); }
  try { await old.start(); notes.push('restarted previous container'); }
  catch (e) { notes.push(`restart of previous container failed: ${e.message}`); }
  return jsonResult({
    recreated: false,
    rolled_back: true,
    error: err.message,
    backup_name: backupName,
    notes
  });
}

// Parse a Docker-style duration like '24h', '30m', '1h30m' → seconds
function parseDuration(s) {
  const re = /(\d+)(d|h|m|s)/g;
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, m;
  while ((m = re.exec(String(s))) !== null) total += Number(m[1]) * units[m[2]];
  if (total === 0) throw new Error(`Invalid duration: '${s}' (expected e.g. 24h, 30m, 1h30m)`);
  return total;
}

// Time filter for logs/events: a duration ('10m', '1h30m') relative to now, an
// RFC3339/ISO timestamp, or a raw unix epoch — all normalized to epoch seconds
// for the Docker API
function parseLogTime(v, label) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return Math.floor(n);
  try {
    return Math.floor(Date.now() / 1000 - parseDuration(v));
  } catch (_) { /* not a duration — try date parsing */ }
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  throw new Error(`Invalid ${label} value: '${v}' — use a duration (10m, 1h), an RFC3339 timestamp, or a unix epoch`);
}

// Normalize prune filters: accepts either the object form
// { until: '24h', label: 'key=value', name: 'substr' } or the string-array form
// ['until=24h', 'label=key=value', 'name=substr'].
// `label` is PROTECTION — matching containers/images are spared from the prune
// (the inverse of docker's include-only `label=` prune filter).
function normalizePruneFilters(f) {
  const out = {};
  const entries = Array.isArray(f)
    ? f.map(String)
    : (f && typeof f === 'object')
      ? Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${k}=${v}`)
      : [];
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const key = eq > 0 ? entry.slice(0, eq) : '';
    if (!['until', 'label', 'name'].includes(key)) {
      throw new Error(`Invalid prune filter: '${entry}' (expected until=<duration>, label=<key>[=<value>] or name=<substring>)`);
    }
    out[key] = entry.slice(eq + 1);
  }
  return out;
}

// Minimal ustar tar writer: one regular-file entry + end-of-archive blocks.
// No dependencies — used when docker_copy direction="to" receives raw
// (non-tar) base64 content so it lands at exactly the given container path.
function makeSingleFileTar(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error(`File name too long for tar: ${name}`);
  const header = Buffer.alloc(512);
  nameBuf.copy(header, 0);
  const octal = (num, len) => `${num.toString(8).padStart(len - 1, '0')}\0`;
  header.write(octal(0o644, 8), 100);                        // mode
  header.write(octal(0, 8), 108);                            // uid
  header.write(octal(0, 8), 116);                            // gid
  header.write(octal(content.length, 12), 124);              // size
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136); // mtime
  header.write('        ', 148);                             // checksum placeholder (spaces)
  header.write('0', 156);                                    // typeflag: regular file
  header.write('ustar\0', 257);                              // magic + version '00'
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024)]);
}

// docker_ps filters: flat args (name/label/status strings) and/or a filters
// object or string-array (uniform with the prune tools). Unknown keys and
// non-string values are rejected (-32000) — silently ignoring a filter form
// would make a caller believe its name filter was applied and target the
// wrong container.
function parsePsFilters(args) {
  const out = {};
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string') {
      const err = new Error(`docker_ps filter '${key}' must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`);
      err.code = -32000;
      throw err;
    }
    out[key] = [value];
  };
  add('name', args.name);
  add('label', args.label);
  add('status', args.status);
  if (args.filters !== undefined && args.filters !== null) {
    const entries = Array.isArray(args.filters)
      ? args.filters.map(String)
      : (typeof args.filters === 'object')
        ? Object.entries(args.filters)
        : null;
    if (!entries) {
      const err = new Error("docker_ps 'filters' must be an object ({ name, label, status }) or an array of 'key=value' strings");
      err.code = -32000;
      throw err;
    }
    for (const entry of entries) {
      let k, v;
      if (typeof entry === 'string') {            // string-array form: 'key=value'
        const eq = entry.indexOf('=');
        k = eq > 0 ? entry.slice(0, eq) : '';
        v = eq > 0 ? entry.slice(eq + 1) : '';
      } else {
        [k, v] = entry;                            // object form: [key, value]
      }
      if (!['name', 'label', 'status'].includes(k)) {
        const err = new Error(`docker_ps unrecognized filter '${k}' — supported: name, label, status`);
        err.code = -32000;
        throw err;
      }
      add(k, v);
    }
  }
  return out;
}

// A `label` filter value is either `key` (spares anything carrying the key,
// whatever its value) or `key=value` (spares exact matches)
function labelSpareMatcher(labelFilter) {
  const eq = labelFilter.indexOf('=');
  if (eq === -1) return labels => Boolean(labels) && labelFilter in labels;
  const key = labelFilter.slice(0, eq);
  const value = labelFilter.slice(eq + 1);
  return labels => Boolean(labels) && labels[key] === value;
}

// Per-container advisory lock for recreate — several authorized MCP clients
// hit this server concurrently; recreate's stop/rename/create sequence must
// never interleave for the same container. Locks expire (5 min) so a crashed
// call can't deadlock the container forever.
const RECREATE_LOCKS = new Map(); // containerName -> { ts }
const RECREATE_LOCK_TTL_MS = 5 * 60 * 1000;

function acquireRecreateLock(name) {
  const existing = RECREATE_LOCKS.get(name);
  if (existing && Date.now() - existing.ts < RECREATE_LOCK_TTL_MS) {
    const err = new Error(`recreate in progress for ${name}`);
    err.code = -32000;
    throw err;
  }
  RECREATE_LOCKS.set(name, { ts: Date.now() });
}

function releaseRecreateLock(name) {
  RECREATE_LOCKS.delete(name);
}

// Networks a recreate must re-attach by hand. docker inspect returns no
// top-level NetworkingConfig (it exposes NetworkSettings.Networks), and
// HostConfig.NetworkMode only covers the primary network — so every other
// attachment would be silently dropped on create, taking name resolution over
// that network with it while published host ports kept working. Default networks are excluded
// because NetworkMode already governs them and they can't be attached
// explicitly; the NetworkMode network is excluded to avoid a double attach.
function extraNetworkEndpoints(info, name) {
  const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none', 'default']);
  const mode = info.HostConfig?.NetworkMode || 'default';
  return Object.entries(info.NetworkSettings?.Networks || {})
    .filter(([network]) => !DEFAULT_NETWORKS.has(network) && network !== mode)
    .map(([network, ep]) => ({
      network,
      config: {
        // Docker auto-adds the container's own name as an alias; pass it
        // explicitly so resolution never depends on that. The stale old
        // container-id alias is not copied — it lives in DNSNames, not Aliases.
        Aliases: [...new Set([...(ep.Aliases || []), name])],
        ...(ep.IPAMConfig ? { IPAMConfig: ep.IPAMConfig } : {})
      }
    }));
}

async function recreateContainer(args, job, signal) {
  const old = docker.getContainer(args.id);
  const info = await old.inspect();
  const name = info.Name.replace(/^\//, '');
  // Re-bind by immutable ID: if the caller passed a name, that handle 404s on
  // rename-back/start once the container is renamed aside
  const oldContainer = docker.getContainer(info.Id);
  acquireRecreateLock(name);
  try {
    return await recreateContainerLocked(args, job, signal, oldContainer, info, name);
  } finally {
    releaseRecreateLock(name);
  }
}

async function recreateContainerLocked(args, job, signal, old, info, name) {
  const startTimeoutS = args.start_timeout_s ?? 30;
  const backupName = args.backup_name || `${name}-old`;

  // Docker's name filter is a substring match — verify exact conflict
  const conflicts = await docker.listContainers({ all: true, filters: { name: [backupName] } });
  if (conflicts.some(c => c.Names.includes(`/${backupName}`))) {
    throw new Error(`Backup name '${backupName}' is already in use — pick another backup name`);
  }

  if (args.pull !== false) {
    job?.log(`Pulling image ${info.Config.Image}...`);
    await pullImage(info.Config.Image, job, signal);
  }

  await old.stop();
  await old.rename({ name: backupName });
  job?.log(`Renamed previous container aside as '${backupName}'`);

  let newContainer;
  const attached = [];
  try {
    newContainer = await docker.createContainer({
      name,
      ...info.Config,
      HostConfig: info.HostConfig
    });
    // Attach before start so the process never runs without its networks
    for (const { network, config } of extraNetworkEndpoints(info, name)) {
      await docker.getNetwork(network).connect({ Container: newContainer.id, EndpointConfig: config });
      attached.push(network);
      job?.log(`Re-attached to network '${network}'`);
    }
    await newContainer.start();
    job?.log('Started replacement container');
  } catch (err) {
    // newContainer may already exist if an attach failed — rollback removes it
    return await recreateRollback(old, name, newContainer, err, backupName);
  }

  // Watch for early exit; succeed after ~2s of continuous running or when
  // the timeout elapses with the container still up. When the image defines a
  // healthcheck, success additionally requires health status 'healthy' within
  // the timeout — otherwise roll back.
  const hasHealthcheck = Boolean(info.Config.Healthcheck);
  const deadline = Date.now() + startTimeoutS * 1000;
  let consecutive = 0;
  let newInfo = null;
  let exitInfo = null;
  let healthy = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const st = await newContainer.inspect();
    if (!st.State.Running) { exitInfo = st; break; }
    newInfo = st;
    if (hasHealthcheck) {
      const status = st.State.Health?.Status;
      job?.log(`health status: ${status}`);
      if (status === 'healthy') { healthy = true; break; }
      continue; // watch until healthy or the timeout elapses
    }
    if (++consecutive >= 2) break;
  }
  if (exitInfo) {
    job?.log('New container exited — rolling back');
    return await recreateRollback(old, name, newContainer, new Error(
      `New container exited: ${exitInfo.State.Status}${exitInfo.State.Error ? ` (${exitInfo.State.Error})` : ''}`
    ), backupName);
  }
  if (hasHealthcheck && !healthy) {
    job?.log('New container did not become healthy — rolling back');
    return await recreateRollback(old, name, newContainer, new Error(
      `New container did not reach healthy status within ${startTimeoutS}s (health: ${newInfo?.State?.Health?.Status || 'unknown'})`
    ), backupName);
  }
  job?.log(`Recreated successfully (backup: ${backupName})`);

  const result = {
    recreated: true,
    old_id: info.Id,
    new_id: newInfo ? newInfo.Id : newContainer.id,
    image: info.Config.Image,
    old_image_id: info.Image,
    new_image_id: newInfo ? newInfo.Image : null,
    backup_name: backupName,
    restart_policy: info.HostConfig.RestartPolicy?.Name || 'no',
    networks: attached
  };
  if (hasHealthcheck) result.health = newInfo?.State?.Health?.Status || null;

  return jsonResult(result);
}

async function handleMCPTool(name, args) {
  switch (name) {
    case 'docker_ps': {
      const filters = parsePsFilters(args);
      const opts = { all: args.all };
      if (Object.keys(filters).length) opts.filters = filters;
      const containers = await docker.listContainers(opts);
      return jsonResult(containers.map(c => ({
        id: c.Id.substring(0, 12),
        name: c.Names[0]?.replace('/', ''),
        image: c.Image,
        status: c.Status,
        state: c.State
      })));
    }

    case 'docker_run': {
      if (args.pull !== false) await pullImage(args.image);
      const container = await docker.createContainer({
        Image: args.image,
        Cmd: normalizeCommand(args.command),
        name: args.name,
        Healthcheck: parseHealthcheck(args.healthcheck),
        ExposedPorts: args.ports ? Object.fromEntries(
          Object.values(args.ports).map(c => [`${c}/tcp`, {}])
        ) : undefined,
        HostConfig: {
          PortBindings: args.ports ? Object.fromEntries(
            Object.entries(args.ports).map(([h, c]) => [
              `${c}/tcp`, [{ HostPort: h }]
            ])
          ) : undefined,
          Binds: args.volumes || [],
          RestartPolicy: parseRestartPolicy(args.restartPolicy, args.maximumRetryCount)
        },
        Env: args.env ? Object.entries(args.env).map(([k, v]) => `${k}=${v}`) : undefined
      });
      await container.start();
      return {
        content: [{ type: 'text', text: `Started container: ${container.id.substring(0, 12)}` }]
      };
    }

    case 'docker_stop': {
      const container = docker.getContainer(args.id);
      await (args.signal ? container.stop({ signal: args.signal }) : container.stop());
      return { content: [{ type: 'text', text: `Stopped: ${args.id}` }] };
    }

    case 'docker_logs': {
      const container = docker.getContainer(args.id);
      if (args.follow) {
        return {
          content: [{ type: 'text', text: `WebSocket streaming available at: ws://[server-host]:${process.env.PORT || 3001}/logs/${args.id}` }]
        };
      }
      // dockerode 4.x resolves logs() with follow:false to a Buffer (still
      // multiplexed), not a Node stream — demux the buffer directly
      const data = await container.logs({
        stdout: true, stderr: true, tail: args.tail || 100,
        since: parseLogTime(args.since, 'since'),
        until: parseLogTime(args.until, 'until'),
        timestamps: args.timestamps
      });
      let text = data && typeof data.on === 'function'
        ? await demuxStream(data)
        : demuxBuffer(data);
      // Response size guard — protects agent clients from multi-MB dumps
      // entering their context. `tail` still applies before this cap.
      const cap = parseInt(process.env.LOG_MAX_BYTES || '', 10) || 65_536;
      const total = Buffer.byteLength(text);
      if (total > cap) {
        const capped = Buffer.from(text).subarray(0, cap).toString('utf8');
        text = `${capped}\n... [truncated ${total - Buffer.byteLength(capped)} of ${total} bytes]`;
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'docker_events': {
      const filters = {};
      for (const key of ['container', 'type', 'event']) {
        if (args.filters && args.filters[key]) filters[key] = [String(args.filters[key])];
      }
      const since = parseLogTime(args.since ?? '10m', 'since');
      const until = args.until !== undefined
        ? parseLogTime(args.until, 'until')
        : Math.floor(Date.now() / 1000);
      const stream = await docker.getEvents({ since, until, filters });
      const raw = await new Promise((resolve, reject) =>
        docker.modem.followProgress(stream, (err, events) => (err ? reject(err) : resolve(events)))
      );
      let events = raw.map(e => ({
        time: e.time,
        type: e.Type,
        action: e.Action,
        actor_id: (e.Actor && e.Actor.ID ? e.Actor.ID : '').substring(0, 12),
        actor_name: (e.Actor && e.Actor.Attributes && e.Actor.Attributes.name) || (e.Actor && e.Actor.ID) || '',
        attributes: e.Actor && e.Actor.Attributes ? e.Actor.Attributes : {}
      }));
      if (args.tail) events = events.slice(-args.tail);
      return jsonResult({ count: events.length, events });
    }

    case 'docker_exec': {
      const container = docker.getContainer(args.id);
      const execInstance = await container.exec({
        Cmd: normalizeCommand(args.command),
        AttachStdout: true,
        AttachStderr: true,
        ...(args.workdir !== undefined && { WorkingDir: args.workdir }),
        ...(args.user !== undefined && { User: args.user }),
        ...(args.env !== undefined && { Env: normalizeEnvArray(args.env) })
      });
      const stream = await execInstance.start();
      const timeoutSec = args.timeout || 60;
      const text = await Promise.race([
        demuxStream(stream),
        new Promise((_, reject) => setTimeout(() => {
          stream.destroy && stream.destroy();
          reject(new Error(`Exec timed out after ${timeoutSec}s`));
        }, timeoutSec * 1000))
      ]);
      const { ExitCode } = await execInstance.inspect();
      return { content: [{ type: 'text', text: `${text}\nExit code: ${ExitCode}` }] };
    }

    case 'docker_images': {
      const images = args.dangling === true
        ? await docker.listImages({ filters: { dangling: ['true'] } })
        : await docker.listImages();
      return jsonResult(images.map(i => ({
        id: i.Id.substring(7, 19),
        tags: i.RepoTags,
        digests: i.RepoDigests || [],
        size: `${(i.Size / 1024 / 1024).toFixed(2)} MB`
      })));
    }

    case 'docker_image_history': {
      const history = await docker.getImage(args.image).history();
      return jsonResult({
        image: args.image,
        layers: history.map(h => ({
          id: (h.Id || '').startsWith('sha256:') ? h.Id.slice(7, 19) : h.Id,
          created: h.Created,
          created_by: h.CreatedBy,
          size_bytes: h.Size || 0,
          tags: h.Tags || []
        }))
      });
    }

    case 'docker_login': {
      if (!args.username || !args.password) throw new Error('username and password are required');
      const registry = args.registry || 'docker.io';
      const host = registry.replace(/^https?:\/\//, '') === 'docker.io'
        ? 'registry-1.docker.io'
        : registry.replace(/^https?:\/\//, '');
      const serveraddress = registry === 'docker.io' || args.registry === undefined
        ? 'https://index.docker.io/v1/'
        : `https://${host}`;
      await new Promise((resolve, reject) =>
        docker.checkAuth({ username: args.username, password: args.password, serveraddress },
          (err, res) => (err ? reject(err) : resolve(res))));
      REGISTRY_AUTH.set(host, { username: args.username, password: args.password });
      return { content: [{ type: 'text', text: `Logged in to ${host} as ${args.username}` }] };
    }

    case 'docker_pull': {
      if (args.mode === 'async') {
        const started = await startJob('pull', (job, signal) =>
          pullImage(args.image, job, signal).then(() => `Pulled: ${args.image}`));
        return { content: [{ type: 'text', text: JSON.stringify(started, null, 2) }] };
      }
      await pullImage(args.image);
      return { content: [{ type: 'text', text: `Pulled: ${args.image}` }] };
    }

    case 'docker_remove': {
      const container = docker.getContainer(args.id);
      await container.remove({ force: args.force });
      return { content: [{ type: 'text', text: `Removed: ${args.id}` }] };
    }

    case 'docker_start': {
      const container = docker.getContainer(args.id);
      await container.start();
      return { content: [{ type: 'text', text: `Started: ${args.id}` }] };
    }

    case 'docker_restart': {
      const container = docker.getContainer(args.id);
      await container.restart({ t: args.timeout || 10 });
      return { content: [{ type: 'text', text: `Restarted: ${args.id}` }] };
    }
    case 'docker_inspect': {
      let info;
      if ((args.type || 'container') === 'image') {
        info = await docker.getImage(args.id).inspect();
      } else {
        info = await docker.getContainer(args.id).inspect();
      }
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }


    case 'docker_compose_up': {
      const cwd = await composeCwd(args);
      const argv = ['compose', 'up'];
      if (args.build) argv.push('--build');
      if (args.detach !== false) argv.push('-d');
      if (args.mode === 'async') {
        const started = await startJob('compose_up', (job, signal) =>
          runCancelable('docker', argv, cwd, job, signal)
            .then(out => `Docker Compose up:\n${out}`));
        return { content: [{ type: 'text', text: JSON.stringify(started, null, 2) }] };
      }
      const output = await runSafe('docker', argv, cwd);
      return { content: [{ type: 'text', text: `Docker Compose up:\n${output}` }] };
    }

    case 'docker_compose_ps': {
      const containers = await listComposeContainers(args);
      return jsonResult(containers.map(c => ({
        service: c.Labels?.['com.docker.compose.service'] || 'unknown',
        name: c.Names[0]?.replace('/', ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)
      })));
    }

    case 'docker_compose_down': {
      await requireConfirm('docker_compose_down', args, async () => {
        const containers = await listComposeContainers(args);
        const names = containers.map(c => c.Names[0]?.replace(/^\//, '') || c.Id.substring(0, 12));
        const what = names.length ? `compose project containers: ${names.join(', ')}` : 'the compose project containers (none found for the given project)';
        return args.volumes ? `${what} plus the project volumes` : what;
      });
      const cwd = await composeCwd(args);
      const argv = ['compose', 'down'];
      if (args.volumes) argv.push('-v');
      const output = await runSafe('docker', argv, cwd);
      return { content: [{ type: 'text', text: `Docker Compose down:\n${output}` }] };
    }

    case 'docker_compose_build': {
      const cwd = await composeCwd(args);
      const argv = ['compose', 'build'];
      if (args.service) argv.push(args.service);
      const output = await runSafe('docker', argv, cwd);
      return { content: [{ type: 'text', text: `Docker Compose build:\n${output}` }] };
    }

    case 'docker_compose_logs': {
      // file (legacy) wins if given; otherwise resolve the stack by project name
      let cwd; let argv;
      if (args.file) {
        cwd = path.dirname(args.file);
        argv = ['compose', '-f', args.file, 'logs', '--no-color', '--tail', String(args.tail || 100)];
      } else {
        cwd = await composeCwd(args);
        argv = ['compose', 'logs', '--no-color', '--tail', String(args.tail || 100)];
      }
      if (args.since) argv.push('--since', args.since);
      if (args.service) argv.push(args.service);
      const text = await runSafe('docker', argv, cwd);
      return { content: [{ type: 'text', text }] };
    }

    case 'docker_stats': {
      if (args.id) {
        const container = docker.getContainer(args.id);
        const stats = await container.stats({ stream: false });
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuPercent = systemDelta > 0 ? ((cpuDelta / systemDelta) * 100).toFixed(2) : '0.00';
        const memUsage = (stats.memory_stats.usage / 1024 / 1024).toFixed(2);
        const memLimit = (stats.memory_stats.limit / 1024 / 1024).toFixed(2);
        return {
          content: [{ type: 'text', text: `Container: ${args.id}\nCPU: ${cpuPercent}%\nMemory: ${memUsage}MiB / ${memLimit}MiB` }]
        };
      } else {
        const containers = await docker.listContainers();
        const rows = await Promise.all(
          containers.map(async (containerInfo) => {
            const name = containerInfo.Names[0].replace('/', '');
            try {
              const container = docker.getContainer(containerInfo.Id);
              const stats = await container.stats({ stream: false });
              const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
              const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
              const cpuPercent = systemDelta > 0 ? ((cpuDelta / systemDelta) * 100).toFixed(2) : '0.00';
              const memUsage = (stats.memory_stats.usage / 1024 / 1024).toFixed(2);
              const memLimit = (stats.memory_stats.limit / 1024 / 1024).toFixed(2);
              return `${name}\t${cpuPercent}%\t${memUsage}MiB / ${memLimit}MiB`;
            } catch (e) {
              return `${name}\tN/A\tN/A`;
            }
          })
        );
        return {
          content: [{ type: 'text', text: 'NAME\t\tCPU%\tMEM USAGE / LIMIT\n' + rows.join('\n') }]
        };
      }
    }

    case 'docker_build': {
      const argv = ['build', '-f', args.dockerfile || 'Dockerfile', '-t', args.tag];
      if (args.build_args) {
        for (const [k, v] of Object.entries(args.build_args)) {
          argv.push('--build-arg', `${k}=${v}`);
        }
      }
      argv.push('.');
      if (args.mode === 'async') {
        const started = await startJob('build', (job, signal) =>
          runCancelable('docker', argv, args.context, job, signal)
            .then(out => `Build complete:\n${out}`));
        return { content: [{ type: 'text', text: JSON.stringify(started, null, 2) }] };
      }
      const output = await runSafe('docker', argv, args.context);
      return { content: [{ type: 'text', text: `Build complete:\n${output}` }] };
    }

    case 'docker_volume_ls': {
      // Sizes come from the verbose /system/df call; plain listVolumes has no UsageData
      let volumes;
      try {
        const verbose = await new Promise((resolve, reject) => {
          docker.modem.dial({
            path: '/system/df?',
            method: 'GET',
            statusCodes: { 200: true, 500: 'server error' },
            options: { verbose: '1' }
          }, (err, data) => err ? reject(err) : resolve(data));
        });
        // Verbose df: VolumeUsage.Items (API 1.42+) or Volumes (older daemons)
        volumes = { Volumes: verbose.VolumeUsage?.Items || verbose.Volumes || [] };
      } catch (_) {
        volumes = args.label
          ? await docker.listVolumes({ filters: { label: [args.label] } })
          : await docker.listVolumes();
      }
      // Map volume → mounting container names so prune/backup decisions know
      // what's live before touching anything
      const inUse = {};
      const allContainers = await docker.listContainers({ all: true });
      for (const c of allContainers) {
        try {
          const info = await docker.getContainer(c.Id).inspect();
          const cname = c.Names[0]?.replace(/^\//, '');
          for (const m of info.Mounts || []) {
            if (m.Type === 'volume' && m.Name) {
              (inUse[m.Name] ||= []).push(cname);
            }
          }
        } catch (_) { /* container inspected by someone else mid-list — skip */ }
      }
      // The verbose-df path ignores the label filter — apply it client-side
      // so both paths behave identically
      let list = volumes.Volumes || [];
      if (args.label) {
        const eq = args.label.indexOf('=');
        const key = eq === -1 ? args.label : args.label.slice(0, eq);
        const value = eq === -1 ? undefined : args.label.slice(eq + 1);
        list = list.filter(v => {
          const lv = (v.Labels || {})[key];
          return value === undefined ? lv !== undefined : lv === value;
        });
      }
      return jsonResult(list.map(v => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        size: v.UsageData ? `${(v.UsageData.Size / 1024 / 1024).toFixed(2)} MB` : 'N/A',
        in_use_by: inUse[v.Name] || []
      })));
    }

    case 'docker_volume_create': {
      await docker.createVolume({ Name: args.name, Driver: args.driver || 'local' });
      return { content: [{ type: 'text', text: `Created volume: ${args.name}` }] };
    }

    case 'docker_volume_rm': {
      requireName('docker_volume_rm', args, 'volume');
      await requireConfirm('docker_volume_rm', args, `volume '${args.name}'`);
      const volume = docker.getVolume(args.name);
      await volume.remove({ force: args.force });
      return { content: [{ type: 'text', text: `Removed volume: ${args.name}` }] };
    }

    case 'docker_network_ls': {
      const networks = await docker.listNetworks();
      return jsonResult(networks.map(n => ({
        id: n.Id.substring(0, 12),
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope
      })));
    }

    case 'docker_network_inspect': {
      const info = await docker.getNetwork(args.name).inspect();
      return jsonResult({
        id: info.Id,
        name: info.Name,
        driver: info.Driver,
        scope: info.Scope,
        subnet: info.IPAM?.Config?.[0]?.Subnet || null,
        containers: Object.entries(info.Containers || {}).map(([id, c]) => ({
          id,
          name: c.Name,
          ipv4: c.IPv4Address || null
        }))
      });
    }

    case 'docker_network_create': {
      await docker.createNetwork({ Name: args.name, Driver: args.driver || 'bridge' });
      return { content: [{ type: 'text', text: `Created network: ${args.name}` }] };
    }

    case 'docker_network_rm': {
      requireName('docker_network_rm', args, 'network');
      await requireConfirm('docker_network_rm', args, `network '${args.name}'`);
      const network = docker.getNetwork(args.name);
      await network.remove();
      return { content: [{ type: 'text', text: `Removed network: ${args.name}` }] };
    }

    case 'docker_image_prune': {
      const f = normalizePruneFilters(args.filters);
      // Candidates for dry-run / filtered prune (label is protection, not a
      // native prune filter — resolve the list ourselves and remove one by one)
      const resolveCandidates = async () => {
        const listFilters = args.all ? {} : { dangling: ['true'] };
        let images = await docker.listImages({ all: true, filters: listFilters });
        if (f.label) {
          const spare = labelSpareMatcher(f.label);
          images = images.filter(i => !spare(i.Labels));
        }
        if (f.until) {
          const cutoff = Date.now() - parseDuration(f.until) * 1000;
          images = images.filter(i => i.Created * 1000 < cutoff);
        }
        if (f.name) {
          images = images.filter(i => (i.RepoTags || []).some(t => t.includes(f.name)));
        }
        return images;
      };
      if (args.dry_run) {
        const images = await resolveCandidates();
        return jsonResult({
          dry_run: true,
          would_remove: images.map(i => ({ id: i.Id, tags: i.RepoTags || [] }))
        });
      }
      if (Object.keys(f).length > 0) {
        const images = await resolveCandidates();
        const deleted = [];
        const errors = [];
        for (const i of images) {
          try { await docker.getImage(i.Id).remove({ force: false }); deleted.push(i.Id); }
          catch (e) { errors.push(`${i.Id}: ${e.message}`); }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ ImagesDeleted: deleted, Errors: errors }, null, 2) }]
        };
      }
      const result = await docker.pruneImages(args.all ? {} : { filters: { dangling: { 'true': true } } });
      return {
        content: [{ type: 'text', text: `Pruned images:\n${JSON.stringify(result, null, 2)}` }]
      };
    }

    case 'docker_image_rm': {
      requireName('docker_image_rm', args, 'image');
      await requireConfirm('docker_image_rm', args, `image '${args.name}'`);
      const image = docker.getImage(args.name);
      await image.remove({ force: args.force || false });
      return { content: [{ type: 'text', text: `Removed: ${args.name}` }] };
    }

    case 'docker_container_prune': {
      const f = normalizePruneFilters(args.filters);
      // Candidates for dry-run / filtered prune (label is protection, name is
      // not a native prune filter — resolve the list ourselves, remove one by one)
      const resolveCandidates = async () => {
        const listFilters = { status: ['exited', 'created', 'dead'] };
        let containers = await docker.listContainers({ all: true, filters: listFilters });
        if (f.label) {
          const spare = labelSpareMatcher(f.label);
          containers = containers.filter(c => !spare(c.Labels));
        }
        if (f.until) {
          const cutoff = Date.now() - parseDuration(f.until) * 1000;
          containers = containers.filter(c => c.Created * 1000 < cutoff);
        }
        if (f.name) {
          containers = containers.filter(c => c.Names.some(n => n.includes(f.name)));
        }
        return containers;
      };
      if (args.dry_run) {
        const containers = await resolveCandidates();
        return jsonResult({
          dry_run: true,
          would_remove: containers.map(c => ({
            id: c.Id, name: c.Names[0]?.replace('/', ''), status: c.Status
          }))
        });
      }
      if (Object.keys(f).length > 0) {
        const containers = await resolveCandidates();
        const deleted = [];
        const errors = [];
        for (const c of containers) {
          try { await docker.getContainer(c.Id).remove(); deleted.push(c.Id); }
          catch (e) { errors.push(`${c.Id}: ${e.message}`); }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ ContainersDeleted: deleted, Errors: errors }, null, 2) }]
        };
      }
      const result = await docker.pruneContainers();
      return {
        content: [{ type: 'text', text: `Pruned containers:\n${JSON.stringify(result, null, 2)}` }]
      };
    }

    case 'docker_rename': {
      const container = docker.getContainer(args.id);
      await container.rename({ name: args.name });
      return { content: [{ type: 'text', text: `Renamed to: ${args.name}` }] };
    }

    case 'docker_container_update': {
      const update = {};
      const policy = parseRestartPolicy(args.restartPolicy, args.maximumRetryCount);
      if (policy) update.RestartPolicy = policy;
      const healthcheck = parseHealthcheck(args.healthcheck);
      if (healthcheck) update.Healthcheck = healthcheck;
      for (const [argKey, field] of [
        ['nanoCpus', 'NanoCpus'], ['cpuShares', 'CpuShares'],
        ['cpuPeriod', 'CpuPeriod'], ['cpuQuota', 'CpuQuota'],
        ['cpusetCpus', 'CpusetCpus'], ['memory', 'Memory'],
        ['memorySwap', 'MemorySwap'], ['memoryReservation', 'MemoryReservation'],
        ['pidsLimit', 'PidsLimit']
      ]) {
        if (args[argKey] !== undefined) update[field] = args[argKey];
      }
      if (Object.keys(update).length === 0) {
        throw new Error('Nothing to update: provide restartPolicy and/or resource limits');
      }
      const container = docker.getContainer(args.id);
      const result = await container.update(update);
      const warnings = result && result.Warnings && result.Warnings.length
        ? ` Warnings: ${result.Warnings.join('; ')}` : '';
      return { content: [{ type: 'text', text: `Updated: ${args.id} ${JSON.stringify(update)}${warnings}` }] };
    }

    case 'docker_system_info': {
      const info = await docker.info();
      return jsonResult({
        version:       info.ServerVersion,
        os:            info.OperatingSystem,
        arch:          info.Architecture,
        cpus:          info.NCPU,
        memory:        `${(info.MemTotal / 1024 / 1024 / 1024).toFixed(2)} GB`,
        containers:    { running: info.ContainersRunning, stopped: info.ContainersStopped, paused: info.ContainersPaused },
        images:        info.Images,
        storageDriver: info.Driver
      });
    }

    case 'docker_image_tag': {
      const image = docker.getImage(args.source);
      const tag = args.tag || 'latest';
      await image.tag({ repo: args.repo, tag });
      return { content: [{ type: 'text', text: `Tagged ${args.source} as ${args.repo}:${tag}` }] };
    }

    case 'docker_network_connect': {
      const network = docker.getNetwork(args.network);
      await network.connect({ Container: args.container });
      return { content: [{ type: 'text', text: `Connected ${args.container} to ${args.network}` }] };
    }

    case 'docker_network_disconnect': {
      const network = docker.getNetwork(args.network);
      await network.disconnect({ Container: args.container });
      return { content: [{ type: 'text', text: `Disconnected ${args.container} from ${args.network}` }] };
    }

    case 'docker_copy': {
      // Host directions shell out to docker cp — the CLI resolves host paths
      // as seen from inside this container's mounts
      if (args.direction === 'from_host' || args.direction === 'to_host') {
        if (!args.host_path || !path.isAbsolute(args.host_path)) {
          throw new Error(`host_path must be an absolute host path for direction="${args.direction}"`);
        }
        const cpArgv = args.direction === 'from_host'
          ? ['cp', args.host_path, `${args.id}:${args.container_path}`]
          : ['cp', `${args.id}:${args.container_path}`, args.host_path];
        await runSafe('docker', cpArgv, undefined, 600_000);
        return { content: [{ type: 'text', text: `Copied ${args.direction === 'from_host' ? args.host_path : `${args.id}:${args.container_path}`} → ${args.direction === 'from_host' ? `${args.id}:${args.container_path}` : args.host_path}` }] };
      }
      const container = docker.getContainer(args.id);
      if (args.direction === 'from') {
        const stream = await container.getArchive({ path: args.container_path });
        const chunks = [];
        await new Promise((resolve, reject) => {
          stream.on('data', c => chunks.push(c));
          stream.on('end', resolve);
          stream.on('error', reject);
        });
        const b64 = Buffer.concat(chunks).toString('base64');
        return {
          content: [{ type: 'text', text: `Base64 tar of ${args.container_path} from ${args.id}:\n${b64}` }]
        };
      } else {
        if (!args.content) throw new Error('content is required for direction="to"');
        const buf = Buffer.from(args.content, 'base64');
        const isTar = buf.length > 262 && buf.slice(257, 262).toString('ascii') === 'ustar';
        if (isTar) {
          await container.putArchive(buf, { path: args.container_path });
          return { content: [{ type: 'text', text: `Copied tar archive to ${args.container_path} in ${args.id}` }] };
        }
        // Raw (non-tar) content — wrap it in a tar so the file lands at
        // exactly container_path (putArchive extracts an archive INTO a
        // directory otherwise, which silently wrote nothing on raw bytes)
        if (args.container_path.endsWith('/')) {
          throw new Error('container_path must be a file path when content is not a tar archive (a tar is extracted into it as a directory)');
        }
        const name = path.posix.basename(args.container_path);
        const dir = path.posix.dirname(args.container_path);
        if (dir === '.' || !dir.startsWith('/')) {
          throw new Error(`container_path must be an absolute path (got '${args.container_path}')`);
        }
        await container.putArchive(makeSingleFileTar(name, buf), { path: dir });
        return { content: [{ type: 'text', text: `Copied to ${args.container_path} in ${args.id}` }] };
      }
    }

    case 'docker_system_df': {
      const df = await docker.df();
      const sum = (arr, key) => (arr || []).reduce((acc, x) => acc + (x[key] || 0), 0);
      return jsonResult({
        layers_size: df.LayersSize || 0,
        images: {
          count: (df.Images || []).length,
          total_size: sum(df.Images, 'Size'),
          active: (df.Images || []).filter(i => i.Containers > 0).length
        },
        containers: {
          count: (df.Containers || []).length,
          running: (df.Containers || []).filter(c => c.State === 'running').length,
          total_size: sum(df.Containers, 'SizeRw')
        },
        volumes: {
          count: (df.Volumes || []).length,
          total_size: sum(df.Volumes, 'SizeUsage')
        },
        build_cache: {
          count: (df.BuildCache || []).length,
          total_size: sum(df.BuildCache, 'Size'),
          reclaimable: (df.BuildCache || []).filter(c => !c.InUse).reduce((acc, c) => acc + (c.Size || 0), 0)
        }
      });
    }

    case 'docker_top': {
      const container = docker.getContainer(args.id);
      const data = await container.top(args.ps_args || undefined);
      const rows = (data.Processes || []).map(p => p.join('\t'));
      return {
        content: [{
          type: 'text',
          text: `Processes in ${args.id}:\n${(data.Titles || []).join('\t')}\n${rows.join('\n')}`
        }]
      };
    }

    case 'docker_job_status': {
      const job = JOBS.get(args.job_id);
      if (!job) throw new Error(`Unknown job: ${args.job_id}`);
      const tail = args.tail ?? 20;
      return jsonResult({
        job_id: job.id, type: job.type, status: job.status,
        started_at: job.started_at, finished_at: job.finished_at,
        progress: job.progress.slice(-tail),
        result: job.result, error: job.error
      });
    }

    case 'docker_job_cancel': {
      const job = JOBS.get(args.job_id);
      if (!job) throw new Error(`Unknown job: ${args.job_id}`);
      if (job.status !== 'running') {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            job_id: job.id, status: job.status, note: 'Job already finished — nothing to cancel'
          }, null, 2) }]
        };
      }
      job.controller.abort();
      return {
        content: [{ type: 'text', text: JSON.stringify({
          job_id: job.id, status: 'cancelling', type: job.type
        }, null, 2) }]
      };
    }

    case 'docker_outdated': {
      const listOpts = { all: !!args.all };
      if (!args.all) listOpts.filters = { status: ['running'] };
      let containers = await docker.listContainers(listOpts);
      if (args.id) {
        containers = containers.filter(c =>
          c.Id === args.id || c.Names.some(n => n.replace(/^\//, '') === args.id));
      }
      const results = [];
      for (const c of containers) {
        const name = c.Names[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
        const entry = { name, image: c.Image, update_available: null };
        try {
          const parsed = parseImageRef(c.Image);
          if (c.Image.startsWith('sha256:')) {
            entry.untagged = true;
            entry.note = 'bare image ID: the tag this container was created from has usually moved on or been removed, so it is probably running an older image; recreate it from its compose file or original tag';
            results.push(entry);
            continue;
          }
          if (parsed.pinnedDigest) {
            entry.pinned = true;
            entry.local_digest = parsed.pinnedDigest;
            entry.note = 'pinned by digest: the reference records no tag, so there is nothing upstream to compare with; check the source tag manually';
            results.push(entry);
            continue;
          }
          const img = await docker.getImage(c.Image).inspect();
          const localDigest = localDigestFor(img, parsed);
          if (!localDigest) {
            entry.error = 'locally built image — no registry digest to compare';
          } else {
            entry.local_digest = localDigest;
            try {
              entry.remote_digest = await fetchRemoteDigest(parsed);
              entry.update_available = entry.remote_digest !== localDigest;
            } catch (e) {
              entry.error = e.message;
            }
          }
        } catch (e) {
          entry.error = e.message;
        }
        results.push(entry);
      }
      const updates = results.filter(r => r.update_available).length;
      const notAssessed = results.filter(r => r.update_available === null).length;
      return jsonResult({ checked: results.length, updates_available: updates, not_assessed: notAssessed, containers: results });
    }

    case 'docker_volume_backup': {
      if (!args.name) throw new Error('name is required');
      if (!args.out_path || !path.isAbsolute(args.out_path)) {
        throw new Error('out_path must be an absolute host path (e.g. /srv/backups/volume.tar)');
      }
      const dir = path.dirname(args.out_path);
      const file = path.basename(args.out_path);
      if (file.includes("'")) throw new Error(`Invalid output filename: '${file}'`);
      await docker.getVolume(args.name).inspect(); // 404 → clean error before any work

      const gzip = Boolean(args.gzip);
      const tarArgs = gzip ? 'tar czf' : 'tar cf';
      const script =
        `set -e; ` +
        `if [ -e '/backup/${file}' ]; then echo ERROR_EXISTS; exit 3; fi; ` +
        `${tarArgs} '/backup/${file}' -C /volume .; ` +
        `sha256sum '/backup/${file}' | cut -d' ' -f1; ` +
        `wc -c < '/backup/${file}'`;
      const argv = ['run', '--rm', '-v', `${args.name}:/volume:ro`, '-v', `${dir}:/backup`];
      if (args.pull !== false) argv.push('--pull=missing');
      argv.push('alpine', 'sh', '-c', script);
      let out;
      try {
        out = await runSafe('docker', argv, undefined, 600_000);
      } catch (e) {
        if (String(e.message).includes('ERROR_EXISTS')) {
          throw new Error(`Output file already exists: ${args.out_path}`);
        }
        throw e;
      }
      const [sha256, bytesRaw] = out.trim().split('\n').filter(Boolean);
      const bytes = parseInt(bytesRaw, 10);
      if (!/^[0-9a-f]{64}$/.test(sha256 || '') || !Number.isFinite(bytes)) {
        throw new Error(`Unexpected helper output: ${out.slice(0, 200)}`);
      }
      return jsonResult({ volume: args.name, out_path: args.out_path, gzip, bytes, sha256 });
    }

    case 'docker_volume_restore': {
      if (!args.name) throw new Error('name is required');
      if (!args.backup_path || !path.isAbsolute(args.backup_path)) {
        throw new Error('backup_path must be an absolute host path (e.g. /srv/backups/volume.tar)');
      }
      const dir = path.dirname(args.backup_path);
      const file = path.basename(args.backup_path);
      if (file.includes("'")) throw new Error(`Invalid backup filename: '${file}'`);
      await docker.getVolume(args.name).inspect(); // 404 → clean error before any work

      const script =
        `set -e; ` +
        `if [ ! -f '/backup/${file}' ]; then echo ERROR_NOFILE; exit 2; fi; ` +
        `if [ -n "$(find /volume -mindepth 1 -maxdepth 1 -print -quit)" ] && [ "$CONFIRM" != '1' ]; then echo ERROR_NOT_EMPTY; exit 4; fi; ` +
        `find /volume -mindepth 1 -maxdepth 1 -exec rm -rf {} +; ` +
        `case '${file}' in *.gz|*.tgz) tar xzf '/backup/${file}' -C /volume ;; *) tar xf '/backup/${file}' -C /volume ;; esac; ` +
        `echo "FILES $(find /volume -type f | wc -l)"; ` +
        `echo "DIRS $(find /volume -mindepth 1 -type d | wc -l)"; ` +
        `(cd /volume && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)`;
      const argv = ['run', '--rm', '-v', `${args.name}:/volume`, '-v', `${dir}:/backup:ro`];
      if (args.confirm === true) argv.push('-e', 'CONFIRM=1');
      if (args.pull !== false) argv.push('--pull=missing');
      argv.push('alpine', 'sh', '-c', script);
      let out;
      try {
        out = await runSafe('docker', argv, undefined, 600_000);
      } catch (e) {
        if (String(e.message).includes('ERROR_NOT_EMPTY')) {
          const cerr = new Error(`Volume '${args.name}' is not empty — restoring would wipe its current contents. Re-run with confirm: true to proceed.`);
          cerr.code = -32000;
          throw cerr;
        }
        if (String(e.message).includes('ERROR_NOFILE')) {
          throw new Error(`Backup file not found: ${args.backup_path}`);
        }
        throw e;
      }
      const lines = out.trim().split('\n').filter(Boolean);
      const files = parseInt((lines.find(l => l.startsWith('FILES ')) || '').slice(6), 10);
      const dirs = parseInt((lines.find(l => l.startsWith('DIRS ')) || '').slice(5), 10);
      const tree = lines[lines.length - 1];
      if (!Number.isFinite(files) || !Number.isFinite(dirs) || !/^[0-9a-f]{64}$/.test(tree || '')) {
        throw new Error(`Unexpected helper output: ${out.slice(0, 200)}`);
      }
      return jsonResult({ volume: args.name, backup_path: args.backup_path, files, dirs, tree_sha256: tree });
    }

    case 'docker_compose_pull': {
      const containers = await docker.listContainers({
        all: true, filters: { label: [`com.docker.compose.project=${args.project}`] }
      });
      if (containers.length === 0) throw new Error(`No containers found for compose project '${args.project}'`);
      const images = [...new Set(containers.map(c => c.Image))];
      // Digest-only refs (locally built images) have nothing to pull from a registry
      const pullable = [];
      const skipped = images.filter(img => {
        if (img.startsWith('sha256:')) {
          pullable.push({ image: img, ok: false, error: 'locally built image — no tag to pull' });
          return false;
        }
        return true;
      });
      const doPull = async (job, signal) => {
        const results = [...pullable];
        for (const image of skipped) {
          try {
            job?.log(`Pulling ${image}...`);
            await pullImage(image, job, signal);
            results.push({ image, ok: true });
          } catch (e) {
            if (e.message === 'cancelled') throw e;
            results.push({ image, ok: false, error: e.message });
          }
        }
        return { project: args.project, images: results };
      };
      if (args.mode === 'async') {
        const started = await startJob('compose_pull', doPull);
        return { content: [{ type: 'text', text: JSON.stringify(started, null, 2) }] };
      }
      const result = await doPull();
      return jsonResult(result);
    }

    case 'docker_compose_restart': {
      const containers = await listComposeContainers(args);
      if (containers.length === 0) throw new Error(`No containers found for compose project '${args.project}'`);
      const restarted = [];
      const errors = [];
      for (const c of containers) {
        const name = c.Names[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
        try {
          await docker.getContainer(c.Id).restart();
          restarted.push(name);
        } catch (e) {
          errors.push(`${name}: ${e.message}`);
        }
      }
      return jsonResult({ project: args.project, restarted, errors });
    }

    case 'docker_wait': {
      if (!args.timeout_s || !(args.timeout_s > 0)) {
        throw new Error('timeout_s is required (seconds to wait before giving up)');
      }
      const condition = args.condition || 'next-exit';
      const container = docker.getContainer(args.id);
      const deadline = Date.now() + args.timeout_s * 1000;
      while (true) {
        const { State: st } = await container.inspect();
        if (condition === 'healthy') {
          if (!st.Health) throw new Error('Container has no healthcheck — cannot wait for healthy');
          if (st.Health.Status === 'healthy') {
            return jsonResult({
              id: args.id, condition, satisfied: true,
              state: { status: st.Status, running: st.Running, health: st.Health.Status, exit_code: st.ExitCode }
            });
          }
        } else if (!st.Running) {
          return jsonResult({
            id: args.id, condition, satisfied: true,
            state: { status: st.Status, running: st.Running, health: st.Health?.Status || null, exit_code: st.ExitCode }
          });
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out after ${args.timeout_s}s waiting for condition '${condition}' (state: ${st.Status}${st.Health ? `, health: ${st.Health.Status}` : ''})`);
        }
        await sleep(1000);
      }
    }

    case 'docker_container_recreate': {
      if (args.mode === 'async') {
        const started = await startJob('recreate', (job, signal) => recreateContainer(args, job, signal));
        return { content: [{ type: 'text', text: JSON.stringify(started, null, 2) }] };
      }
      return await recreateContainer(args);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const MAX_BODY = 1_048_576; // 1 MB

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Send a JSON-RPC response as SSE or plain JSON depending on the client's Accept header.
// SSE format wraps the payload in a `data:` event and closes the stream immediately.
function sendMCPResponse(req, res, statusCode, payload, extraHeaders = {}) {
  const acceptsSSE = (req.headers['accept'] || '').includes('text/event-stream');
  if (acceptsSSE) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...extraHeaders
    });
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
  } else {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(payload));
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────
// Append-only JSONL file next to the server's own console logs. Every mutating
// tool call is recorded; read tools only when AUDIT_READ_TOOLS is set. The API
// key is reduced to a first4…last4 fingerprint — the full key is never written.
// AUDIT_LOG=<path> (default /app/audit.jsonl; 'off' disables file output).

const fs = require('fs');

const MUTATING_TOOLS = new Set([
  'docker_run', 'docker_stop', 'docker_remove', 'docker_start', 'docker_restart',
  'docker_rename', 'docker_container_update', 'docker_exec',
  'docker_pull', 'docker_build', 'docker_image_rm', 'docker_image_tag',
  'docker_image_prune', 'docker_container_prune',
  'docker_volume_create', 'docker_volume_rm', 'docker_volume_backup',
  'docker_network_create', 'docker_network_rm', 'docker_network_connect', 'docker_network_disconnect',
  'docker_compose_up', 'docker_compose_down', 'docker_compose_build',
  'docker_compose_pull', 'docker_compose_restart',
  'docker_container_recreate', 'docker_job_cancel', 'docker_login'
]);

function keyFingerprint(key) {
  if (!key) return 'unknown';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Top-level arg values, truncated — enough to identify a call, not enough to
// replay secrets (env maps, tokens) into logs
function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (/password|token|secret/i.test(k)) { out[k] = '[REDACTED]'; continue; }
    let s;
    if (typeof v === 'string') s = v;
    else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
    out[k] = s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  return out;
}

const AUDIT_WARNED_PATHS = new Set();

function auditCall({ key, agent, tool, args, ok, error, duration_ms }) {
  const file = process.env.AUDIT_LOG || '/app/audit.jsonl';
  if (file === 'off') return;
  const isMutating = MUTATING_TOOLS.has(tool);
  const includeReads = /^(1|true|yes)$/i.test(process.env.AUDIT_READ_TOOLS || '');
  if (!isMutating && !includeReads) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      key_fp: keyFingerprint(key),
      tool,
      args: summarizeArgs(args),
      ok,
      ...(error ? { error } : {}),
      duration_ms
    });
    fs.appendFileSync(file, line + '\n');
  } catch (e) {
    // Auditing must never break tool calls — but a silently dead audit trail is
    // worse than none, so surface the failure once per path.
    if (!AUDIT_WARNED_PATHS.has(file)) {
      AUDIT_WARNED_PATHS.add(file);
      console.warn(`[audit] log file ${file} is not writable (${e.code || e.message}); audit entries are being DROPPED — mount the directory writable or set AUDIT_LOG`);
    }
  }
}

// ── Two-phase confirm for destructive tools ─────────────────────────────────
// CONFIRM_TOOLS=docker_remove,docker_volume_rm,... — listed tools return
// { confirm_token, expires_s } on first call; repeating the identical call
// with confirm_token executes it. Tokens are single-use, bound to the exact
// args, and expire (default 60s). Read paths are unaffected.
const CONFIRM_PENDING = new Map(); // token -> { tool, argsHash, expires }

function confirmToolSet() {
  return new Set((process.env.CONFIRM_TOOLS || '')
    .split(',').map(s => s.trim()).filter(Boolean));
}

function confirmTtlS() {
  const n = parseInt(process.env.CONFIRM_TTL_S || '', 10);
  // A zero/negative TTL makes every token instantly expired (useful for tests
  // or "always confirm twice" paranoia)
  return Number.isFinite(n) ? n : 60;
}

// Key-stable canonical form of the args (minus confirm_token and confirm —
// both are acknowledgements, not operation parameters) that a token is bound to
function canonicalArgs(args) {
  const sortDeep = o => Array.isArray(o) ? o.map(sortDeep)
    : (o && typeof o === 'object')
      ? Object.keys(o).sort().reduce((acc, k) => (acc[k] = sortDeep(o[k]), acc), {})
      : o;
  const clone = { ...args };
  delete clone.confirm_token;
  delete clone.confirm;
  return JSON.stringify(sortDeep(clone));
}

// ── Explicit confirm:true requirement ───────────────────────────────────────
// Destructive tools listed in CONFIRM_REQUIRED_TOOLS (default: the four below)
// must be called with confirm: true — the client has to opt in on the call
// itself, which keeps the requirement visible in the schema. A call without
// it is rejected with a description of what would be affected.
// CONFIRM_REQUIRED_TOOLS=off disables; a custom list narrows/replaces it.
const DEFAULT_CONFIRM_REQUIRED = 'docker_image_rm,docker_volume_rm,docker_network_rm,docker_compose_down';

function confirmRequiredSet() {
  const raw = process.env.CONFIRM_REQUIRED_TOOLS;
  if (raw === 'off') return new Set();
  return new Set((raw === undefined || raw === '' ? DEFAULT_CONFIRM_REQUIRED : raw)
    .split(',').map(s => s.trim()).filter(Boolean));
}

async function requireConfirm(name, args, describe) {
  if (!confirmRequiredSet().has(name)) return;
  if (args.confirm === true) return;
  const targets = typeof describe === 'function' ? await describe() : describe;
  const err = new Error(`Confirmation required: ${name} would affect ${targets}. Re-run with confirm: true to proceed.`);
  err.code = -32000;
  throw err;
}

// Destructive rm tools name their target via `name` — reject a missing one
// with a clear error instead of interpolating 'undefined' into the preview
function requireName(tool, args, label) {
  if (!args.name) {
    const err = new Error(`${tool} requires 'name' — the ${label} to remove`);
    err.code = -32000;
    throw err;
  }
}

// Containers of a compose project — by project name (label filter) or by
// project_dir (com.docker.compose.project.working_dir label, as stamped by
// compose itself). Used for confirm previews and unified compose addressing.
async function listComposeContainers(args) {
  if (args.project) {
    return docker.listContainers({
      all: true, filters: { label: [`com.docker.compose.project=${args.project}`] }
    });
  }
  if (args.project_dir) {
    const all = await docker.listContainers({ all: true });
    return all.filter(c => (c.Labels || {})['com.docker.compose.project.working_dir'] === args.project_dir);
  }
  return [];
}

// Working directory for the compose CLI — project_dir as given, or resolved
// from the project name via the working_dir label compose stamps on its
// containers (so every compose tool can be addressed by project name alone)
async function composeCwd(args) {
  if (args.project_dir) return args.project_dir;
  if (!args.project) throw new Error('Provide project or project_dir');
  const containers = await listComposeContainers({ project: args.project });
  if (containers.length === 0) throw new Error(`No containers found for compose project '${args.project}'`);
  const dirs = [...new Set(containers
    .map(c => (c.Labels || {})['com.docker.compose.project.working_dir'])
    .filter(Boolean))];
  if (dirs.length === 0) {
    throw new Error(`Compose project '${args.project}' containers carry no working_dir label — pass project_dir instead`);
  }
  return dirs[0];
}

function confirmIntercept(name, args) {
  if (!confirmToolSet().has(name)) return null;
  const argsHash = crypto.createHash('sha256').update(canonicalArgs(args)).digest('hex');
  const now = Date.now();

  // Sweep expired tokens opportunistically
  for (const [t, p] of CONFIRM_PENDING) {
    if (p.expires < now) CONFIRM_PENDING.delete(t);
  }

  const token = args.confirm_token;
  if (typeof token !== 'string' || !token) {
    const t = crypto.randomBytes(16).toString('hex');
    CONFIRM_PENDING.set(t, { tool: name, argsHash, expires: now + confirmTtlS() * 1000 });
    return jsonResult({
      confirm_required: true,
      confirm_token: t,
      expires_s: confirmTtlS(),
      message: `This is a destructive tool. Repeat the exact same call with confirm_token set to this value to execute ${name}.`
    });
  }

  // Consume regardless of match — single use
  const pending = CONFIRM_PENDING.get(token);
  CONFIRM_PENDING.delete(token);
  if (!pending || pending.tool !== name || pending.argsHash !== argsHash || pending.expires < now) {
    const err = new Error('Invalid, expired or mismatched confirm token — call again without confirm_token to get a fresh one');
    err.code = -32000;
    throw err;
  }
  return null;
}

// ── Self-guard ───────────────────────────────────────────────────────────────
// This server manages the same daemon it runs on: removing, renaming or
// recreating its own container takes the MCP service down with no MCP path to
// undo it. Refuse
// those calls when the target resolves to our own container. Runs BEFORE the
// confirm-token flow so a refusal never burns a token.
const SELF_GUARD_TOOLS = new Set(['docker_remove', 'docker_rename', 'docker_container_recreate']);

let selfContainerIdPromise = null;
function selfContainerId() {
  if (!selfContainerIdPromise) {
    // In Docker, a container's hostname defaults to its short id — the one
    // handle we have for ourselves from inside. Only arm the guard when that
    // heuristic holds (12-hex hostname): a custom --hostname or a non-container
    // env (local dev, tests) leaves it off rather than guessing wrong.
    const host = os.hostname();
    if (!/^[0-9a-f]{12}$/i.test(host)) return Promise.resolve(null);
    selfContainerIdPromise = docker.getContainer(host).inspect()
      .then(info => info.Id)
      .catch(() => { selfContainerIdPromise = null; return null; });
  }
  return selfContainerIdPromise;
}

// Test hook: force the self container id (the jest suite runs on the host,
// where the hostname heuristic above doesn't arm the guard)
function setSelfContainerIdForTests(id) {
  selfContainerIdPromise = id === undefined ? null : Promise.resolve(id);
}

async function assertNotSelf(name, args) {
  if (!SELF_GUARD_TOOLS.has(name) || !args.id) return;
  const selfId = await selfContainerId();
  if (!selfId) return; // can't resolve self (non-container env) — guard off
  let targetId;
  try {
    targetId = (await docker.getContainer(args.id).inspect()).Id;
  } catch (_) {
    return; // target doesn't exist — the tool's own error path handles it
  }
  if (targetId === selfId) {
    const err = new Error(
      `${name} refused: '${args.id}' is this MCP server's own container — removing, renaming or recreating it takes down this MCP server with no MCP path back. Do it from the VM shell instead.`
    );
    err.code = -32000;
    throw err;
  }
}

// One JSON log line per tool call — audit trail without leaking arg values
async function callToolLogged(name, args, agent, key) {
  const started = Date.now();
  try {
    await assertNotSelf(name, args);
    const confirmResult = confirmIntercept(name, args);
    if (confirmResult) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), tool: name, agent, duration_ms: Date.now() - started, ok: true, note: 'confirm_required' }));
      return confirmResult;
    }
    const result = await handleMCPTool(name, args);
    console.log(JSON.stringify({ ts: new Date().toISOString(), tool: name, agent, duration_ms: Date.now() - started, ok: true }));
    auditCall({ key, agent, tool: name, args, ok: true, duration_ms: Date.now() - started });
    return result;
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), tool: name, agent, duration_ms: Date.now() - started, ok: false, error: err.message }));
    auditCall({ key, agent, tool: name, args, ok: false, error: err.message, duration_ms: Date.now() - started });
    throw err;
  }
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'docker-mcp', version: VERSION, tools: MCP_TOOLS.length, agents: API_KEYS.size, auth: 'required' }));
    return;
  }

  if (!checkAuth(req, res)) return;

  // ── MCP Streamable HTTP transport (2025-03-26) ────────────────────────────

  // GET /mcp — no server-initiated stream is offered; clients must POST
  if (url.pathname === '/mcp' && req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'Server does not offer server-initiated SSE; use POST /mcp' } }));
    return;
  }

  // DELETE /mcp — terminate session
  if (url.pathname === '/mcp' && req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) sessions.delete(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /mcp — receive JSON-RPC messages from client
  if (url.pathname === '/mcp' && req.method === 'POST') {
    const body = await readBody(req, res).catch(() => null);
    if (body === null) return;
    try {
      const request = JSON.parse(body);

        if (Array.isArray(request)) {
          const sessionId = req.headers['mcp-session-id'];
          if (sessionId && !sessions.has(sessionId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Session not found' } }));
            return;
          }
          if (sessionId) sessions.get(sessionId).lastSeen = Date.now();
          const results = await Promise.all(
            request.map(async (msg) => {
              if (msg.id === undefined || msg.id === null) return null;
              try {
                if (msg.method === 'ping') {
                  return { jsonrpc: '2.0', id: msg.id, result: {} };
                }
                if (msg.method === 'tools/list') {
                  return { jsonrpc: '2.0', id: msg.id, result: { tools: MCP_TOOLS } };
                }
                if (msg.method === 'tools/call') {
                  const result = await callToolLogged(msg.params.name, msg.params.arguments || {}, req.agentName, req.keyFp);
                  return { jsonrpc: '2.0', id: msg.id, result };
                }
                return { jsonrpc: '2.0', id: msg.id,
                         error: { code: -32601, message: 'Method not found' } };
              } catch (err) {
                return { jsonrpc: '2.0', id: msg.id,
                         error: { code: Number.isFinite(err.code) ? err.code : -32603, message: err.message } };
              }
            })
          );
          const responses = results.filter(Boolean);
          if (responses.length === 0) { res.writeHead(202); res.end(); return; }
          sendMCPResponse(req, res, 200, responses);
          return;
        }

        // initialize — create session, return session ID in header
        if (request.method === 'initialize') {
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { created: Date.now(), lastSeen: Date.now() });
          sendMCPResponse(req, res, 200, {
            jsonrpc: '2.0', id: request.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'docker-mcp', version: VERSION }
            }
          }, { 'Mcp-Session-Id': sessionId });
          return;
        }

        // Notifications have no id; acknowledge with 202 and no body
        if (request.id === undefined || request.id === null) {
          res.writeHead(202); res.end(); return;
        }

        // Validate session when client provides one
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId && !sessions.has(sessionId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            error: { code: -32000, message: 'Session not found' }
          }));
          return;
        }
        if (sessionId) sessions.get(sessionId).lastSeen = Date.now();

        // ping — MCP keepalive/utility method (protocolVersion 2025-03-26)
        if (request.method === 'ping') {
          sendMCPResponse(req, res, 200, {
            jsonrpc: '2.0', id: request.id, result: {}
          });
          return;
        }

        if (request.method === 'tools/list') {
          sendMCPResponse(req, res, 200, {
            jsonrpc: '2.0', id: request.id, result: { tools: MCP_TOOLS }
          });
          return;
        }

        // JSON-RPC protocol-level errors (unknown method, handler failures)
        // travel in the body over HTTP 200 — non-2xx is reserved for
        // transport-level failures (auth, session, request size).
        // A handler can set err.code (e.g. recreate lock → -32000); honor it.
        if (request.method === 'tools/call') {
          try {
            const result = await callToolLogged(request.params.name, request.params.arguments || {}, req.agentName, req.keyFp);
            sendMCPResponse(req, res, 200, { jsonrpc: '2.0', id: request.id, result });
          } catch (err) {
            sendMCPResponse(req, res, 200, {
              jsonrpc: '2.0', id: request.id,
              error: { code: Number.isFinite(err.code) ? err.code : -32603, message: err.message }
            });
          }
          return;
        }

        sendMCPResponse(req, res, 200, {
          jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not found' }
        });
      } catch (err) {
        // Malformed JSON is a JSON-RPC parse error; anything else is internal
        const parseFailed = err instanceof SyntaxError;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: parseFailed ? -32700 : -32603, message: err.message }
        }));
      }
    return;
  }

  if (url.pathname === '/containers' && req.method === 'GET') {
    try {
      const result = await handleMCPTool('docker_ps', { all: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result.content[0].text);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/run' && req.method === 'POST') {
    const body = await readBody(req, res).catch(() => null);
    if (body === null) return;
    try {
      const { image, cmd, name, ports, env } = JSON.parse(body);
      await pullImage(image);
      const container = await docker.createContainer({
        Image: image, Cmd: cmd, name,
        ExposedPorts: ports ? Object.fromEntries(Object.values(ports).map(c => [`${c}/tcp`, {}])) : undefined,
        HostConfig: {
          PortBindings: ports ? Object.fromEntries(Object.entries(ports).map(([h, c]) => [`${c}/tcp`, [{ HostPort: h }]])) : undefined
        },
        Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined
      });
      await container.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: container.id, status: 'started' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/stop' && req.method === 'POST') {
    const body = await readBody(req, res).catch(() => null);
    if (body === null) return;
    try {
      const { id } = JSON.parse(body);
      await docker.getContainer(id).stop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopped: id }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname.startsWith('/logs/') && req.method === 'GET') {
    const id = url.pathname.split('/')[2];
    if (!id) { res.writeHead(400); res.end(); return; }
    try {
      const result = await handleMCPTool('docker_logs', { id, tail: 100 });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(result.content[0].text);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
// Log and keep serving — an unexpected async error (e.g. inside docker-modem)
// must not take the management server down between calls
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// WebSocket log streaming: attach to an http.Server. Extracted from the
// require.main block so the jest suite can drive it against a real server.
function setupLogWebSocket(server) {
  const wss = new WebSocket.Server({ noServer: true });

  // Manual upgrade routing: ws 8.x's `path` option matches the pathname
  // exactly, which rejected /logs/<id> with HTTP 400 before verifyClient ran.
  // Accept both /logs and /logs/<id> (one segment), auth inline, then hand the
  // socket to wss. verifyClient is deprecated in ws 8 — this replaces it.
  server.on('upgrade', (req, socket, head) => {
    const rawReject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // Node's HTTP parser accepts absolute-form targets, so a crafted req.url can
    // make new URL() throw — reject the socket instead of letting the TypeError
    // escape the listener and wedge the (unauthenticated) connection.
    let url, m;
    try {
      url = new URL(req.url, 'http://localhost');
      m = url.pathname.match(/^\/logs(?:\/([^/]+))?$/);
    } catch {
      return rawReject(400, 'Bad Request');
    }
    if (!m) return rawReject(404, 'Not Found');
    const providedKey = req.headers['x-api-key'];
    if (!(providedKey && API_KEYS.get(providedKey))) return rawReject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._containerId = m[1] || url.searchParams.get('container') || null;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const containerId = ws._containerId;
    if (!containerId) { ws.close(1008); return; }
    console.log(`WebSocket log stream: ${containerId}`);
    docker.getContainer(containerId).logs({ follow: true, stdout: true, stderr: true, tail: 100 })
      .then(stream => {
        const out = new PassThrough();
        const err = new PassThrough();
        out.on('data', chunk => ws.send(chunk.toString()));
        err.on('data', chunk => ws.send(chunk.toString()));
        docker.modem.demuxStream(stream, out, err);
        stream.on('error', e => { ws.send(`Error: ${e.message}`); ws.close(); });
        ws.on('close', () => stream.destroy());
      })
      .catch(e => { ws.send(`Error: ${e.message}`); ws.close(); });
  });

  return { wss };
}

module.exports = { app, handleMCPTool, callToolLogged, sendMCPResponse, MCP_TOOLS, sessions, sweepSessions, parseApiKeys, RECREATE_LOCKS, REGISTRY_AUTH, setupLogWebSocket, setSelfContainerIdForTests };

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  const server = app.listen(PORT, () => {
    console.log(`Docker MCP server v${VERSION} running on port ${PORT}`);
    console.log(`Tools: ${MCP_TOOLS.length} | API Key required in X-API-Key header`);
  });

  // Sweep idle sessions every 10 minutes; unref'd so it never holds the process
  setInterval(() => { if (sweepSessions()) console.log('Swept expired sessions'); }, 10 * 60 * 1000).unref();

  const { wss } = setupLogWebSocket(server);

  // Signal handlers declared AFTER server + wss (fixes SIGTERM-before-declaration bug)
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
      wss.close(() => { console.log('Closed.'); process.exit(0); });
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
  process.on('SIGINT', () => process.emit('SIGTERM'));

  console.log(`WebSocket endpoint: ws://[server-host]:${PORT}/logs/{container_id} or /logs?container={container_id}`);
}
