# Contributing and release verification

Use Node 24 LTS or Node 26 and Git. Build the local helper before running tests. On Linux use a C compiler with Linux headers and the GNU libc development files. On macOS use Xcode Command Line Tools. On Windows the build uses the in-box .NET Framework compiler. Consumers install a tarball with the matching helper included and run no install scripts. The Linux helper links to the host libc, and Linux compatibility follows the tested Ubuntu baseline.

```sh
npm run build:native
npm test
npm run demo
node scripts/package.js
node scripts/consumer.js
```

Use focused branches and link the relevant issue in each PR. Test new control actions against real owned fixtures and verify unrelated processes remain untouched. Tests must stop their workloads through the same identity or a fixture-specific shutdown signal.

GitHub Actions builds helpers on Linux, Windows, and macOS on x64 and arm64. Each build is repeated in an independent directory with the same toolchain, and the job compares the bytes. Windows CI uses pinned Roslyn for deterministic builds. The packaging job checks all six hashes and creates a single npm tarball. Consumer jobs verify offline install, interrupted installation recovery, and upgrade and uninstall while preserving an active workload's identity. Download `candidate-tarball` from a successful run and verify its SHA-256 file. The unsigned `build-metadata.json` records the workflow run, Git commit, and executable hashes.

The provenance job attests a consumer-verified tarball on a trusted branch run when the repository is public or the operator sets `PF_ENABLE_ATTESTATIONS=true` on an eligible private GitHub Enterprise Cloud repository. Use `gh attestation verify <archive.tgz> --repo kubilaycakmak/ProjectFreeze` to verify a signed candidate. Private repositories on other plans retain checksum and workflow metadata evidence. See [GitHub artifact attestation availability](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

Run optional backend checks on a disposable host with their real prerequisites. `PF_TEST_SYSTEMD=1` uses a running user manager and creates temporary user units. `PF_TEST_DOCKER=1` needs local Docker and the test fixture image already present. `PF_TEST_CRIU=1` needs an installed CRIU backend and the privileges CRIU requires. The hosted Linux checks provision dependencies in disposable CI runners.

Check support assumptions against the [Node release schedule](https://nodejs.org/en/about/previous-releases), [Node 24 build targets](https://github.com/nodejs/node/blob/v24.x/BUILDING.md), and the [GitHub runner matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job). Node 24 on Ubuntu 24.04, macOS 15, and Windows 11 or Server 2025 is the primary verification matrix. Node 26 is exercised on Linux and Windows x64. Treat combinations outside a passing test matrix as unverified.
