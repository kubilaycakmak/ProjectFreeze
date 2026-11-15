# Contributing and release verification

Use Node.js 24.11.0 or later in the 24.x series, or Node.js 26.x, with npm and Git. Build the local helper before running tests. On Linux use a C compiler with Linux headers and the GNU libc development files. On macOS use Xcode Command Line Tools. An ordinary Windows build uses the in-box .NET Framework compiler. For reproducibility checks on Windows, point `PF_DOTNET_SDK` at an installed SDK directory containing Roslyn and use the same compiler version for both builds.

The macOS helper keeps the Apple linker's hash-based build UUID. The Mach-O loader needs this field, and equivalent builds can still be compared byte for byte. See [Apple's build UUID technote](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems).

```sh
npm run build:native
npm test
npm run demo
```

Use focused branches and link the relevant issue in each PR. Test new control actions against real owned fixtures and verify unrelated processes remain untouched. Tests must stop their workloads through the same identity or a fixture-specific shutdown signal.

## Local release verification

1. Check out the same revision on native Windows, macOS, and Linux x64 and ARM64 hosts for the [supported platform matrix](README.md#requirements). Run `npm run build:native`, `node scripts/reproducible.js`, and `npm test` on each host. The reproducibility check builds in a separate directory and compares bytes. Record the OS, architecture, Node.js and compiler versions, and test results.
2. Collect each generated helper alongside its `.sha256` file in `helpers/` in a clean checkout of the same revision on macOS or Linux. Preserve the execute bits on the macOS and Linux helpers. Run `node scripts/package.js --all` to verify all six checksums and create the npm tarball, its SHA-256 file, and `dist/build-metadata.json`. The unsigned metadata records the archive and helper hashes and includes the Git commit for a clean working tree.
3. Copy the same tarball and its `.sha256` file into each consumer environment. Run `node scripts/consumer.js /path/to/candidate.tgz` with the actual tarball path. This verifies the hash, offline install, interrupted installation recovery, and uninstall and reinstall while preserving a running workload. Set `PF_PREVIOUS_TARBALL` to an earlier package to exercise an upgrade.

For a host-specific development tarball, build the local helper and run `node scripts/package.js` without `--all`.

## Local integration tests

Run optional backend checks on a disposable host with the matching prerequisites.

| Test | Prerequisites and invocation |
| --- | --- |
| Linux systemd | With a running user manager, run `PF_TEST_SYSTEMD=1 node --test test/systemd.test.js`. |
| Linux CRIU | On a host that passes `criu check --no-default-config`, run `PF_TEST_CRIU=1 node --test --test-name-pattern=CRIU test/backends.test.js` with the privileges CRIU requires. |
| Linux Docker Compose | With local Docker and Compose and the `busybox:1.37` image already pulled, run `PF_TEST_DOCKER=1 node --test --test-name-pattern=Compose test/backends.test.js`. Add `PF_TEST_DOCKER_CHECKPOINT=1` for checkpoint and restore on an experimental local engine with CRIU and readable checkpoint storage. |
| macOS LaunchAgent | While signed in to a GUI session, run `PF_TEST_LAUNCHD=1 node --test test/supervisors.test.js`. |
| Windows Task Scheduler and SCM | In an elevated PowerShell session on a disposable host, set `$env:PF_TEST_WINDOWS_SUPERVISORS = '1'` and run `node --test test/supervisors.test.js`. |
| Windows interactive terminal | With Python and `pywinpty` installed, run `python -X utf8 test/terminal-windows.py`. |
