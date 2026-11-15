# ProjectFreeze

ProjectFreeze is a free, open-source tool for discovering and managing developer workloads on your computer. Open the terminal interface with `projectfreeze`, use versioned JSON from scripts, or connect an MCP client over stdio. The daemon runs under your account and keeps ownership and operation history in a private SQLite database.

## Quick start

```sh
npx @kubilaycakmak/projectfreeze@next
```

Run this in an interactive terminal to download and open the current npm prerelease. Confirm the npm installation prompt if it appears. If PowerShell blocks the `npx.ps1` shim, run `npx.cmd @kubilaycakmak/projectfreeze@next`.

Freeze, Sleep, and Force Terminate can interrupt running work. Save your work and review the selected processes before using these controls. See [License and liability](#license-and-liability).

## Requirements

Use Node.js 24.11.0 or later in the 24.x series, or Node.js 26.x, with `npm` and `npx` on your `PATH`. The npm package includes native helpers for the platforms below. The core CLI runs under your user account without a compiler, administrator or root access, or Docker.

| Platform | Tested operating systems and architectures |
| --- | --- |
| Windows | Windows 11 (x64 and ARM64) and Windows Server 2025 (x64) |
| macOS | macOS 15 (Intel x64 and Apple silicon ARM64) |
| Linux | Ubuntu 24.04 (x64 and ARM64). The native helper uses glibc and requires a mounted `/proc` filesystem. |

Node.js 24 verification covered Windows 11 ARM64, Windows Server 2025, macOS, and Linux. Node.js 26 was tested on Windows and Linux x64, including a manual Windows 11 test. Optional integrations have their own prerequisites, including Docker for Compose and Docker checkpoints, CRIU for native Linux checkpoints, and a user systemd manager for Linux service control. See the [operations guide](docs/operations.md) and [integration requirements](docs/interfaces.md#recipes).

## Using the menu

Use the arrow keys to select a project, Enter to inspect it, and Tab to switch views. Use `/` to search, `f` to Freeze, `z` for Sleep, `w` for Wake, and `q` to disconnect. Press `?` for the full key reference. ProjectFreeze asks you to review candidate processes before adoption.

Append `menu --plain` to the quick-start command for a line-driven fallback. To run individual commands, pass them after the package name.

```sh
npx @kubilaycakmak/projectfreeze@next discover --json
npx @kubilaycakmak/projectfreeze@next listeners
npx @kubilaycakmak/projectfreeze@next inspect PROJECT
npx @kubilaycakmak/projectfreeze@next freeze PROJECT
npx @kubilaycakmak/projectfreeze@next resume PROJECT
```

Freeze preserves process memory and usually retains bound ports. Sleep shuts down approved resources and requires a durable restart recipe. Wake starts a fresh workload and waits for configured readiness. Checkpoint and restore depend on the eligible local backend and capture scope.

The development build adds Ports and Services views and a two-step `k` force-termination command for one owned native project. Build the local helper with `npm run build:native` and open the development menu with `node bin/projectfreeze.js`. Set `PROJECTFREEZE_HOME` to a separate absolute directory to test alongside an installed copy.

- [Commands, recipes, and MCP](docs/interfaces.md)
- [Architecture, security, and recovery](docs/operations.md)
- [Development, verification, and packaging](CONTRIBUTING.md)

## License and liability

ProjectFreeze is provided “as is” under the MIT License, without warranties. Use it at your own risk. The authors and copyright holders disclaim liability for claims, damages, or other losses arising from the software or its use to the extent permitted by applicable law. See the [MIT License](LICENSE) for the full terms.
