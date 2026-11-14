# Commands, recipes, and MCP

With no arguments, a terminal session opens the interactive interface. A redirected session produces a project listing. `--json` uses a single object with `schemaVersion: 1`, `ok`, and either `data` or `error`. A failed operation can carry its durable journal as `data` with `ok: false`.

| Command | Behavior |
| --- | --- |
| `list`, `discover`, `inspect PROJECT` | Report registered projects, candidate projects, and scoped observations. |
| `adopt --cwd DIR --member PID@BIRTH@BOOT --confirm` | Approve exact identities from current discovery. Repeat `--member` and `--exclude` as needed. `--recipe FILE` supplies restart settings. |
| `run --cwd DIR -- EXECUTABLE ARG...` | Launch literal arguments. Use a fully qualified executable or an absolute PATH entry. |
| `run --recipe FILE` | Launch a reviewed JSON recipe. |
| `freeze PROJECT...`, `resume PROJECT...` | Suspend owned execution or release recorded suspensions. |
| `sleep PROJECT...`, `wake PROJECT...` | Stop reviewed resources or start from a durable recipe. |
| `checkpoint PROJECT --backend criu\|docker` | Capture supported local state. |
| `restore PROJECT --checkpoint ID` | Restore a verified capture while the workload is stopped. |
| `reconcile [PROJECT...]` | Compare stored state against current resources. |
| `history`, `operation ID`, `cancel ID` | Read operations and request cancellation. |
| `daemon start\|status\|stop\|foreground` | Control daemon lifecycle. |
| `mcp` | Run the local MCP stdio server. |

Mutating commands wait for an operation result unless `--detach` is given. The operation has a UUID, action, project list, status, UTC timestamps, pending step, and per-resource outcomes. Closing the terminal or interrupting the CLI disconnects the client. `cancel ID` requests cancellation before the next resource boundary. Completed effects and in-flight native calls can survive cancellation.

| Exit code | Meaning |
| --- | --- |
| 0 | Successful command or accepted detached operation |
| 1 | Internal failure |
| 2 | Invalid input |
| 3 | Resource or identity missing |
| 4 | Permission or policy denied |
| 5 | Capability unavailable on this host or capture scope |
| 6 | Operation conflict |
| 7 | Partial or interrupted operation |
| 8 | Cancelled |
| 9 | Prerequisite or daemon unavailable |

## Recipes

```json
{
  "cwd": "/absolute/project/path",
  "argv": ["node", "server.js"],
  "env": ["APP_DATABASE_URL"],
  "dependencies": [],
  "ready": { "address": "127.0.0.1", "port": 8080 },
  "stop": ["node", "shutdown.js"],
  "timeout": 10000,
  "restart": "never"
}
```

`argv` and `stop` are literal argument arrays. For shell scripts select the shell explicitly and supply its arguments. Windows recipes can call `cmd.exe` or `powershell.exe` explicitly to interpret shell commands. Keep secret values out of literal arguments and recipe files. `env` names refer to values in the daemon environment at launch. Start or restart the daemon from an environment containing the required values. The daemon passes a small platform environment and the listed references to workloads. Output streams of managed launches are discarded to keep secret-bearing logs out of state. Configure application logging at the workload boundary.

`ready` connects to a loopback TCP port observed on an owned process. `stop` should implement application-specific graceful shutdown. Without `stop`, POSIX uses SIGTERM. Windows requires `stop` or specifically approved `--force` termination. `restart: "on-failure"` permits up to three retries while the launch supervisor remains available. Linux may specify `cgroup` as an existing delegated cgroup v2 parent directory. `containers` entries name a Compose `project`, `service`, and explicit `shared` boolean. Exclusive services must be existing containers with matching Compose labels and restart policy `no`.

## MCP

```json
{
  "mcpServers": {
    "projectfreeze": { "command": "projectfreeze", "args": ["mcp"] }
  }
}
```

The stdio server implements initialization, `tools/list`, `tools/call`, cancellation, and progress notifications for operations requested with a progress token. Tool schemas are returned by `tools/list`. Tool output uses the CLI data shapes and the same daemon ownership checks. The MCP host grants local permissions to its process and must use its approval UI when requesting ambiguous adoption, launching code, or forcing shutdown. See the [MCP stdio transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
