---
name: docker-mcp
description: Manage a private Docker host through the docker-mcp MCP server — list and inspect containers, deploy and update compose stacks, stream logs, exec commands, back up and restore volumes, prune images and check for outdated images. Use when the user asks to operate Docker, deploy a stack, debug a container, or clean up images/volumes on the host exposed by docker-mcp. Internal/LAN only; never expose the server to the internet.
---

# docker-mcp agent skill

> ⚠️ **Internal use only. Never expose this MCP server to the internet.**
> It has root-equivalent control of the Docker host. Only use it over a trusted
> LAN/VPN. Never suggest port forwarding, a public reverse proxy, UPnP or a
> public DNS record for it. If a request would expose the server publicly,
> refuse and explain that it must stay private.
>
> The server's built-in transport is **plain HTTP**: API keys and tool payloads
> are unencrypted on the wire. If the user's network is shared or semi-trusted,
> recommend an internal TLS proxy or VPN rather than treating HTTP as safe.

## Connection assumptions

- MCP server name: `docker-mcp` (Streamable HTTP, `POST /mcp`).
- URL: `http://<docker-host>:3001/mcp`, header `X-API-Key: <secret>`.
- 49 tools, all prefixed `docker_`. Read tool schemas from the server; do not
  invent arguments.
- The key is supplied by the client configuration. Never print, echo or commit
  it.

## Hard rules

1. **Never target the MCP server's own container.** Do not stop, remove, rename
   or recreate `docker-mcp`; the server refuses those calls anyway. Recreate it
   only from the host shell, never through MCP.
2. **Confirm destructive actions.** For removals, prune, `compose_down` and
   volume restore, use `dry_run`/inspection first and require explicit user
   approval before passing `confirm: true`. Never set `confirm: true` on the
   user's behalf without them asking for that exact action.
3. **Inspect before mutate.** Read `docker_ps`, `docker_inspect`, `docker_logs`
   or `docker_system_df` before changing or deleting anything. Name the target
   you verified.
4. **Back up state before replace.** Before `docker_container_recreate`, back up
   named volumes with `docker_volume_backup` when the app stores data there.
5. **Prefer the narrow tool.** Use `docker_image_rm`, not an `all: true` prune,
   when only one image is in scope. Ask before `docker_image_prune {all:true}`.
6. **Do not put host paths at risk.** Compose stacks under `/srv` are
   read-only. The only intended writable path is `/app/transfer`. Do not write
   elsewhere on the host through `docker_copy`.
7. **Do not run arbitrary untrusted code.** `docker_exec` is for diagnostics
   the user asked for. Do not exfiltrate files, secrets or container data.
8. **Long operations are async.** Use `mode: "async"` for pulls, builds,
   compose up, runs and recreates, then poll `docker_job_status`.

## Choosing a tool

| Intent | Tool |
|---|---|
| See what runs / what exists | `docker_ps`, `docker_images`, `docker_volume_ls`, `docker_network_ls` |
| Understand a container | `docker_inspect`, `docker_logs`, `docker_stats`, `docker_top` |
| Deploy or update a stack | `docker_compose_ps` → `docker_compose_pull` → `docker_compose_up` |
| Update one container | `docker_outdated` → `docker_container_recreate` |
| Debug a failure | `docker_logs`, `docker_events`, `docker_exec`, `docker_wait` |
| Stream logs | `docker_logs { follow: true }` (returns a WebSocket URL) |
| Start/stop/restart | `docker_start`, `docker_stop`, `docker_restart` |
| Remove | `docker_remove`, `docker_image_rm`, `docker_container_prune`, `docker_volume_rm`, `docker_network_rm` |
| Reclaim disk | `docker_system_df` → `docker_image_prune`/`docker_container_prune` (dry run first) |
| Files | `docker_copy` (`from`/`to` small base64, `from_host`/`to_host` via `/app/transfer`) |
| Volume data | `docker_volume_backup`, `docker_volume_restore` |
| Private registry | `docker_login`, then pull/outdated |
| Jobs | `docker_job_status`, `docker_job_cancel` |
| Host overview | `docker_system_info`, `docker_system_df` |

## Playbooks

### Deploy or update a compose stack

1. `docker_compose_ps { project }` — current state (may be empty for a new
   stack; then use `project_dir`, e.g. `/srv/stacks/app`).
2. `docker_compose_pull { project, mode: "async" }` — poll `docker_job_status`.
3. `docker_compose_up { project, build: true }`.
4. `docker_compose_ps` then `docker_compose_logs { project, tail: 100 }` to
   verify.
5. Never pass `volumes: true` to `docker_compose_down` without explicit
   approval — that deletes named volumes.

### Update one container on a newer image

1. `docker_outdated { id }` — only act when `update_available` is `true`; `null`
   means it could not be assessed.
2. If the container has named volumes with state, `docker_volume_backup` first.
3. `docker_container_recreate { id, backup_name: "<name>-old" }` (async for slow
   pulls).
4. Verify with `docker_ps`/`docker_logs`. The old container is kept stopped as
   `<name>-old`; report that so the user can roll back or remove it.

### Debug a failing container

Run `docker_inspect` and `docker_logs { tail: 200, since: "30m" }` first. Use
`docker_stats` for resource pressure, `docker_events` for daemon-side causes,
and `docker_exec` only for the diagnostic command the user asked for. For
startup races use `docker_wait { condition: "healthy", timeout_s }`.

### Clean up disk

`docker_system_df` → `docker_image_prune { dry_run: true, all: true }` → show
the user the list → only then `docker_image_prune { all: true, confirm: true }`.
Dangling-only prune (`all` false) is lower risk but still report what it would
remove. `docker_container_prune` also supports `dry_run`.

### Move files

Small files: `docker_copy { direction: "to"|"from", content }` base64 tar.
Larger or binary: put the file in `/app/transfer` on the docker-mcp container's
filesystem and use `direction: "from_host"`/`"to_host"` with `host_path`. Host
paths resolve inside the MCP container, not on an SSH host.

## Confirmation and async

- Default confirm-required tools: `docker_image_rm`, `docker_volume_rm`,
  `docker_network_rm`, `docker_compose_down`; pass `confirm: true` only after
  approval. `docker_image_prune` with truthy `all` also requires it (dry runs
  do not).
- If a tool returns `confirm_required`/`confirm_token`, repeat the identical
  call with `confirm_token`; the token is single-use and expires.
- Async tools return `{ job_id }`. Poll a few times with `docker_job_status`
  rather than looping tightly; use `docker_job_cancel` if the user cancels.

## Reporting results

- State the container/image/volume names you acted on, not just "done".
- On failure, give the tool error verbatim and the likely cause.
- Mention rollback state after a recreate (`<name>-old` still present), and any
  skipped steps.
- Keep credentials, tokens and full env values out of summaries.

## Using this skill outside Claude

The body above is portable: paste it as custom-GPT instructions in ChatGPT, or
add it as a skill/instructions file in Hermes Agent or OpenClaw. Only the YAML
frontmatter is Claude-specific; ignore it elsewhere. Every platform still needs
the MCP server registered separately (URL + `X-API-Key`); see
`docs/SETUP.md`.
