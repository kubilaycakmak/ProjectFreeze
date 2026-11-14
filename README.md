# ProjectFreeze

ProjectFreeze discovers and manages developer workloads on the local machine. Open the terminal interface with `projectfreeze`, use versioned JSON from scripts, or connect an MCP client over stdio. The daemon runs under your account and keeps ownership and operation history in a private SQLite database.

The current version is a development candidate. Install a verified tarball from the GitHub Actions run or build it from source. The proposed registry command is `npx @kubilaycakmak/projectfreeze@latest` after publication.

```sh
npm install --global /path/to/kubilaycakmak-projectfreeze-0.1.0-dev.0.tgz
projectfreeze
```

From a terminal, press Enter to inspect a project, Right to expand its resources, and `f` to review a freeze. ProjectFreeze asks you to review the candidate PIDs when ownership is unclear. Use Space to select multiple registered projects. Press `?` for all shortcuts or `q` to disconnect.

```sh
projectfreeze discover --json
projectfreeze inspect PROJECT
projectfreeze freeze PROJECT
projectfreeze resume PROJECT
```

Freeze preserves process memory and usually retains bound ports. Sleep shuts down approved resources and requires a durable restart recipe. Wake starts a fresh workload and waits for configured readiness. Checkpoint and restore depend on the eligible local backend and capture scope.

- [Commands, recipes, and MCP](docs/interfaces.md)
- [Architecture, security, and recovery](docs/operations.md)
- [Public HTTPS workload](docs/public-workload.md)
- [Development, verification, and packaging](CONTRIBUTING.md)

MIT licensed. See [LICENSE](LICENSE).
