# docker-mcp

A single-file [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents manage a Docker host over JSON-RPC 2.0. It exposes 49 tools covering containers, images, volumes, networks, compose stacks, async jobs, events and registry auth.

It is built on plain Node.js `http`, [`dockerode`](https://github.com/apocas/dockerode) and [`ws`](https://github.com/websockets/ws), with no MCP SDK.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP JSON-RPC 2.0 endpoint (`tools/list`, `tools/call`, …) |
| `GET /health` | Health check |
| `/containers`, `/run`, `/stop`, `/logs/:id` | Legacy REST API |
| `ws://…/logs/<id>` or `ws://…/logs?container=<id>` | Streaming container logs |

## Run

```bash
docker build -t docker-mcp .
docker run -d --name docker-mcp --restart unless-stopped \
  -p 3001:3001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /srv:/srv:ro \
  -v "$PWD/audit:/app/audit" -e AUDIT_LOG=/app/audit/audit.jsonl \
  -e API_KEY_CLAUDE=<secret> \
  docker-mcp
```

- `--group-add` gives the container's `node` user access to the Docker socket.
- The compose and build tools run the docker CLI with `project_dir` and `context` paths, and those paths must resolve inside the container. Bind-mount the directory that holds your stacks (shown here as `/srv`, read-only).
- Mount a writable directory at `/app/transfer` if you want to use `docker_copy` with `to_host`.

> ⚠ Mounting the Docker socket gives root-equivalent control of the host. Expose this server only on a trusted network, and only with API keys set.

## Authentication

Clients send `X-API-Key: <secret>`. Each `API_KEY_<AGENT>=<secret>` env var defines a named agent, and that name is recorded in audit lines. A bare `API_KEY` is accepted as the agent `default`.

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' -H 'X-API-Key: <secret>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Listen port |
| `AUDIT_LOG` | `/app/audit.jsonl` | Path of the JSONL audit file for tool calls (including the legacy REST `/run` and `/stop` routes), or `off`. Secrets are redacted and keys are fingerprinted. |
| `AUDIT_READ_TOOLS` | unset | Set to `1` to audit read-only tools as well as mutating ones |
| `CONFIRM_TOOLS` | unset | Comma-separated tools that need a two-phase call: the first call returns a single-use `confirm_token` bound to its args |
| `CONFIRM_TTL_S` | `60` | Lifetime of a confirm token, in seconds |
| `CONFIRM_REQUIRED_TOOLS` | `docker_image_rm,docker_volume_rm,docker_network_rm,docker_compose_down` | Tools that require `confirm: true`, or `off` |
| `LOG_MAX_BYTES` | `65536` | Cap on the size of a `docker_logs` response |

`docker_image_prune` with `all: true` also requires `confirm: true` — it removes every unused image, not just dangling ones. Use `dry_run: true` to preview first.

The server refuses to stop, remove, rename or recreate its own container.

## Tests

```bash
npm install
npm test   # jest, with dockerode mocked, so no Docker daemon is needed
```
