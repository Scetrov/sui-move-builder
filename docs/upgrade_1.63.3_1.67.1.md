# Upgrade 1.63.3 -> 1.67.1

## 1.1. Summary

This repository has been upgraded from the Sui 1.63.3 toolchain pin to the exact 1.67.1 framework commit recorded in [sui-version.json](/home/scetrov/source/sui-move-builder/sui-version.json):

- from version: `1.63.3`
- from commit: `04dd28d5c5d92bff685ddfecb86f8acce18ce6df`
- to version: `1.67.1`
- to commit: `4e8aa9ee8b307b294cc85baf7d08af1f432e3d93`

The core upgrade work is complete enough to produce a successful WASM build and successful JS packaging/typechecking, but the verification story is not fully closed.

The remaining blocker is behavioral verification around the `deeptrade` fixture used by the fidelity suite. That fixture does not currently provide a clean end-to-end parity signal across both:

- the in-repo WASM compiler path
- the locally installed `sui` CLI path

The two paths fail differently.

## 1.2. What Succeeded

The following upgrade steps are complete and working:

- the Sui framework/toolchain pin was updated to 1.67.1
- the build override matrix was refreshed for 1.67.1-era dependency revisions and crate versions
- the WASM build pipeline in [scripts/build-wasm.mjs](/home/scetrov/source/sui-move-builder/scripts/build-wasm.mjs) was updated to remove 1.63.3-specific assumptions
- the 1.67.1 versioned template set was introduced under [scripts/templates/v1.67.1](/home/scetrov/source/sui-move-builder/scripts/templates/v1.67.1)
- the local `sui-move-wasm` crate was ported to the current `move-unit-test` API used by newer Sui
- bytecode verification in the WASM path was narrowed to root modules only, matching upstream Sui behavior

Observed successful commands during the upgrade:

```bash
npm run build:wasm
npm run build:js
npm run typecheck
```

## 1.3. Verification Status

### 1.3.1. Passing

- `npm run build:wasm`
- `npm run build:js`
- `npm run typecheck`

### 1.3.2. Not fully closed

- `npm run test:lite`
- `npm run test:integration`

### 1.3.3. Unrelated existing repo issue

`npm run lint` still reports existing lint errors in [test/integration/transactionAnalyzer.mjs](/home/scetrov/source/sui-move-builder/test/integration/transactionAnalyzer.mjs). Those errors are not the upgrade root cause.

## 1.4. Remaining Failure

The remaining verification blocker is the `deeptrade` fixture located under:

- [test/integration/fixtures/deeptrade/packages/deeptrade-core/Move.toml](/home/scetrov/source/sui-move-builder/test/integration/fixtures/deeptrade/packages/deeptrade-core/Move.toml)
- [test/integration/fixtures/deeptrade/packages/deeptrade-core/Move.lock](/home/scetrov/source/sui-move-builder/test/integration/fixtures/deeptrade/packages/deeptrade-core/Move.lock)

This package depends on published packages such as `Pyth`, `deepbook`, `multisig`, and framework packages. In practice, the two verification paths fail at different stages:

1. The WASM compiler path fails during compilation with unresolved names and types.
2. The local `sui` CLI fails earlier, during published dependency resolution/fetch.

Because the reference CLI does not successfully build this package in the current environment, it cannot yet serve as a complete parity oracle for this fixture.

## 1.5. Exact Local CLI Version Used

The local client on `PATH` during verification was:

```bash
$ sui --version
sui 1.67.2-b020a983243c
```

This matters because the repository is pinned to framework `1.67.1`, but the installed CLI used for comparison is `1.67.2-b020a983243c`, not `1.67.1` exactly.

## 1.6. WASM Compiler Failure Example

### 1.6.1. Command

The focused reproduction used the built lite distribution and compiled the `deeptrade` fixture directly:

```bash
cd /home/scetrov/source/sui-move-builder && node --input-type=module <<'EOF'
import { promises as fs } from 'fs';
import path from 'path';
import { initMoveCompiler, buildMovePackage } from './dist/lite/index.js';

async function readLocalFiles(dir) {
  const files = {};
  async function readDirRecursive(currentDir, baseDir = currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        if (entry.name === 'build' || entry.name === '.git') continue;
        await readDirRecursive(fullPath, baseDir);
      } else if (entry.name.endsWith('.move') || entry.name.endsWith('.toml') || entry.name.endsWith('.lock')) {
        files[relativePath] = await fs.readFile(fullPath, 'utf-8');
      }
    }
  }
  await readDirRecursive(dir);
  return files;
}

const packageDir = path.resolve('test/integration/fixtures/deeptrade/packages/deeptrade-core');
const files = await readLocalFiles(packageDir);
const wasm = await fs.readFile('dist/lite/sui_move_wasm_bg.wasm');
await initMoveCompiler({ wasm });
const result = await buildMovePackage({ files, network: 'mainnet' });
if ('error' in result) {
  console.log(result.error);
  process.exit(1);
}
console.log(JSON.stringify({ modules: result.modules.length, dependencies: result.dependencies.length }, null, 2));
EOF
```

### 1.6.2. Observed Failure

Representative output from the current WASM compiler failure:

```text
error[E03006]: unexpected name in this position
   ┌─ sources/swap.move:56:16
   │
56 │     pool: &mut Pool<BaseToken, QuoteToken>,
   │                ^^^^
   │                │
   │                Could not resolve the name 'Pool'
   │                Did you mean: 'ID'

error[E03006]: unexpected name in this position
   ┌─ sources/swap.move:57:14
   │
57 │     base_in: Coin<BaseToken>,
   │              ^^^^
   │              │
   │              Could not resolve the name 'Coin'
   │              Did you mean: 'ID'

error[E03004]: unbound type
   ┌─ sources/swap.move:60:13
   │
60 │     clock: &Clock,
   │             ^^^^^ Unbound type 'Clock' in current scope

error[E04010]: cannot infer type
   ┌─ sources/swap.move:68:37
   │
68 │     let (base_remainder, quote_out, deep_remainder) = pool.swap_exact_quantity(
   │                                     ^^^^^^^^^^^^^^ Could not infer this type. Try adding an annotation

error[E03006]: unexpected name in this position
   ┌─ sources/swap.move:70:9
   │
70 │         coin::zero(ctx),
   │         ^^^^
   │         │
   │         Could not resolve the name 'coin'
   │         Did you mean: 'ID'

error[E03006]: unexpected name in this position
   ┌─ sources/swap.move:93:5
   │
93 │     event::emit(SwapExecuted<BaseToken, QuoteToken> {
   │     ^^^^^ Could not resolve the name 'event'
```

### 1.6.3. Interpretation

This failure mode is a compile-time failure in the WASM compiler path. The pattern is consistent with dependency/framework symbols not being fully resolved into the package's compile environment for this fixture. The unresolved names are not arbitrary user symbols; they include fundamental framework/dependency surfaces such as:

- `Pool`
- `Coin`
- `Clock`
- `coin`
- `event`

That strongly suggests an environment/dependency-address resolution issue for this package shape, rather than a simple syntax regression in the fixture itself.

## 1.7. Exact `sui` Client Failure Example

### 1.7.1. Command

The exact local CLI reproduction was:

```bash
cd /home/scetrov/source/sui-move-builder/test/integration/fixtures/deeptrade/packages/deeptrade-core && \
  sui move build --dump-bytecode-as-base64 -e mainnet
```

### 1.7.2. Observed Failure

```text
INCLUDING DEPENDENCY MoveStdlib
INCLUDING DEPENDENCY Pyth
INCLUDING DEPENDENCY Sui
INCLUDING DEPENDENCY Wormhole
INCLUDING DEPENDENCY deepbook
INCLUDING DEPENDENCY multisig
INCLUDING DEPENDENCY token
BUILDING deeptrade_core
Failed to fetch package Pyth

Caused by:
    Object 0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91 not found
```

### 1.7.3. Interpretation

The reference CLI does not reach bytecode compilation for this package in the current environment. It fails earlier while resolving a published dependency object for `Pyth` on `mainnet`.

This is important for the upgrade narrative because it means:

- the local CLI is not currently a clean oracle for expected output on this fixture
- a direct WASM-vs-CLI bytecode comparison cannot be completed until the CLI path itself is made reproducible

## 1.8. Why This Is the Remaining Verification Blocker

At this point there are two separate problems for `deeptrade`:

1. The in-repo WASM compiler fails during compilation with unresolved dependency/framework symbols.
2. The local `sui` CLI fails before compilation because a published dependency object cannot be fetched.

Those failures do not line up at the same stage, so they do not yet provide a like-for-like parity comparison.

As a result, the upgrade cannot honestly be called behaviorally verified end-to-end for this fixture, even though the rest of the upgrade work is already in place and the main build products are green.

## 1.9. Additional Notes From the Investigation

- The fidelity harness originally allowed `sui move build` to rewrite fixture `Move.lock` files in place. That made repeated runs non-deterministic.
- The harness was updated in [test/integration/fidelity_test.mjs](/home/scetrov/source/sui-move-builder/test/integration/fidelity_test.mjs) to restore `Move.lock` after the CLI dump step.
- Even with that stabilization, the `deeptrade` fixture remains the unresolved verification gap.

## 1.10. Recommended Next Investigation Steps

1. Make the reference CLI build reproducible for `deeptrade`.

   Options include:
   - providing the required published package state for `Pyth`
   - using a compatible ephemeral publication file or environment setup
   - validating whether the fixture still builds cleanly with a known-good Sui client/environment combination

2. Trace dependency address materialization in the WASM path for this fixture.

   The most likely areas are:
   - V3 lockfile migration/load behavior in [src/resolver.ts](/home/scetrov/source/sui-move-builder/src/resolver.ts)
   - dependency grouping/address mapping in [src/compilationDependencies.ts](/home/scetrov/source/sui-move-builder/src/compilationDependencies.ts)
   - compile environment construction in [sui-move-wasm/src/lib.rs](/home/scetrov/source/sui-move-builder/sui-move-wasm/src/lib.rs)

3. Re-run the fidelity comparison only after both sides reach the same stage.

   The ideal target is:
   - CLI successfully produces dumped bytecode
   - WASM successfully compiles the same fixture
   - bytecode, dependency IDs, and generated lockfile can then be compared directly
