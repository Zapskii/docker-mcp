# docker-mcp

An MCP server for managing Docker in a home lab.

> ⚠️ **Internal use only. Do not expose this MCP server to the internet.**
>
> This server mounts the Docker socket and can start, stop and delete anything on
> the host. Anyone who can reach it with a valid API key has root-equivalent
> control. Run it only on a trusted private network (LAN, VPN or a single host),
> never with public DNS, port forwarding, UPnP or a public reverse proxy.
>
> The built-in server uses **plain HTTP** — API keys and tool payloads are
> unencrypted on the wire. If the network path is shared or semi-trusted, put it
> behind an internal TLS proxy or VPN. TLS does not make internet exposure safe.

A single-file [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents manage a Docker host over JSON-RPC 2.0. It exposes **49 tools** covering containers, images, volumes, networks, compose stacks, async jobs, events and registry auth.

Built on plain Node.js `http`, [`dockerode`](https://github.com/apocas/dockerode) and [`ws`](https://github.com/websockets/ws), with no MCP SDK.

## Documentation

| Document | Purpose |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Install, configure, harden and connect an AI agent |
| [docs/USAGE.md](docs/USAGE.md) | Tool catalog, arguments and common workflows |
| [skills/docker-mcp/SKILL.md](skills/docker-mcp/SKILL.md) | Agent skill / system prompt for Claude, ChatGPT, Hermes Agent and OpenClaw |

## Quick start

```bash
docker build -t docker-mcp .
mkdir -p audit transfer

docker run -d --name docker-mcp --restart unless-stopped \
  -p 3001:3001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /srv:/srv:ro \
  -v "$PWD/transfer:/app/transfer" \
  -v "$PWD/audit:/app/audit" \
  -e AUDIT_LOG=/app/audit/audit.jsonl \
  -e API_KEY_CLAUDE=<secret> \
  docker-mcp
```

Then check `curl http://<docker-host>:3001/health`. See [docs/SETUP.md](docs/SETUP.md) for keys, mounts and network rules.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`) |
| `GET /health` | Health check — unauthenticated, returns only version/tool counts |
| `/containers`, `/run`, `/stop`, `/logs/:id` | Legacy REST API (authenticated) |
| `ws://…/logs/<id>` or `ws://…/logs?container=<id>` | Streaming container logs (authenticated) |

## Security model

- **API key on every request** (`X-API-Key`). The server refuses to start without
  at least one `API_KEY` or `API_KEY_<AGENT>` variable. Keys are read from the
  container environment at startup into memory — the server stores no key file
  or database. See [docs/SETUP.md](docs/SETUP.md#3-create-api-keys).
- **Named agents in the audit trail.** `API_KEY_<AGENT>` records the lowercased
  agent name on every audit line, so a shared host still shows who did what.
- **Self-guard.** The server refuses to stop, remove, rename or recreate its own
  container — that would take MCP down with no MCP path back.
- **Confirmation gates.** Destructive removals need `confirm: true`; configure
  more with `CONFIRM_TOOLS`/`CONFIRM_REQUIRED_TOOLS`. `docker_image_prune` with
  `all: true` always requires `confirm: true`.
- **Audit log.** JSONL for mutating calls (including legacy REST `/run` and
  `/stop`), with secrets redacted and keys shown only as a masked
  `first4…last4`. Set `AUDIT_LOG=off` to disable.
- **Read-only stacks mount.** Bind-mount compose directories read-only (`:ro`)
  and give `docker_copy` a separate writable transfer directory only.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Listen port |
| `API_KEY` / `API_KEY_<AGENT>` | — | Required API keys, read at startup; the suffix names the agent |
| `AUDIT_LOG` | `/app/audit.jsonl` | JSONL audit file for mutating tool calls, or `off` |
| `AUDIT_READ_TOOLS` | unset | `1` also audits read-only tools |
| `CONFIRM_TOOLS` | unset | Two-phase token flow for comma-separated tools |
| `CONFIRM_TTL_S` | `60` | Confirm-token lifetime, in seconds |
| `CONFIRM_REQUIRED_TOOLS` | `docker_image_rm,docker_volume_rm,docker_network_rm,docker_compose_down` | Tools that require `confirm: true`, or `off` |
| `LOG_MAX_BYTES` | `65536` | Cap on a `docker_logs` response |

Full details and a compose example are in [docs/SETUP.md](docs/SETUP.md).

## Tests

```bash
npm install
npm test   # jest with the Docker API mocked — no daemon needed
```
