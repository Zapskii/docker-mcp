# Usage guide

> ⚠️ **Internal use only. Do not expose this MCP server to the internet.**
> Every tool here acts with the Docker daemon's authority. Keep the endpoint on a
> trusted LAN/VPN and treat API keys as root credentials.
>
> The server uses **plain HTTP**, so API keys and tool payloads are unencrypted
> on the wire. Use a VPN or internal TLS proxy if the path is not fully trusted;
> never publish it.

This guide covers how to call the server, what each of the 49 tools expects, and
the safe workflow for common jobs. For installation, see
[SETUP.md](SETUP.md). For an agent-facing version, see
[../skills/docker-mcp/SKILL.md](../skills/docker-mcp/SKILL.md).

## Calling the server

All calls are MCP JSON-RPC 2.0 over HTTP with `X-API-Key`. Most users connect
through an MCP client; raw calls look like this:

```bash
curl -s -X POST http://<docker-host>:3001/mcp \
  -H 'Content-Type: application/json' -H 'X-API-Key: <secret>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"docker_ps","arguments":{"all":true}}}'
```

- `initialize` returns an `Mcp-Session-Id` header. Sessions are optional; if a
  client sends one it must be valid. Idle sessions expire after one hour.
- Tool-level failures come back as JSON-RPC errors with HTTP 200. Non-2xx is
  reserved for transport failures (401, 404 session, 400 body/Host, 413 size).
- `GET /mcp` is not supported (no server-initiated SSE stream).

## Argument conventions

| Convention | Meaning |
|---|---|
| Durations | `since`/`until` accept seconds, RFC3339, or `10m`/`24h`/`7d` |
| Byte sizes | `memory`-style fields are bytes (`536870912` = 512 MiB) |
| `ports` | Object of `{ "<hostPort>": "<containerPort>" }` |
| `env` | Object of `{ "KEY": "value" }` |
| `volumes` | Array of bind strings, e.g. `["/srv/app:/app:ro"]` |
| Async | `mode: "async"` on long operations returns `{ job_id }` |
| IDs | Container name, short id or full id; names win |

## Confirmation

Two independent mechanisms:

1. **`confirm: true`** — tools in `CONFIRM_REQUIRED_TOOLS` (default:
   `docker_image_rm`, `docker_volume_rm`, `docker_network_rm`,
   `docker_compose_down`) reject the call with a description unless
   `confirm: true` is passed. `docker_image_prune` with a truthy `all` also
   requires it. Dry runs are exempt.
2. **Two-phase tokens** — tools in `CONFIRM_TOOLS` return
   `{ confirm_required, confirm_token, expires_s }`. Repeat the identical call
   with `confirm_token` set. Tokens are single-use and bound to the args
   (`confirm`/`confirm_token` excluded), expiring after `CONFIRM_TTL_S`.

## Async jobs

`docker_pull`, `docker_build`, `docker_compose_up`, `docker_run` and
`docker_container_recreate` accept `mode: "async"`. They return
`{ job_id, type, status }` immediately. Poll `docker_job_status { job_id, tail }`
and cancel with `docker_job_cancel { job_id }`. Cancelling a recreate aborts the
health wait and rolls the old container back.

## Tool catalog

### Containers

| Tool | Arguments | Notes |
|---|---|---|
| `docker_ps` | `all`, `name`, `label`, `status` | List containers |
| `docker_run` | `image*`, `name`, `command`, `ports`, `env`, `volumes`, `pull`, `restartPolicy`, `maximumRetryCount`, `healthcheck`, `mode` | `healthcheck` = `{ test, interval_s, timeout_s, retries, start_period_s }` |
| `docker_start` / `docker_stop` / `docker_restart` | `id*` (`stop` also `signal`; `restart` also `timeout`) | Self-guard on `stop` |
| `docker_remove` | `id*`, `force` | Self-guard |
| `docker_rename` | `id*`, `name*` | Self-guard |
| `docker_inspect` | `id*`, `type` (`container`/`image`) | Full config, mounts, env, ports |
| `docker_logs` | `id*`, `tail`, `since`, `until`, `timestamps`, `follow` | `follow: true` returns a WebSocket URL; response capped by `LOG_MAX_BYTES` |
| `docker_exec` | `id*`, `command*`, `workdir`, `user`, `env`, `timeout` | Non-interactive |
| `docker_top` | `id*`, `ps_args` | Process table |
| `docker_stats` | `id` | One container, or all when omitted |
| `docker_wait` | `id*`, `condition` (`healthy`/`next-exit`), `timeout_s*` | Blocks; timeout is required |
| `docker_container_update` | `id*`, `restartPolicy`, `maximumRetryCount`, `nanoCpus`, `cpuShares`, `cpuPeriod`, `cpuQuota`, `cpusetCpus`, `memory`, `memorySwap`, `memoryReservation`, `pidsLimit` | Healthcheck changes need recreate |
| `docker_container_recreate` | `id*`, `pull`, `backup_name`, `start_timeout_s`, `mode` | Captures config, renames old aside, health-gates the new one, rolls back on failure |

### Images, builds and updates

| Tool | Arguments | Notes |
|---|---|---|
| `docker_images` | `dangling` | List images |
| `docker_pull` | `image*`, `mode` | Async recommended for large images |
| `docker_image_rm` | `name*`, `force`, `confirm` | Confirm required by default |
| `docker_image_tag` | `source*`, `repo*`, `tag` | |
| `docker_image_history` | `image*` | Layer history, newest first |
| `docker_image_prune` | `all`, `filters`, `dry_run`, `confirm` | `all` removes every unused image and needs `confirm: true`. `filters`: `until`, `label` (protection), `name` |
| `docker_build` | `context*`, `dockerfile`, `tag*`, `build_args`, `mode` | Context must resolve inside the container (`/srv`) |
| `docker_outdated` | `id`, `all` | Digest comparison against the registry; `update_available` may be `null` when it cannot be assessed |
| `docker_login` | `registry`, `username*`, `password*` | In-memory only; used for pulls and digest lookups |

### Volumes and networks

| Tool | Arguments | Notes |
|---|---|---|
| `docker_volume_ls` | `label` | |
| `docker_volume_create` | `name*`, `driver` | |
| `docker_volume_rm` | `name*`, `force`, `confirm` | Confirm required by default |
| `docker_volume_backup` | `name*`, `out_path*`, `gzip`, `pull` | `out_path` is on the **Docker host**; refuses to overwrite |
| `docker_volume_restore` | `name*`, `backup_path*`, `confirm`, `pull` | Wipes the target volume first; a non-empty volume requires `confirm: true` |
| `docker_network_ls` / `docker_network_inspect` | `name*` (inspect) | |
| `docker_network_create` | `name*`, `driver` | |
| `docker_network_rm` | `name*`, `confirm` | Confirm required by default |
| `docker_network_connect` / `docker_network_disconnect` | `network*`, `container*` | |

### Compose

| Tool | Arguments | Notes |
|---|---|---|
| `docker_compose_up` | `project` or `project_dir`, `build`, `detach`, `mode` | `-d` unless `detach: false` |
| `docker_compose_down` | `project` or `project_dir`, `volumes`, `confirm` | Confirm required by default |
| `docker_compose_ps` | `project*` | Per-service state, ports, status |
| `docker_compose_logs` | `project` or `project_dir`, `file`, `service`, `tail`, `since` | |
| `docker_compose_build` | `project` or `project_dir`, `service` | Build without starting |
| `docker_compose_pull` | `project*`, `mode` | Works on stopped stacks |
| `docker_compose_restart` | `project*` | Starts stopped services too |

`project_dir` must resolve inside the docker-mcp container (mount stacks under
`/srv`). Without it, the server derives the working directory from the project's
`com.docker.compose.project.working_dir` label.

### System, jobs and files

| Tool | Arguments | Notes |
|---|---|---|
| `docker_system_info` | — | Version, OS, CPUs, memory, counts |
| `docker_system_df` | — | Disk usage and reclaimable space |
| `docker_events` | `since`, `until`, `filters` (`container`, `type`, `event`), `tail` | Snapshot of the daemon's ~256-entry buffer, not a live stream |
| `docker_job_status` | `job_id*`, `tail` | |
| `docker_job_cancel` | `job_id*` | |
| `docker_copy` | `id*`, `direction*`, `container_path*`, `content`, `host_path` | `from`/`to` pass base64 tar (small files). `from_host`/`to_host` use `host_path`, resolved inside the docker-mcp container — use `/app/transfer` |

## Workflows

### Inspect before you change anything

```json
{"name":"docker_ps","arguments":{"all":true}}
{"name":"docker_inspect","arguments":{"id":"web"}}
{"name":"docker_system_df","arguments":{}}
```

### Deploy or update a compose stack

```json
{"name":"docker_compose_ps","arguments":{"project":"app"}}
{"name":"docker_compose_pull","arguments":{"project":"app","mode":"async"}}
{"name":"docker_compose_up","arguments":{"project":"app","build":true}}
{"name":"docker_compose_logs","arguments":{"project":"app","tail":100}}
```

If no containers exist yet for a new project, pass `project_dir` (e.g.
`/srv/stacks/app`) instead of `project`.

### Recreate one container on a newer image

```json
{"name":"docker_outdated","arguments":{"id":"web"}}
{"name":"docker_volume_backup","arguments":{"name":"web-data","out_path":"/srv/backups/web-data.tar","gzip":true}}
{"name":"docker_container_recreate","arguments":{"id":"web","backup_name":"web-old"}}
```

The old container is stopped, renamed to `web-old` and kept as a rollback. If
the replacement exits or misses its health deadline, it is removed and the old
container is restored. Increase `start_timeout_s` for slow starts; the default
derives from `Healthcheck.Interval` + `StartPeriod` and is clamped to 600s.

### Debug a failing container

```json
{"name":"docker_logs","arguments":{"id":"web","tail":200,"since":"30m"}}
{"name":"docker_exec","arguments":{"id":"web","command":["sh","-lc","ps aux"],"timeout":15000}}
{"name":"docker_stats","arguments":{"id":"web"}}
{"name":"docker_wait","arguments":{"id":"web","condition":"healthy","timeout_s":60}}
```

### Stream logs

`docker_logs` with `follow: true` returns a WebSocket URL:

```bash
websocat -H "X-API-Key: <secret>" "ws://<docker-host>:3001/logs/web"
```

Or `docker_logs` with filters and a bounded `tail` for point-in-time output.

### Disk cleanup

```json
{"name":"docker_system_df","arguments":{}}
{"name":"docker_image_prune","arguments":{"dry_run":true,"all":true}}
{"name":"docker_image_prune","arguments":{"all":true,"confirm":true}}
{"name":"docker_container_prune","arguments":{"dry_run":true}}
```

### Move a file into or out of a container

For small files, use base64 via `direction: "to"`/`"from"`. For anything large,
use the host path directions and keep both sides on the transfer mount:

```json
{"name":"docker_copy","arguments":{
  "id":"web","direction":"from_host",
  "host_path":"/app/transfer/nginx.conf",
  "container_path":"/etc/nginx/nginx.conf"}}
```

## Audit log

Each mutating call appends one JSON line (reads too with `AUDIT_READ_TOOLS=1`):

```json
{"ts":"2026-11-07T12:00:00.000Z","agent":"claude","key_fp":"ab12…9f","tool":"docker_run",
 "args":{"image":"nginx:latest","env":"[REDACTED]"},"ok":true,"duration_ms":42}
```

Secrets are redacted by key name at any depth (`password`, `token`, `secret`,
`env`). The audit log must never break a call, but if the file is unwritable the
server warns once and drops entries — check the log mount.

## Limits and behaviour worth knowing

- `docker_logs` returns at most `LOG_MAX_BYTES` (64 KiB default).
- `docker_events` is a one-shot snapshot of a small in-memory daemon buffer.
- `docker_copy` base64 directions are for small files only; the transport is
  synchronous HTTP.
- Recreating the server's own container is refused, as are stopping/removing/
  renaming it.
- A per-container recreate lock prevents concurrent recreates of the same
  container; it is released on success or rollback.
- Registry credentials are held in memory only and are lost on restart.
