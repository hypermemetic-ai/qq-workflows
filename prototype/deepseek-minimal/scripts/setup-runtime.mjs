#!/usr/bin/env node
/**
 * Reproducible, isolated runtime setup for the DeepSeek Minimal worker harness.
 *
 * Everything it creates lives under one private, relocatable RUNTIME ROOT
 * (default: $XDG_STATE_HOME/qq-workflows/deepseek-minimal-runtime, i.e. outside
 * every checkout). Nothing is installed globally, and the operator's ~/.dsh,
 * ~/.config, and installed `dsh` (0.1.5-rc.1) are never touched or used as the
 * runtime.
 *
 * Layout materialized at the destination:
 *   <root>/upstream                            pinned source checkout (built)
 *   <root>/dsh-home                            harness home + sdk-minimal profile
 *   <root>/profile/read-image-only.patch.yml   overlay (copied from the repo)
 *   <root>/profile/zvec-grep-gateway.patch.yml seat-scoped search overlay (copied)
 *   <root>/plugin/dsh-tool-read-image-only     wrapper plugin (copied) + linked deps
 *   <root>/gateway                             zvec-grep search gateway (copied) + linked MCP SDK
 *   <root>/provenance.json                     pinned commit/version/lockfile receipt
 *
 * Steps (idempotent):
 *   1. clone (or verify) the pinned upstream commit at <root>/upstream
 *   2. verify the checkout is exactly the pinned commit + version, tracked-clean
 *   3. pnpm install --frozen-lockfile          (workspace deps)
 *   4. pnpm run build:lib:host + build:native-system  (host libraries + addon)
 *   5. copy the overlay + wrapper plugin to the destination and re-link every
 *      runtime package the Cordis loader resolves from there
 *   6. verify the source CLI reports the pinned version, then record provenance
 *
 * Usage:
 *   node prototype/deepseek-minimal/scripts/setup-runtime.mjs \
 *     [--runtime-root <dir>] [--upstream <built-checkout>] [--skip-build]
 *
 * `QQ_DEEPSEEK_RUNTIME_ROOT` supplies the root when --runtime-root is absent.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekMinimalRuntimeRoot } from "../../../workflow/worker-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROTOTYPE_ROOT = dirname(HERE);
export const REPO_ROOT = dirname(dirname(PROTOTYPE_ROOT));

export const PIN = JSON.parse(readFileSync(join(PROTOTYPE_ROOT, "PIN.json"), "utf8"));
export const COMMIT = PIN.upstream.commit;
export const VERSION = PIN.upstream.version;

/**
 * The exact CLI invocation the adapter uses: the pinned checkout's BUILT CLI.
 * A single module graph (lib/ everywhere) is a correctness requirement, not a
 * preference — see adapter/runtime.mjs.
 */
export const CLI_ENTRY = ["apps", "cli", "lib", "bin.js"];

/**
 * Resolve every destination path for one runtime root. `upstreamRoot` lets an
 * already-built pinned checkout be shared by a second destination (the
 * relocation check); the production root always carries its own clone.
 */
export function resolveSetupPaths({ runtimeRoot, upstreamRoot, env = process.env } = {}) {
  const root = runtimeRoot || env.QQ_DEEPSEEK_RUNTIME_ROOT || deepSeekMinimalRuntimeRoot(env);
  const upstream = upstreamRoot || join(root, "upstream");
  const dshHome = join(root, "dsh-home");
  const profileDir = join(dshHome, "profiles", "sdk-minimal");
  return {
    root,
    upstream,
    dshHome,
    profileDir,
    overlay: join(root, "profile", "read-image-only.patch.yml"),
    overlaySource: join(PROTOTYPE_ROOT, "profile", "read-image-only.patch.yml"),
    searchOverlay: join(root, "profile", "zvec-grep-gateway.patch.yml"),
    searchOverlaySource: join(PROTOTYPE_ROOT, "profile", "zvec-grep-gateway.patch.yml"),
    pluginDir: join(root, "plugin", "dsh-tool-read-image-only"),
    pluginSource: join(PROTOTYPE_ROOT, "plugin", "dsh-tool-read-image-only"),
    gatewayDir: join(root, "gateway"),
    gatewaySource: join(PROTOTYPE_ROOT, "gateway"),
    provenanceFile: join(root, "provenance.json"),
    cli: join(upstream, ...CLI_ENTRY),
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
}

function git(paths, args) {
  return run("git", ["-C", paths.upstream, ...args]).trim();
}

/**
 * Point `path` at `target`. Only the exact link path is touched: an existing
 * symlink or file is replaced, an already-resolving real directory is kept.
 */
function link(target, path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }
  if (stat !== undefined) {
    if (stat.isDirectory() && !stat.isSymbolicLink()) return;
    unlinkSync(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
}

export function cloneUpstream(paths) {
  mkdirSync(paths.root, { recursive: true });
  if (!existsSync(join(paths.upstream, ".git"))) {
    if (existsSync(paths.upstream)) {
      throw new Error(`runtime upstream path '${paths.upstream}' exists but is not a git checkout`);
    }
    run("git", ["clone", "--quiet", PIN.upstream.repo, paths.upstream], { stdio: "inherit" });
    git(paths, ["checkout", "--quiet", COMMIT]);
    return;
  }
  // An already-pinned checkout needs no network: only fetch when the recorded
  // commit is not the pinned one, so a materialized runtime stays reproducible
  // offline and never silently follows a moving remote.
  let head = null;
  try {
    head = git(paths, ["rev-parse", "HEAD"]);
  } catch {
    head = null;
  }
  if (head !== COMMIT) {
    git(paths, ["fetch", "--quiet", "origin"]);
    git(paths, ["checkout", "--quiet", COMMIT]);
  }
}

export function verifyCheckout(paths) {
  const head = git(paths, ["rev-parse", "HEAD"]);
  if (head !== COMMIT) throw new Error(`runtime checkout at '${paths.upstream}' is ${head}, expected pinned ${COMMIT}`);
  const pkg = JSON.parse(readFileSync(join(paths.upstream, "package.json"), "utf8"));
  if (pkg.version !== VERSION) throw new Error(`runtime version is ${pkg.version}, expected pinned ${VERSION}`);
  // A mismatched/dirty runtime root is rejected instead of being used as-is.
  const dirty = git(paths, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty !== "") throw new Error(`runtime checkout at '${paths.upstream}' has tracked modifications; refusing to materialize a mismatched runtime`);
  return { head, version: pkg.version };
}

export function installDependencies(paths) {
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: paths.upstream, stdio: "inherit" });
}

export function buildHostLibs(paths) {
  run("pnpm", ["run", "build:lib:host"], { cwd: paths.upstream, stdio: "inherit" });
}

/**
 * Host native addon (`native/system`). `shutdown` reaches it, so the graceful
 * teardown path needs it; without it the harness still exits, but only through
 * the adapter's forced group kill.
 */
export function buildNativeSystem(paths) {
  run("pnpm", ["run", "build:native-system"], { cwd: paths.upstream, stdio: "inherit" });
}

export function runtimePackages(paths) {
  const mcpClientModules = join(paths.upstream, "packages", "mcp", "mcp-client", "node_modules");
  return {
    "@deepseek-ai/dsh-fs-local": join(paths.upstream, "packages", "fs", "fs-local"),
    "@deepseek-ai/dsh-attachment-local": join(paths.upstream, "packages", "attachment", "attachment-local"),
    "@deepseek-ai/dsh-tool-fs": join(paths.upstream, "packages", "fs", "tool-fs"),
    "@deepseek-ai/cordis": join(paths.upstream, "vendor", "cordis"),
    // The MCP protocol libraries the gateway reuses (no ad-hoc framing): the
    // pinned checkout's mcp-client dependency paths, version-locked by the
    // frozen lockfile this setup verifies. dsh-mcp-client resolves its own
    // runtime copy from the same store; the gateway only needs the libraries.
    "@deepseek-ai/dsh-mcp-client": join(paths.upstream, "packages", "mcp", "mcp-client"),
    "@modelcontextprotocol/server": join(mcpClientModules, "@modelcontextprotocol", "server"),
    "@modelcontextprotocol/client": join(mcpClientModules, "@modelcontextprotocol", "client"),
  };
}

/**
 * Materialize the harness home's profile directory at the destination. The CLI
 * writes `$DSH_HOME/profiles/sdk-minimal/{cordis.yml,package.json,...}` on
 * demand; the dump path creates it without booting the runtime or contacting a
 * provider.
 */
export function prepareDshHome(paths) {
  mkdirSync(paths.profileDir, { recursive: true });
  run(process.execPath, [paths.cli, "--profile", "sdk-minimal", "--dump-default-config"], {
    cwd: paths.upstream,
    env: { ...process.env, DSH_HOME: paths.dshHome },
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (!existsSync(join(paths.profileDir, "cordis.yml"))) {
    throw new Error(`profile root missing after preparation: ${join(paths.profileDir, "cordis.yml")}`);
  }
}

/**
 * Copy the reviewed overlays, the wrapper plugin, and the search gateway to
 * the destination so the runtime root is self-contained and relocatable (no
 * repo-relative references are baked into the launch). The gateway's own
 * `node_modules` links are (re)created afterwards by `linkPlugins`.
 */
export function materializeRuntimeFiles(paths) {
  rmSync(paths.pluginDir, { recursive: true, force: true });
  rmSync(paths.gatewayDir, { recursive: true, force: true });
  mkdirSync(dirname(paths.overlay), { recursive: true });
  cpSync(paths.overlaySource, paths.overlay);
  cpSync(paths.searchOverlaySource, paths.searchOverlay);
  mkdirSync(dirname(paths.pluginDir), { recursive: true });
  cpSync(paths.pluginSource, paths.pluginDir, { recursive: true });
  mkdirSync(dirname(paths.gatewayDir), { recursive: true });
  cpSync(paths.gatewaySource, paths.gatewayDir, { recursive: true });
}

/**
 * Make every plugin specifier resolvable at the destination.
 *
 * Cordis resolves an entry name against the base URL of the patch layer that
 * declared it. Bundle rows therefore anchor at the bundle package directory
 * inside the checkout; rows inserted by `--patch` overlays anchor at the
 * PROFILE directory (`$DSH_HOME/profiles/sdk-minimal`), which is a pnpm
 * project with no dependencies. The setup therefore links the destination
 * plugin (and its own resolved dependencies) into the profile's node_modules -
 * the same place `dsh plugin add <x>` would install them, but offline and
 * pinned by path.
 */
export function linkPlugins(paths) {
  const packages = runtimePackages(paths);
  for (const [name, target] of Object.entries(packages)) {
    if (!existsSync(target)) throw new Error(`pinned package missing: ${target}`);
  }
  // 1. overlay rows resolve here (bare specifiers anchored at the profile dir)
  link(paths.pluginDir, join(paths.profileDir, "node_modules", "dsh-tool-read-image-only"));
  link(packages["@deepseek-ai/dsh-fs-local"], join(paths.profileDir, "node_modules", "@deepseek-ai", "dsh-fs-local"));
  link(packages["@deepseek-ai/dsh-attachment-local"], join(paths.profileDir, "node_modules", "@deepseek-ai", "dsh-attachment-local"));
  // 2. the search overlay's MCP client instance resolves here too
  link(packages["@deepseek-ai/dsh-mcp-client"], join(paths.profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client"));
  // 3. the destination wrapper's own imports (read-image.ts -> dsh-tool-fs/-tools/-attachment)
  for (const name of ["@deepseek-ai/dsh-tool-fs", "@deepseek-ai/cordis"]) {
    link(packages[name], join(paths.pluginDir, "node_modules", name));
  }
  // 4. the destination gateway's own imports (the MCP server + client libraries)
  for (const name of ["@modelcontextprotocol/server", "@modelcontextprotocol/client"]) {
    link(packages[name], join(paths.gatewayDir, "node_modules", ...name.split("/")));
  }
}

/** Source-CLI identity check plus the "global dsh is not the runtime" receipt. */
export function verifyRuntime(paths) {
  if (!existsSync(paths.cli)) throw new Error(`pinned runtime is not built: ${paths.cli} is missing (run without --skip-build)`);
  const source = run(process.execPath, [paths.cli, "--version"], { cwd: paths.upstream }).trim();
  let global = null;
  try {
    global = run("dsh", ["--version"]).trim();
  } catch {
    global = null;
  }
  if (source !== VERSION) throw new Error(`source CLI reports ${source}, expected pinned ${VERSION}`);
  return { sourceCliVersion: source, globalDshVersion: global, globalDshUsed: false };
}

export function setup({ skipBuild = false, runtimeRoot, upstreamRoot, env = process.env } = {}) {
  const paths = resolveSetupPaths({ runtimeRoot, upstreamRoot, env });
  cloneUpstream(paths);
  const checkout = verifyCheckout(paths);
  const phases = ["clone", "verify-checkout"];
  installDependencies(paths);
  phases.push("install");
  if (!skipBuild) {
    buildHostLibs(paths);
    buildNativeSystem(paths);
    phases.push("build-lib-host", "build-native-system");
  }
  prepareDshHome(paths);
  materializeRuntimeFiles(paths);
  linkPlugins(paths);
  phases.push("prepare-dsh-home", "materialize-runtime-files", "link-plugins");
  const runtime = verifyRuntime(paths);
  const provenance = {
    recordedAt: new Date().toISOString(),
    preparedBy: "prototype/deepseek-minimal/scripts/setup-runtime.mjs",
    lockfileSha256: createHash("sha256").update(readFileSync(join(paths.upstream, "pnpm-lock.yaml"))).digest("hex"),
    node: process.version,
    pnpm: run("pnpm", ["--version"], { cwd: paths.upstream }).trim(),
    runtimeRoot: paths.root,
    upstreamRoot: paths.upstream,
    dshHome: paths.dshHome,
    profileDir: paths.profileDir,
    overlay: paths.overlay,
    searchOverlay: paths.searchOverlay,
    pluginDir: paths.pluginDir,
    gatewayDir: paths.gatewayDir,
    launch: { bin: process.execPath, args: [paths.cli] },
    cliEntry: paths.cli,
    phases,
    skipBuild,
    ...checkout,
    ...runtime,
  };
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

// Functions above are imported by tests/tools; the CLI path only runs on direct execution.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const result = setup({
    skipBuild: argv.includes("--skip-build"),
    runtimeRoot: valueOf("--runtime-root"),
    upstreamRoot: valueOf("--upstream"),
  });
  console.log(JSON.stringify(result, null, 2));
}
