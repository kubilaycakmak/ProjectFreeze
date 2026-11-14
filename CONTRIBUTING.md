# Contributing and release verification

Use Node 24 LTS or Node 26 and Git. Build the local helper before running tests. On Linux use a C compiler with Linux headers and static libc development files. On macOS use Xcode Command Line Tools. On Windows the build uses the in-box .NET Framework compiler. Consumers install a tarball with the matching helper included and run no install scripts.

```sh
npm run build:native
npm test
npm run demo
node scripts/package.js
node scripts/consumer.js
```

Use focused branches and link the relevant issue in each PR. Test new control actions against real owned fixtures and verify unrelated processes remain untouched. Tests must stop their workloads through the same identity or a fixture-specific shutdown signal.

GitHub Actions builds helpers on Linux, Windows, and macOS on x64 and arm64. The packaging job checks all six hashes and creates a single npm tarball. Consumer jobs install that exact tarball offline and verify the daemon and retained metadata on uninstall. Download `candidate-tarball` from a successful run and verify its SHA-256 file before distribution. The CI artifact is tied to its workflow run and Git commit. Release artifacts require verification of binary reproducibility and provenance before public distribution.

Check support assumptions against the [Node release schedule](https://nodejs.org/en/about/previous-releases), [Node 24 build targets](https://github.com/nodejs/node/blob/v24.x/BUILDING.md), and the [GitHub runner matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job). Node 24 on Ubuntu 24.04, macOS 15, and Windows 11 or Server 2025 is the primary verification matrix. Node 26 is exercised on Linux and Windows x64. Treat combinations outside a passing test matrix as unverified.
