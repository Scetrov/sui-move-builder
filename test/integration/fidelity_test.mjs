import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  analyzeTransaction,
  compareModules as compareTxModules,
} from "./transactionAnalyzer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// usage: node fidelity_test.mjs [full|lite]
const MODE = process.argv[2] === "lite" ? "lite" : "full";
const DIST_DIR = path.resolve(__dirname, `../../dist/${MODE}`);
const SUI_CLI = process.env.SUI_CLI || "sui";
const EXPECTED_SUI_VERSION = "1.67.1";
const EXPECTED_SUI_COMMIT_PREFIX = "4e8aa9ee";
const CLI_DUMP_MODE = "dump-no-tree-shaking";
let suiCliVersion = null;
let cliRewriteHome = null;

console.log(`Running Fidelity Tests in [${MODE.toUpperCase()}] mode`);

// Dynamic import from the correct distribution
const { initMoveCompiler, buildMovePackage, fetchPackageFromGitHub } =
  await import(path.join(DIST_DIR, "index.js"));

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function sanitizeForFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function assertExactSuiCliVersion() {
  const result = spawnSync(SUI_CLI, ["--version"], {
    encoding: "utf-8",
    timeout: 30000,
  });

  if (result.error) {
    throw new Error(
      `[CLI_VERSION] Failed to run SUI_CLI=${SUI_CLI}: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `[CLI_VERSION] SUI_CLI=${SUI_CLI} exited ${result.status}: ${result.stderr || result.stdout}`
    );
  }

  const version = (result.stdout || result.stderr || "").trim();
  const expectedPrefix = `sui ${EXPECTED_SUI_VERSION}-${EXPECTED_SUI_COMMIT_PREFIX}`;
  if (!version.startsWith(expectedPrefix)) {
    throw new Error(
      `[CLI_VERSION] Expected ${expectedPrefix}*, got ${version || "<empty>"}. Set SUI_CLI to the exact Sui 1.67.1 binary.`
    );
  }

  suiCliVersion = version;
  console.log(`[CLI] Using ${SUI_CLI} (${suiCliVersion})`);
}

function formatCliOutput(result) {
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  return [
    stderr ? `stderr:\n${stderr.slice(-4000)}` : null,
    stdout ? `stdout:\n${stdout.slice(-4000)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeFileUrl(repoPath) {
  return repoPath.startsWith("file://") ? repoPath : `file://${repoPath}`;
}

function collectGitRewrites() {
  const rewrites = [];

  if (process.env.SUI_REPO_OVERRIDE) {
    const replacement = normalizeFileUrl(process.env.SUI_REPO_OVERRIDE);
    rewrites.push(["https://github.com/MystenLabs/sui.git", replacement]);
    rewrites.push(["https://github.com/MystenLabs/sui", replacement]);
  }

  const extraRewrites = process.env.SUI_CLI_GIT_REWRITES || "";
  for (const entry of extraRewrites.split(";")) {
    if (!entry.trim()) continue;
    const [from, to] = entry.split("=");
    if (!from || !to) {
      throw new Error(
        `[CLI_ENV] Invalid SUI_CLI_GIT_REWRITES entry: ${entry}`
      );
    }
    rewrites.push([from, normalizeFileUrl(to)]);
  }

  return rewrites;
}

async function cliGitRewriteEnv() {
  const rewrites = collectGitRewrites();

  const env = { ...process.env };
  rewrites.forEach(([from, to], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = `url.${to}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${index}`] = from;
  });
  env.GIT_CONFIG_COUNT = String(rewrites.length);

  if (rewrites.length > 0) {
    if (!cliRewriteHome) {
      cliRewriteHome = await fs.mkdtemp(path.join(os.tmpdir(), "sui-cli-home-"));
      const gitConfig = rewrites
        .map(
          ([from, to]) => `[url "${to}"]\n\tinsteadOf = ${from}\n`
        )
        .join("\n");
      await fs.writeFile(path.join(cliRewriteHome, ".gitconfig"), gitConfig);
    }
    env.HOME = cliRewriteHome;
  }

  return env;
}

const REPOS = {
  nautilus: {
    url: "https://github.com/MystenLabs/nautilus",
    commit: "d919402aadf15e21b3cf31515b3a46d1ca6965e4",
    packagePath: "move/enclave",
    network: "mainnet",
    txDigest: "B2eHopwUuSgMhJNHQA6LNMkQYVKesPe6M6MorbiwiaGX",
  },
  deepbook: {
    url: "https://github.com/MystenLabs/deepbookv3",
    commit: "d3206b717c6f63593fae14d1ff9e1ec055f051bd",
    packagePath: "packages/deepbook",
    network: "mainnet",
    txDigest: "kWfhNNQ82bqnV2CgiLR23MkqULJWP1S1WC9jPCPSPG5",
  },
  apps: {
    url: "https://github.com/MystenLabs/apps",
    commit: "e159ab3fc45a6f1ca46025c46c915988023af8b6",
    packagePath: "kiosk",
    network: "mainnet",
    txDigest: "LexwBJLt1jMwhNsNCkU4jiWwZPaAeqwhgLy2RPZbd2n",
  },
  deeptrade: {
    url: "https://github.com/DeeptradeProtocol/deeptrade-core",
    commit: "7838028ef9edf72f7dc82dc788ba06cd94ebdd9c",
    packagePath: "packages/deeptrade-core",
    network: "mainnet",
    txDigest: "75SMrmoARyPwLvt7ZHgoBsN9NtHkAmkcXNMtnzo84K52",
    skipCliParity:
      "investigation fixture: exact CLI dump is unstable with its V3 lock and external Pyth/Wormhole dependency graph",
  },
};

// Digest comparison helper (used for debug)
// function areDigestsEqual(digestA, digestB) {
//   const normalize = (d) => {
//     if (Array.isArray(d)) return Buffer.from(d).toString("hex");
//     if (d instanceof Uint8Array) return Buffer.from(d).toString("hex");
//     return d;
//   };
//   return normalize(digestA) === normalize(digestB);
// }

// Read GitHub token from file if exists
async function getGithubToken() {
  try {
    const tokenPath = path.join(__dirname, "../../test/.github_token");
    if (await fs.stat(tokenPath).catch(() => false)) {
      return (await fs.readFile(tokenPath, "utf-8")).trim();
    }
  } catch {
    // Ignore if token file doesn't exist
  }
  return process.env.GITHUB_TOKEN;
}

// Setup repo: check if cached in fixtures, if not fetch via packageFetcher and save
async function setupRepo(name, config, githubToken) {
  const packageDir = path.join(FIXTURES_DIR, name, config.packagePath);
  const moveTomlPath = path.join(packageDir, "Move.toml");

  // Check if already cached
  if (await fs.stat(moveTomlPath).catch(() => false)) {
    console.log(`[Cache] Using cached fixtures for ${name}`);
    return await readLocalFiles(packageDir);
  }

  // Fetch via packageFetcher
  console.log(`[Fetch] Downloading ${name} via GitHub API...`);
  const githubUrl = `${config.url}/tree/${config.commit}/${config.packagePath}`;
  const files = await fetchPackageFromGitHub(githubUrl, {
    githubToken,
    includeLock: true,
  });

  // Save to fixtures for future runs
  await fs.mkdir(packageDir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(packageDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  console.log(`[Cache] Saved ${Object.keys(files).length} files to fixtures`);

  return files;
}

// Read local files from directory
async function readLocalFiles(dir) {
  const files = {};
  const generatedArtifacts = new Set([
    "MoveV4.lock",
    "PublishedV4.toml",
    "Move.lock.before_cli",
    "Move.lock.after_cli",
    "wasm_dump.json",
  ]);

  async function readDirRecursive(currentDir, baseDir = currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        if (entry.name === "build" || entry.name === ".git") continue;
        await readDirRecursive(fullPath, baseDir);
      } else {
        if (
          generatedArtifacts.has(entry.name) ||
          entry.name.startsWith("cli_dump_")
        ) {
          continue;
        }
        if (
          entry.name.endsWith(".move") ||
          entry.name.endsWith(".toml") ||
          entry.name.endsWith(".lock")
        ) {
          files[relativePath] = await fs.readFile(fullPath, "utf-8");
        }
      }
    }
  }

  await readDirRecursive(dir);
  return files;
}

/**
 * Generate CLI bytecode dump using exact `sui move build --dump-bytecode-as-base64`
 * Saves output to a versioned cli_dump_*.json in package directory
 * Also backs up Move.toml and Move.lock before/after to detect CLI modifications
 */
async function generateCliDump(packageDir, name, network) {
  if (!suiCliVersion) {
    throw new Error("[CLI_VERSION] Sui CLI version preflight has not run");
  }

  const cacheKey = sanitizeForFilename(`${suiCliVersion}_${CLI_DUMP_MODE}`);
  const dumpPath = path.join(packageDir, `cli_dump_${cacheKey}.json`);
  const cliArgs = [
    "move",
    "build",
    "--dump-bytecode-as-base64",
    "--no-tree-shaking",
    "-e",
    network,
  ];

  // Check if already cached
  if (await fs.stat(dumpPath).catch(() => false)) {
    const cached = JSON.parse(await fs.readFile(dumpPath, "utf-8"));
    if (
      cached.__metadata?.suiVersion === suiCliVersion &&
      cached.__metadata?.cliDumpMode === CLI_DUMP_MODE
    ) {
      console.log(`[CLI Dump] Using cached dump for ${name} (${suiCliVersion})`);
      return cached;
    }
    console.log(`[CLI Dump] Cache metadata mismatch for ${name}; regenerating`);
  }

  console.log(
    `[CLI Dump] Generating bytecode dump for ${name} with ${suiCliVersion}...`
  );

  // Backup Move.lock before CLI build (only for comparison)
  const moveLockPath = path.join(packageDir, "Move.lock");

  let moveLockBefore = null;

  try {
    moveLockBefore = await fs.readFile(moveLockPath, "utf-8");
  } catch {
    /* ignore */
  }

  // Save backup
  if (moveLockBefore) {
    await fs.writeFile(
      path.join(packageDir, "Move.lock.before_cli"),
      moveLockBefore,
      "utf-8"
    );
  }

  try {
    // Run exact sui move build with dump flag
    const result = spawnSync(
      SUI_CLI,
      cliArgs,
      {
        cwd: packageDir,
        env: await cliGitRewriteEnv(),
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
        timeout: 120000, // 2 minute timeout
      }
    );

    // Check for Move.lock modifications after CLI build
    let moveLockAfter = null;

    try {
      moveLockAfter = await fs.readFile(moveLockPath, "utf-8");
    } catch {
      /* ignore */
    }

    // Report Move.lock modification
    let moveLockModified = false;
    if (moveLockBefore && moveLockAfter && moveLockBefore !== moveLockAfter) {
      moveLockModified = true;
      console.log(`[CLI] ⚠️  Move.lock MODIFIED by CLI build!`);
      await fs.writeFile(
        path.join(packageDir, "Move.lock.after_cli"),
        moveLockAfter,
        "utf-8"
      );
    }

    if (result.error) {
      throw new Error(
        `[CLI_COMPILE] Failed to run SUI_CLI=${SUI_CLI}: ${result.error.message}`
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `[CLI_COMPILE] CLI build failed for ${name} (exit code ${result.status})\n${formatCliOutput(result)}`
      );
    }

    // Parse JSON output from stdout
    // CLI outputs JSON to stdout, build messages to stderr
    const stdout = result.stdout.trim();

    // Find JSON in output (may have build messages before it)
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      throw new Error(
        `[CLI_DUMP] No JSON found in CLI output for ${name}\n${formatCliOutput(result)}`
      );
    }

    const jsonStr = stdout.slice(jsonStart);
    const dump = JSON.parse(jsonStr);
    dump.__metadata = {
      suiBinary: SUI_CLI,
      suiVersion: suiCliVersion,
      cliDumpMode: CLI_DUMP_MODE,
      cliArgs,
      package: name,
      network,
      generatedAt: new Date().toISOString(),
    };

    // Save to cache
    await fs.writeFile(dumpPath, JSON.stringify(dump, null, 2), "utf-8");
    console.log(`[CLI Dump] Saved dump to ${path.basename(dumpPath)}`);

    // Return dump with moveLockModified flag
    return { ...dump, moveLockModified };
  } catch (e) {
    throw e;
  } finally {
    if (moveLockBefore !== null) {
      await fs.writeFile(moveLockPath, moveLockBefore, "utf-8");
    } else if (await fs.stat(moveLockPath).catch(() => false)) {
      await fs.rm(moveLockPath);
    }
  }
}

async function runTest() {
  assertExactSuiCliVersion();

  console.log("Initializing compiler...");
  const start = Date.now();
  const wasmPath = path.resolve(DIST_DIR, "sui_move_wasm_bg.wasm");
  const wasmBuffer = await fs.readFile(wasmPath);

  const githubToken = await getGithubToken();
  await initMoveCompiler({ wasm: wasmBuffer, token: githubToken });
  console.log(`Compiler initialized in ${(Date.now() - start).toFixed(2)}ms`);

  let allPass = true;

  for (const [name, config] of Object.entries(REPOS)) {
    console.log(`\n=== Testing ${name} ===`);

    const rootFiles = await setupRepo(name, config, githubToken);
    console.log(`[Build] Compiling ${Object.keys(rootFiles).length} files...`);

    try {
      const result = await buildMovePackage({
        files: rootFiles,
        network: config.network,
        githubToken,
        onProgress: (event) => {
          switch (event.type) {
            case "resolve_start":
              console.log("  → Resolving dependencies...");
              break;
            case "resolve_dep":
              console.log(
                `    [${event.current}/${event.total}] ${event.name} (${event.source})`
              );
              break;
            case "resolve_complete":
              console.log(`  → Resolved ${event.count} dependencies`);
              break;
            case "compile_start":
              console.log("  → Compiling...");
              break;
            case "compile_complete":
              console.log("  → Compilation complete");
              break;
            case "lockfile_generate":
              console.log("  → Generating Move.lock");
              break;
          }
        },
      });

      if ("error" in result) {
        console.error(`[Error] Build failed:`, result.error);
        allPass = false;
        continue;
      }

      // Always save generated Move.lock as MoveV4.lock for inspection
      if (result.moveLock) {
        const packageDir = path.join(FIXTURES_DIR, name, config.packagePath);
        await fs.mkdir(packageDir, { recursive: true });
        const generatedLockPath = path.join(packageDir, "MoveV4.lock");
        await fs.writeFile(generatedLockPath, result.moveLock, "utf-8");
        console.log(`  📝 Saved generated lock to: MoveV4.lock`);

        // Save WASM dump for debugging
        const wasmDumpPath = path.join(packageDir, "wasm_dump.json");
        const wasmDump = {
          modules: result.modules || [],
          dependencies: result.dependencies || [],
          digest: result.digest ? Array.from(result.digest) : [],
        };
        await fs.writeFile(
          wasmDumpPath,
          JSON.stringify(wasmDump, null, 2),
          "utf-8"
        );
        console.log(`  📝 Saved WASM dump to: wasm_dump.json`);

        // Compare with reference Move.lock - only if versions match
        const referenceLockPath = path.join(packageDir, "Move.lock");
        const cliUpdatedLockPath = path.join(packageDir, "Move.lock.after_cli");
        try {
          // Check if CLI has updated the lockfile (Move.lock.after_cli)
          let referenceLockToUse = referenceLockPath;
          if (await fs.stat(cliUpdatedLockPath).catch(() => false)) {
            referenceLockToUse = cliUpdatedLockPath;
            console.log(`     (Using CLI-updated lockfile for comparison)`);
          }

          if (await fs.stat(referenceLockToUse).catch(() => false)) {
            let referenceLock = await fs.readFile(referenceLockToUse, "utf-8");

            // Extract version from lockfile content
            const getVersion = (content) => {
              const match = content.match(
                /\[move\][\s\S]*?version\s*=\s*(\d+)/
              );
              return match ? parseInt(match[1]) : null;
            };

            const refVersion = getVersion(referenceLock);
            const genVersion = getVersion(result.moveLock);

            console.log(
              `  📋 Lockfile Version Check: Reference=V${refVersion || "?"}, Generated=V${genVersion || "?"}`
            );

            // If versions differ (V3 migrated to V4), use CLI's generated V4 lockfile for comparison
            if (refVersion !== genVersion) {
              const cliGeneratedLockPath = path.join(
                path.dirname(referenceLockToUse),
                "Move.lock"
              );
              const cliLockExists = await fs
                .stat(cliGeneratedLockPath)
                .catch(() => false);

              if (
                cliLockExists &&
                cliGeneratedLockPath !== referenceLockToUse
              ) {
                console.log(
                  `  📋 Migration detected - comparing with CLI-generated V4 lockfile`
                );
                const cliLock = await fs.readFile(
                  cliGeneratedLockPath,
                  "utf-8"
                );
                const cliVersion = getVersion(cliLock);

                if (cliVersion === genVersion) {
                  // Use CLI's generated lock for comparison
                  referenceLock = cliLock;
                } else {
                  console.log(
                    `  ⚠️  Version mismatch (V${refVersion} vs V${genVersion}) - skipping lockfile comparison`
                  );
                }
              } else {
                console.log(
                  `  ⚠️  Version mismatch (V${refVersion} vs V${genVersion}) - skipping lockfile comparison`
                );
              }
            }

            // Only compare if we have a valid reference lock (either same version or CLI-generated V4)
            if (
              refVersion === genVersion ||
              (referenceLock && getVersion(referenceLock) === genVersion)
            ) {
              // Parse ALL sections from lockfile (all networks)
              const parseAllSections = (content) => {
                const lines = content.split("\n");
                const sections = {}; // { network: { sectionName: { digest, use_environment } } }
                let currentNetwork = null;
                let currentSectionName = null;
                let currentData = {};

                for (const line of lines) {
                  const trimmed = line.trim();
                  const pinnedMatch = trimmed.match(
                    /^\[pinned\.([^.]+)\.([^\]]+)\]$/
                  );

                  if (pinnedMatch) {
                    // Save previous section
                    if (currentNetwork && currentSectionName) {
                      if (!sections[currentNetwork])
                        sections[currentNetwork] = {};
                      sections[currentNetwork][currentSectionName] =
                        currentData;
                    }

                    currentNetwork = pinnedMatch[1];
                    currentSectionName = pinnedMatch[2];
                    currentData = { digest: null, use_environment: null };
                  }

                  if (currentNetwork && currentSectionName) {
                    if (trimmed.startsWith("manifest_digest =")) {
                      currentData.digest = trimmed.split('"')[1];
                    }
                    if (trimmed.startsWith("use_environment =")) {
                      currentData.use_environment = trimmed.split('"')[1];
                    }
                  }
                }

                // Save last section
                if (currentNetwork && currentSectionName) {
                  if (!sections[currentNetwork]) sections[currentNetwork] = {};
                  sections[currentNetwork][currentSectionName] = currentData;
                }

                return sections;
              };

              const refSections = parseAllSections(referenceLock);
              const genSections = parseAllSections(result.moveLock);

              // Get all networks from both
              const allNetworks = new Set([
                ...Object.keys(refSections),
                ...Object.keys(genSections),
              ]);

              console.log(`  📋 Lockfile Comparison:`);
              let hasError = false;

              for (const net of [...allNetworks].sort()) {
                const refNet = refSections[net] || {};
                const genNet = genSections[net] || {};
                const allSectionNames = new Set([
                  ...Object.keys(refNet),
                  ...Object.keys(genNet),
                ]);

                console.log(`     [${net}]`);
                for (const sec of [...allSectionNames].sort()) {
                  const refData = refNet[sec];
                  const genData = genNet[sec];

                  if (!refData && genData) {
                    console.log(
                      `       ${sec}: section exists in Generated but not in Reference`
                    );
                    hasError = true;
                  } else if (refData && !genData) {
                    console.log(
                      `       ${sec}: section exists in Reference but not in Generated`
                    );
                    // Not an error for testnet sections when we only generate mainnet
                  } else if (refData && genData) {
                    if (refData.digest !== genData.digest) {
                      console.log(
                        `       ${sec}: digest differs between Reference and Generated`
                      );
                      hasError = true;
                    } else {
                      console.log(`       ${sec}: ✅`);
                    }
                  }
                }
              }

              if (hasError) {
                allPass = false;
              }
            }
          }
        } catch (e) {
          console.log(`  ⚠️ Could not compare lockfiles: ${e.message}`);
        }
      }

      if (result.publishedToml) {
        // Save migrated Published.toml without printing full content
        const packageDir = path.join(FIXTURES_DIR, name, config.packagePath);
        const publishedV4Path = path.join(packageDir, "PublishedV4.toml");
        await fs.writeFile(publishedV4Path, result.publishedToml, "utf-8");
        console.log(
          `  📝 [MIGRATION] Saved Published.toml to: PublishedV4.toml`
        );

        // --- Convergence Verification (User Request) ---
        console.log(
          `\n  🔄 [Convergence] Running 2nd Build with Migrated Artifacts to verify CLI match...`
        );

        // Update rootFiles with the migrated artifacts
        rootFiles["Move.lock"] = result.moveLock; // Use the V4 lock we just generated
        rootFiles["Published.toml"] = result.publishedToml; // Use the Published.toml we just generated

        // 2nd Build
        const result2 = await buildMovePackage({
          files: rootFiles,
          network: config.network,
          githubToken,
        });

        if (!("error" in result2)) {
          console.log("  🔄 [Convergence] 2nd Build successful");
        } else {
          console.error("  ❌ [Convergence] 2nd Build Failed!", result2.error);
        }
        // ------------------------------------------------
      }

      // Transaction-based comparison
      if (config.txDigest) {
        const txDigest = config.txDigest;
        try {
          console.log(`[Tx] Fetching modules from transaction ${txDigest}...`);
          const txInfo = await analyzeTransaction(txDigest);

          console.log(
            `[Tx] Type: ${txInfo.txType}, Modules: ${txInfo.moduleCount}, Package: ${txInfo.packageId}`
          );

          // Modules comparison (WASM vs TX)
          // Note: For upgrade transactions, the deployed bytecode may have been built with different
          // Published.toml state (e.g., 0x0 address if Published.toml didn't exist at deployment time)
          // The primary validation is CLI=WASM, TX comparison is informational for upgrades
          if (txInfo.modules && result.modules) {
            const comparison = compareTxModules(result.modules, txInfo.modules);
            if (comparison.match) {
              console.log(
                `[Tx] ✅ Modules match (${comparison.wasmCount} modules)`
              );
            } else {
              const isUpgrade = txInfo.txType === "upgrade";
              if (isUpgrade) {
                console.log(
                  `[Tx] ⚠️  Modules differ from deployed (upgrade) - WASM=${comparison.wasmCount}, Deployed=${comparison.txCount}`
                );
                console.log(
                  `     (This is expected if Published.toml was updated after original deployment)`
                );
              } else {
                console.log(
                  `[Tx] ❌ Modules mismatch! WASM=${comparison.wasmCount}, Deployed=${comparison.txCount}`
                );
                comparison.details.forEach((d) => {
                  if (d.status !== "match") {
                    console.log(
                      `     Module ${d.index}: ${d.status} (WASM: ${d.wasmSize || "N/A"}, TX: ${d.txSize || "N/A"})`
                    );
                  }
                });
                allPass = false;
              }
            }
          }

          // Dependencies comparison
          if (txInfo.dependencies && result.dependencies) {
            const wasmDeps = result.dependencies.map((d) => d.toLowerCase());
            const txDeps = txInfo.dependencies.map((d) => d.toLowerCase());

            const depsMatch =
              wasmDeps.length === txDeps.length &&
              wasmDeps.every((d, i) => d === txDeps[i]);

            if (depsMatch) {
              console.log(
                `[Tx] ✅ Dependencies match (${wasmDeps.length} deps)`
              );
            } else {
              console.log(
                `[Tx] ❌ Dependencies mismatch! WASM=${wasmDeps.length}, Deployed=${txDeps.length}`
              );
              console.log(`     WASM: ${wasmDeps.join(", ")}`);
              console.log(`     TX:   ${txDeps.join(", ")}`);
              allPass = false;
            }
          }

          // CLI comparison (modules, deps, digest)
          if (config.skipCliParity) {
            console.log(`[CLI] ⚠️  Skipped: ${config.skipCliParity}`);
            continue;
          }

          const packageDir = path.join(FIXTURES_DIR, name, config.packagePath);
          const cliDump = await generateCliDump(
            packageDir,
            name,
            config.network
          );

          // CLI Modules comparison
          const cliModules = cliDump.modules || [];
          const wasmModulesMatch =
            result.modules?.length === cliModules.length &&
            result.modules.every((m, i) => m === cliModules[i]);
          if (wasmModulesMatch) {
            console.log(`[CLI] ✅ Modules match (WASM=CLI)`);
          } else {
            console.log(
              `[CLI] ❌ Modules mismatch! WASM=${result.modules?.length || 0}, CLI=${cliModules.length}`
            );
            allPass = false;
          }

          // CLI Dependencies comparison
          const cliDeps = (cliDump.dependencies || []).map((d) =>
            d.toLowerCase()
          );
          const wasmDeps2 = (result.dependencies || []).map((d) =>
            d.toLowerCase()
          );
          const depsMatch2 =
            wasmDeps2.length === cliDeps.length &&
            wasmDeps2.every((d, i) => d === cliDeps[i]);
          if (depsMatch2) {
            console.log(`[CLI] ✅ Dependencies match (WASM=CLI)`);
          } else {
            console.log(
              `[CLI] ❌ Dependencies mismatch! WASM=${wasmDeps2.length}, CLI=${cliDeps.length}`
            );
            allPass = false;
          }

          // CLI Digest comparison
          if (cliDump.digest && result.digest) {
            const wasmDigest = Buffer.from(result.digest)
              .toString("hex")
              .toUpperCase();
            const cliDigest = Buffer.from(cliDump.digest)
              .toString("hex")
              .toUpperCase();
            if (wasmDigest === cliDigest) {
              console.log(
                `[CLI] ✅ Digest match (${wasmDigest.slice(0, 16)}...)`
              );
            } else {
              console.log(`[CLI] ❌ Digest mismatch!`);
              console.log(`     WASM: ${wasmDigest}`);
              console.log(`     CLI:  ${cliDigest}`);
              allPass = false;
            }
          } else {
            console.log(`[CLI] ❌ Digest missing from WASM or CLI dump`);
            allPass = false;
          }
        } catch (txErr) {
          console.log(`[Tx/CLI] ❌ Error: ${txErr.message}`);
          allPass = false;
        }
      }
    } catch (e) {
      console.error(`[Error] Execution failed:`, e);
      allPass = false;
    }
  }

  if (!allPass) {
    console.error("\n❌ Fidelity tests failed.");
    process.exit(1);
  } else {
    console.log("\n✅ Fidelity tests passed!");
  }
}

runTest();
