# @neurealistic/backlog-mcp

An [MCP](https://modelcontextprotocol.io) server for a **markdown task backlog** — CRUD over
`backlog/tasks/*.md` with **atomic, collision-safe id assignment**.

It writes the exact file shape that the [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI and
board read (frontmatter + `## Acceptance Criteria` / `## Implementation Plan` /
`## Implementation Notes`), so it is a drop-in, safer alternative to `backlog task create` for
programmatic callers: id allocation happens under a lockfile and a `wx` write, so a concurrent create
can **never overwrite** an existing task. Structured JSON params also remove the CLI's shell-escaping
footguns (backticks / angle brackets / pipes).

## Install

```bash
npm install -g @neurealistic/backlog-mcp
```

## Run

**stdio** (the default — an MCP client such as Claude Code spawns it):

```bash
BACKLOG_DIR=/path/to/backlog backlog-mcp
```

**HTTP** (Streamable HTTP transport):

```bash
MCP_PORT=3457 BACKLOG_DIR=/path/to/backlog backlog-mcp
# → http://localhost:3457/mcp
```

Register it in an MCP client (`.mcp.json`):

```json
{
  "mcpServers": {
    "backlog": {
      "command": "backlog-mcp",
      "env": { "BACKLOG_DIR": "/path/to/backlog" }
    }
  }
}
```

## Backlog directory

Resolved per call as: the tool's `dir` param → **persisted home** (`set_home`) → `$BACKLOG_DIR` →
`<cwd>/backlog`. Call `set_home` once and later calls need no `dir`; an explicit `dir` still overrides
per call, so one server can serve several backlogs (e.g. a workspace `TASK-*` and a project `CEN-*`) —
the id prefix comes from each dir's `config.yml` (`task_prefix`). The home is stored per-user at
`$BACKLOG_MCP_CONFIG` (default `~/.config/backlog-mcp/config.json`).

## Tools

| Tool | Description |
|------|-------------|
| `set_home` | Set the default backlog dir (persisted); optionally `init` an empty dir (creates `tasks/` + `config.yml`). |
| `get_home` | Show the current default backlog dir + how it was resolved. |
| `task_list` | List tasks (id, title, status, labels, AC progress); optional status filter. |
| `task_get` | Read one task in full (frontmatter + AC + plan + notes). |
| `task_create` | Create a task with an atomic collision-safe id (never overwrites). |
| `task_update` | Update status / plan / notes (replace), append a comment, or check/uncheck an AC by number. |
| `task_delete` | Delete a task file (destructive). |

Every write takes a per-dir lock (`.mcp-lock`, 10s TTL); a create allocates its id **inside** the lock
and writes with `wx`, so ids are race-free and never clobbered.

## License

MIT
