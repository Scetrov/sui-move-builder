# DeepBook Failures During Sui 1.67.1 Upgrade

## Scope

This note documents the DeepBook-related failures observed while validating the repository's Sui 1.67.1 upgrade work.

The key requirement for this investigation was to compare against the exact Rust Sui version, not the locally installed `sui` binary on `PATH`.

## Exact Version Used

The exact 1.67.1 upgrade state analyzed was the historical repo commit:

- `230014d9ca50e7199b41b8f6d69a54263762da0e` (`Upgrade Sui toolchain to 1.67.1`)

That commit pins:

- Sui version: `1.67.1`
- Sui commit: `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93`
- tag field: `framework/mainnet`

To avoid accidentally comparing against the wrong binary, the Rust baseline was built from a clean upstream checkout at exactly:

- `/home/scetrov/source/sui-4e8aa9ee-clean`
- `cargo run --locked -q --manifest-path crates/sui/Cargo.toml -- --version`
- observed version: `sui 1.67.1-4e8aa9ee8b30`

This matters because the machine-local `sui` on `PATH` is currently `1.68.0-16bf4d124ac5`, which is not a valid parity baseline for this task.

## Summary

DeepBook is not currently behaviorally verified against exact Sui 1.67.1.

There are three separate failure layers:

1. The historical `1.67.1` repo state no longer builds its wasm compiler cleanly in a fresh environment.
2. The exact Rust CLI at `4e8aa9ee...` does not reach bytecode output for DeepBook in this environment.
3. The DeepBook fixture carries stale lockfile state, so the JS resolver and the Rust CLI are not naturally operating on a clean 1.67.1 dependency graph.

## Failure 1: Historical 1.67.1 Wasm Build Is Blocked Before DeepBook

In a clean worktree at commit `230014d`, `npm ci` succeeds and `npm run build:js` succeeds.

However, `npm run build:wasm` now fails before any DeepBook-specific compile step:

```text
error: failed to select a version for the requirement `core2 = "^0.4.0"`
  version 0.4.0 is yanked
location searched: crates.io index
required by package `multihash v0.17.0`
    ... which satisfies dependency `multihash = "^0.17"` of package `multiaddr v0.17.0`
    ... which satisfies dependency `multiaddr = "^0.17.0"` of package `sui-proxy v0.0.2`
```

Interpretation:

- this is not a DeepBook semantic failure
- it blocks end-to-end repro of the wasm path from the original 1.67.1 upgrade commit in a fresh environment
- any DeepBook parity statement must therefore rely on a mix of JS-level resolution analysis and the exact Rust CLI

## Failure 2: Exact 1.67.1 Rust CLI Does Not Produce DeepBook Bytecode Output

The exact Rust CLI baseline was run directly on:

- `/home/scetrov/source/deepbookv3-d3206b71/packages/deepbook`
- DeepBook commit: `d3206b717c6f63593fae14d1ff9e1ec055f051bd`

### First exact CLI reproduction

Command:

```bash
/home/scetrov/source/sui-4e8aa9ee-clean/target/debug/sui move build --dump-bytecode-as-base64 -e mainnet
```

Observed failure:

```text
Downloading from https://github.com/MystenLabs/sui.git
Downloading from https://github.com/MystenLabs/deepbookv3.git
INCLUDING DEPENDENCY MoveStdlib
INCLUDING DEPENDENCY Sui
INCLUDING DEPENDENCY token
BUILDING deepbook
Failed to fetch package MoveStdlib

Caused by:
    tcp connect error
```

Interpretation:

- this is a transport/reproducibility failure, not yet a compile failure
- the exact 1.67.1 CLI does not provide bytecode output for comparison in the default environment

### Second exact CLI reproduction with local git remapping

To eliminate network transport noise, the same exact CLI was run under a temporary `HOME` with a `.gitconfig` that rewrote:

- `https://github.com/MystenLabs/sui.git`
- `https://github.com/MystenLabs/deepbookv3.git`

to local clones.

That run progressed further, then failed deterministically:

```text
INCLUDING DEPENDENCY MoveStdlib
INCLUDING DEPENDENCY Sui
INCLUDING DEPENDENCY token
BUILDING deepbook
Failed to fetch package token

Caused by:
    Object 0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270 not found
```

Interpretation:

- once git transport noise is removed, the exact 1.67.1 CLI still fails before compilation
- the failure is now tied to published-package resolution for `token`, not to downloading source code

## Failure 3: DeepBook Is Not Actually On A Clean 1.67.1 Graph When Locks Are Honored

The root DeepBook package manifest is simple:

```toml
[package]
name = "deepbook"
edition = "2024.beta"
version = "0.0.1"

[dependencies]
token = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/token", rev = "main"}

[addresses]
deepbook = "0x0"
```

But the checked-in `packages/deepbook/Move.lock` is version 4 and pins:

- `MoveStdlib` to Sui rev `22f9fc9781732d651e18384c9a8eb1dabddf73a6`
- `Sui` to Sui rev `22f9fc9781732d651e18384c9a8eb1dabddf73a6`
- `token` to DeepBook rev `5e82e2dd1ea7d47957855ddc66f835585d6fe091`

Those are not the exact 1.67.1 repo pin `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93`.

So there are two materially different dependency graphs in play.

### Resolver result with the checked-in DeepBook lockfile present

Using this project's JS resolver on the exact DeepBook fixture, with `Move.lock` preserved, produces:

- `MoveStdlib` at `22f9fc9781732d651e18384c9a8eb1dabddf73a6`
- `Sui` at `22f9fc9781732d651e18384c9a8eb1dabddf73a6`
- `token` at `5e82e2dd1ea7d47957855ddc66f835585d6fe091`

Interpretation:

- the resolver is respecting the existing DeepBook lockfile
- that means the fixture is still effectively rooted in older framework state rather than the repo's intended 1.67.1 pin

### Resolver result with the root DeepBook lockfile removed

Running the same resolver with only the root `Move.lock` deleted produces:

- `MoveStdlib` at `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93`
- `Sui` at `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93`
- `token` at `0a58db9702bf963c912af5e3d1544ae56aaed0eb`

Interpretation:

- the root package can be steered onto the exact 1.67.1 framework commit
- but that is not the same graph as the checked-in DeepBook fixture
- any comparison that leaves the root lock in place is not actually testing DeepBook on the exact 1.67.1 framework revision

## Failure 4: Nested Token Metadata Still Pulls In Stale Published State

The nested package `/home/scetrov/source/deepbookv3-d3206b71/packages/token/Move.lock` is version 3 and contains:

- `original-published-id = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270"`
- `latest-published-id = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270"`

That object ID exactly matches the deterministic exact-CLI failure:

```text
Failed to fetch package token

Caused by:
    Object 0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270 not found
```

Interpretation:

- even after removing the root DeepBook lock, nested package metadata still carries published state from an older package history
- exact Sui 1.67.1 therefore still attempts to resolve published package state that is not reproducible in this environment

## What This Means

The current DeepBook verification problem is not a single compiler bug.

It is a stack of issues:

1. the original 1.67.1 wasm build is currently blocked by unrelated Cargo ecosystem drift
2. the exact 1.67.1 Rust CLI cannot produce DeepBook bytecode in this environment because package resolution fails first
3. the checked-in DeepBook fixture is not a clean 1.67.1 fixture because its lockfiles anchor older framework and published-package state

Because of that, the project does not currently have a trustworthy DeepBook parity signal against exact Sui 1.67.1.

## Most Defensible Root Cause Statement

The DeepBook failure is primarily a fixture and reproducibility problem, not yet a proven wasm compiler regression.

More specifically:

- the root DeepBook fixture lockfile pins non-1.67.1 framework revisions
- the nested `token` package carries published object metadata that exact Sui 1.67.1 tries to resolve
- that published object is not available in the current environment
- therefore the exact Rust CLI fails before compilation, which prevents bytecode-level parity comparison

## Recommended Next Steps

1. Regenerate the DeepBook fixture from a clean exact-1.67.1 baseline.

   Minimum scope:

   - remove or regenerate `packages/deepbook/Move.lock`
   - remove or regenerate `packages/token/Move.lock`
   - verify the regenerated graph uses `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93` for framework packages

2. Re-run the exact Rust CLI first, before touching the wasm path.

   Success criterion:

   - `sui 1.67.1-4e8aa9ee8b30` must produce DeepBook bytecode output rather than a fetch failure

3. Only after the exact Rust CLI succeeds, compare this project's output to that exact CLI output.

   Until then, any DeepBook mismatch is ambiguous because the reference build never reaches compilation.