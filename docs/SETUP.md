# Setup and install guide

> ⚠️ **Internal use only. Do not expose this MCP server to the internet.**
> It controls the Docker socket. A reachable API key is root-equivalent access to
> the host. Use a trusted LAN, VPN or loopback only — no public DNS, port
> forwarding, UPnP or public reverse proxy.

## 1. Requirements

- A Docker Engine host on a trusted network (the machine whose containers you
  want to manage).
- Access to `/var/run/docker.sock` on that host.
- One or more API keys. The server exits at startup if none are configured.
- Optional for running from source: Node.js 20+ and the `docker` CLI with the
  compose plugin.

Ports and paths used in this guide are examples. Replace `<docker-host>` with
your LAN hostname or IP, and never commit real keys.

## 2. Build the image

```bash
git clone <repo-url> docker-mcp-public
cd docker-mcp-public
docker build -t docker-mcp .
```

The image is `node:24-alpine` plus `docker-cli` and `docker-cli-compose`, which
the compose and build tools need. It runs as the unprivileged `node` user.

## 3. Prepare directories and keys

```bash
mkdir -p audit transfer
chmod 700 audit transfer
```

Generate a key per agent (each key is recorded in the audit log):

```bash
openssl rand -hex 32
```

Name the variables `API_KEY_<AGENT>`. The suffix is lowercased into the agent
name (`API_KEY_CLAUDE` → `claude`). A bare `API_KEY` is accepted as `default`.

## 4. Run the container

```bash
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

Mounts:

| Mount | Access | Why |
|---|---|---|
| `/var/run/docker.sock` | rw | Docker API access — required |
| `/srv` | ro | Compose/build working directories. Read-only so agents can deploy from stacks but not edit host files |
| `/app/transfer` | rw | Files for `docker_copy` with `to_host` / `from_host`. Keep this a dedicated directory |
| `/app/audit` | rw | Audit log output |

`--group-add` gives the `node` user access to the socket's group. If the
socket's group is not permitted, check the group id with
`stat -c %g /var/run/docker.sock`.

### Docker Compose example

```yaml
services:
  docker-mcp:
    image: docker-mcp
    container_name: docker-mcp
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv:/srv:ro
      - ./transfer:/app/transfer
      - ./audit:/app/audit
    group_add:
      - "${DOCKER_SOCKET_GID}"
    environment:
      AUDIT_LOG: /app/audit/audit.jsonl
      API_KEY_CLAUDE: "${API_KEY_CLAUDE}"
      API_KEY_AGENT2: "${API_KEY_AGENT2}"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/health"]
      interval: 30s
```

Keep the keys in an untracked `.env` file, not in the compose file.

`docker_compose_up`/`build` run the `docker` CLI inside this container. Their
`project_dir` and `context` paths must resolve inside the container, which is
why `/srv` is mounted and why compose stacks should live under it.

## 5. Verify

```bash
curl -s http://<docker-host>:3001/health
# {"status":"ok","server":"docker-mcp","version":"2.13.6","tools":49,"agents":1,"auth":"required"}

curl -s -X POST http://<docker-host>:3001/mcp \
  -H 'Content-Type: application/json' -H 'X-API-Key: <secret>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
```

`/health` is unauthenticated but returns only status, version and counts.

## 6. Connect an AI agent

All clients need the same three values:

- URL: `http://<docker-host>:3001/mcp`
- Transport: Streamable HTTP (POST)
- Header: `X-API-Key: <the agent's key>`

### Claude Code

```bash
claude mcp add --transport http docker-mcp http://<docker-host>:3001/mcp \
  --header "X-API-Key: <secret>"
```

Or commit/project config (`.mcp.json`):

```json
{
  "mcpServers": {
    "docker-mcp": {
      "type": "http",
      "url": "http://<docker-host>:3001/mcp",
      "headers": { "X-API-Key": "<secret>" }
    }
  }
}
```

### Claude Desktop and other MCP clients

Use the client's remote MCP / HTTP server setting with the URL and header above.
Older Claude Desktop builds only launch stdio servers; in that case bridge the
HTTP endpoint with `mcp-remote`:

```json
{
  "mcpServers": {
    "docker-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<docker-host>:3001/mcp",
               "--header", "X-API-Key: <secret>"]
    }
  }
}
```

### ChatGPT

If your ChatGPT plan/workspace has custom connectors with remote MCP support,
add a connector with the URL above and the `X-API-Key` header. Plans without
remote MCP connectors cannot call this server directly; do not work around that
by exposing it publicly.

### Hermes Agent / OpenClaw

These agents integrate with MCP through their own server/plugin configuration.
Add a Streamable HTTP server named `docker-mcp` using the URL and
`X-API-Key` header above; the exact config keys differ between builds, so follow
that agent's MCP documentation. Then load the skill file (below) as the agent's
skill or system instructions.

### Install the agent skill

The portable skill lives at [skills/docker-mcp/SKILL.md](../skills/docker-mcp/SKILL.md).

- **Claude Code:** copy it to `.claude/skills/docker-mcp/SKILL.md` in the
  project (or into `~/.claude/skills/docker-mcp/SKILL.md`), then invoke it as
  `/docker-mcp`.
- **ChatGPT:** paste the body into the custom GPT's instructions.
- **Hermes Agent / OpenClaw:** add it as a skill/instructions file according to
  that agent's documentation.

The skill contains safety rules, tool selection and workflows. It assumes the
server is already connected and never includes a key.

## 7. Run from source (optional)

```bash
npm ci
API_KEY_CLAUDE=<secret> PORT=3001 npm start
```

Running from source needs the `docker` and `docker compose` CLIs on the local
machine and permission to use the Docker socket. The self-guard is only armed
when the hostname is a 12-hex container id, so running outside a container
leaves it off.

## 8. Network hardening checklist

- Bind the port to a private interface or restrict it with the host firewall to
  known agent IPs. `-p 3001:3001` listens on all interfaces.
- Never publish the port on a router, never enable UPnP, never add a public DNS
  record.
- If you need TLS, terminate it on an internal reverse proxy that is also
  restricted to the private network. TLS does not make internet exposure safe.
- Keep `/srv` read-only; give agents the smallest writable transfer directory
  they need.
- Use one key per agent and rotate keys by restarting the container with a new
  value.
- Keep the image and Docker Engine patched; rebuild after Linux or Docker
  security releases.
- Review `audit/audit.jsonl`; it records mutating calls, agent names, key
  fingerprints and redacted arguments.
- Do not run the daemon's TCP socket (`2375`/`2376`) on the network.

## 9. Operations

- **Upgrade:** `docker build -t docker-mcp .` then recreate the container
  (`docker compose up -d`). Configuration and audit files are mounted, so they
  survive.
- **Rotate a key:** change the env var and recreate the container. Old sessions
  and keys stop working immediately.
- **Disable auditing:** set `AUDIT_LOG=off`. Not recommended on shared hosts.
- **More confirmation gates:** add tools to `CONFIRM_REQUIRED_TOOLS` or use
  `CONFIRM_TOOLS` for the two-phase token flow. See
  [USAGE.md](USAGE.md#confirmation).

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Server exits on startup | At least one `API_KEY`/`API_KEY_<AGENT>` must be set |
| `permission denied` on the socket | `--group-add "$(stat -c %g /var/run/docker.sock)"` |
| Compose tool cannot find the stack | The compose directory must be under the mounted `/srv`, and pass `project_dir` |
| `docker_copy` writes to an unexpected place | `host_path` resolves inside the docker-mcp container; use `/app/transfer` or `/tmp` |
| A tool returns a confirm error | Re-run with `confirm: true` or follow the `confirm_token` flow |
| "recreate in progress" | Another recreate for that container is live; wait for it or for the lock TTL |
| 401 on every call | Missing or wrong `X-API-Key` header |
