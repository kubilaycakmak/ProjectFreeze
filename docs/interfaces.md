# Commands, recipes, and MCP

With no arguments, a terminal session opens the interactive interface. A redirected session produces a project listing. `--json` uses a single object with `schemaVersion: 1`, `ok`, and either `data` or `error`. A failed operation can carry its durable journal as `data` with `ok: false`.

| Command | Behavior |
| --- | --- |
| `list`, `discover`, `inspect PROJECT` | Report registered projects, candidate projects, and scoped observations. |
| `menu`, `menu --plain` | Open the live keyboard interface or its line-driven fallback. |
| `listeners` | List TCP endpoints and PIDs for locally observable processes. Unassigned entries are read-only. |
| `ports` | List local TCP listeners and bound UDP sockets. Reports a PID when ownership is available. |
| `services` | List running services visible to the local Windows SCM, systemd system and user managers, or the current macOS launchd domain. |
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

The live menu rescans on entry and periodically. Tab or Left/Right switches between Projects, Ports, Services, and History. Arrow keys and Page Up/Down move the selection or scroll details. Enter opens the selection or confirms a preview. Escape goes back or cancels. Search with `/` and use Space to select multiple projects. Ports and Services are read-only views. Ports reads local OS tables without probing the network. Linux Ports shows the current network namespace. Socket ownership or service manager access can depend on the current account. Discovered processes need explicit ownership review before control.

Select one owned native project and press `k` to review force termination. The preview lists the exact process IDs. Press Enter to continue, then type `KILL` and press Enter again to authorize SIGKILL on Linux and macOS or TerminateProcess on Windows. Esc cancels either prompt. Force termination skips graceful shutdown and suppresses automatic restart. Use `w` to start again when a restart recipe is available. ProjectFreeze rejects a changed process set and directs projects with registered services or active dependents to their service shutdown workflow.

## Test Sleep and Wake

Use the included `examples/stream-test.mjs` to create a launch recipe and see the process identity at the client. From a dedicated test directory, run `node /path/to/stream-test.mjs --recipe stream.recipe.json 8788`. Press `l`, enter the recipe path, and confirm with Enter. In another terminal run `curl -N http://127.0.0.1:8788/stream` (`curl.exe` on Windows). Select the project, press `z`, and confirm. The stream ends and the listener disappears. Press `w`, confirm, and reconnect with curl to see the new PID. The fixture includes a graceful shutdown command. Choose an unused port if `8788` is occupied.

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

On Linux, set `systemd` to an array such as `[{"unit":"worker.service","shared":false},{"unit":"worker.timer","shared":false}]`. Link the reviewed unit files into your user manager with `systemctl --user link /absolute/project/worker.service /absolute/project/worker.timer`. Keep unit files within the project, restrict write access to their owner, set the service `WorkingDirectory` to the project, and configure `SendSIGKILL=no`. The adapter controls only the exact loaded units. It rejects drop-ins and activation or lifecycle dependencies outside the exclusive reviewed set. Active timers in that set are stopped before service suspension or shutdown and restarted after recovery.

Use `supervisors` to associate existing platform resources with a project recipe. Set `shared` to `true` for observation-only resources. Cross-project references are also treated as shared.

| Platform | Example entry | Verified scope |
| --- | --- | --- |
| macOS | `{"kind":"launchd","name":"com.example.worker","plist":"/absolute/project/worker.plist","shared":false}` | A loaded GUI user LaunchAgent with an owner-controlled project plist, matching executable and working directory, one observable process, and no automatic activation. |
| Windows | `{"kind":"scm","name":"ExampleWorker","shared":false}` | An existing manual-start, own-process service with an executable in the project, no dependencies, dependents, triggers, or recovery actions, and a current-user or LocalService account. SCM decides which controls the service supports. |
| Windows | `{"kind":"task","name":"\\ExampleTimer","shared":false}` | An existing low-privilege task for the current user with a single project executable and matching working directory. Running or queued tasks delay freeze and sleep. Only idle activation is disabled and restored. |

Register and authorize platform resources through the operating system before giving ProjectFreeze their definitions. Worker output, arguments, and credentials remain in the owning supervisor. ProjectFreeze pins reviewed definitions and rejects changed fingerprints. PowerShell on Windows executes the installed adapter with the existing execution policy.

## MCP

```json
{
  "mcpServers": {
    "projectfreeze": { "command": "projectfreeze", "args": ["mcp"] }
  }
}
```

The stdio server implements initialization, `tools/list`, `tools/call`, cancellation, and progress notifications for operations requested with a progress token. Tool schemas are returned by `tools/list`. Tool output uses the CLI data shapes and the same daemon ownership checks. The MCP host grants local permissions to its process and must use its approval UI when requesting ambiguous adoption, launching code, or forcing shutdown. See the [MCP stdio transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
