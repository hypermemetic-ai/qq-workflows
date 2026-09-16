#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanMuseAuth,
  configureOrcaSettings,
  ensureOrcaMuseSparkDisplay,
  installAgents,
  mergeCodexConfig,
  mergeMuseSettings,
  museConfigDir,
  patchOrcaMuseSparkDisplayName,
  resolveOrcaOutDir,
} from "../scripts/install-agents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const shimPath = join(repoRoot, "bin", "muse-architect.sh");
const codexShimPath = join(repoRoot, "bin", "codex-architect.sh");
const architectBin = join(repoRoot, "bin", "architect.mjs");
const mcpServerBin = join(repoRoot, "bin", "mcp-server.mjs");

// Never touch the real HOME: every installer call below passes an explicit
// home root, and every shim launch overrides HOME in its subprocess env.
const savedXdg = process.env.XDG_CONFIG_HOME;

// 1. mergeCodexConfig is pure: disables shell tools, configures MCP servers
{
  const fresh = mergeCodexConfig(undefined, { mcpServerBin, zgBin: "zg", promptFile: "/p/prompt.md" });
  assert.ok(fresh.includes('model_instructions_file = "/p/prompt.md"'));
  assert.ok(fresh.includes("[features]"));
  assert.ok(fresh.includes("shell_tool = false"));
  assert.ok(fresh.includes("unified_exec = false"));
  assert.ok(fresh.includes("[mcp_servers.qq-workflows]"));
  assert.ok(fresh.includes(`args = ["${mcpServerBin}"]`));
  assert.ok(fresh.includes("[mcp_servers.zvec_grep]"));

  const existing = `model = "custom"\n[features]\nshell_tool = true\n`;
  const merged = mergeCodexConfig(existing, { mcpServerBin, zgBin: "zg" });
  assert.ok(merged.includes('model = "custom"'));
  assert.ok(merged.includes("shell_tool = false"));
  assert.ok(merged.includes("unified_exec = false"));
}

// 1b. mergeMuseSettings is pure: missing presets become {}, everything else stays.
{
  const fresh = mergeMuseSettings(undefined, mcpServerBin);
  assert.deepEqual(fresh.presets, { architect: {}, implementer: {}, reviewer: {}, researcher: {} });
  assert.deepEqual(fresh.mcpServers["qq-workflows"], { command: "node", args: [mcpServerBin] });

  const existing = {
    schema_version: 1,
    model: "custom-model",
    tui: { foreign_context_notice_shown: true },
    mcpServers: {
      other: { command: "other-bin", args: ["--stdio"] },
      "qq-workflows": { command: "stale", args: ["stale"] },
    },
    presets: {
      architect: { model: "keep-me" },
      custom: { a: 1 },
    },
  };
  const snapshot = JSON.parse(JSON.stringify(existing));
  const merged = mergeMuseSettings(existing, mcpServerBin);
  assert.deepEqual(existing, snapshot); // input untouched
  assert.deepEqual(merged.presets.architect, { model: "keep-me" });
  assert.deepEqual(merged.presets.custom, { a: 1 });
  assert.deepEqual(merged.presets.implementer, {});
  assert.deepEqual(merged.presets.reviewer, {});
  assert.deepEqual(merged.presets.researcher, {});
  assert.equal(merged.model, "custom-model");
  assert.equal(merged.schema_version, 1);
  assert.deepEqual(merged.tui, { foreign_context_notice_shown: true });
  assert.deepEqual(merged.mcpServers.other, { command: "other-bin", args: ["--stdio"] });
  assert.deepEqual(merged.mcpServers["qq-workflows"], { command: "node", args: [mcpServerBin] });

  for (const junk of [null, "junk", 42, ["x"]]) {
    const reset = mergeMuseSettings(junk, mcpServerBin);
    assert.deepEqual(Object.keys(reset.presets).sort(), ["architect", "implementer", "researcher", "reviewer"]);
  }
}

// 2. museConfigDir prefers $XDG_CONFIG_HOME/muse.
{
  assert.equal(museConfigDir("/home/u", "/home/u/.xdg"), join("/home/u/.xdg", "muse"));
  assert.equal(museConfigDir("/home/u", ""), join("/home/u", ".config", "muse"));
  assert.equal(museConfigDir("/home/u", "  "), join("/home/u", ".config", "muse"));
  delete process.env.XDG_CONFIG_HOME;
  assert.equal(museConfigDir("/home/u"), join("/home/u", ".config", "muse"));
  process.env.XDG_CONFIG_HOME = "/env/xdg";
  assert.equal(museConfigDir("/home/u"), join("/env/xdg", "muse"));
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
}

// 3. Full installer run against a temp home.
const tempHome = mkdtempSync(join(tmpdir(), "architect-install-home-"));
try {
  const logs = [];
  const result = await installAgents({
    home: tempHome,
    xdgConfigHome: "",
    repoRoot,
    log: (message) => logs.push(message),
  });
  assert.equal(result.home, tempHome);
  assert.equal(result.museSettingsPath, join(tempHome, ".config", "muse", "settings.json"));

  // Gemini side still installed.
  for (const role of ["architect", "implementer", "reviewer"]) {
    const link = join(tempHome, ".gemini", "config", "agents", role, "agent.md");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(repoRoot, "agents", role, "agent.md"));
  }
  const mcpConfig = JSON.parse(readFileSync(join(tempHome, ".gemini", "config", "mcp_config.json"), "utf8"));
  assert.deepEqual(mcpConfig.mcpServers["qq-workflows"], { command: "node", args: [mcpServerBin] });
  const hooks = JSON.parse(readFileSync(join(tempHome, ".gemini", "config", "hooks.json"), "utf8"));
  assert.ok(hooks["architect-ticket"].PreInvocation[0].command.includes("pre-invocation.mjs"));
  // Req 5: task-completion Stop hook must be registered
  assert.ok(hooks["task-completion"], "task-completion Stop hook must be registered in hooks.json");
  assert.ok(hooks["task-completion"].Stop, "task-completion must have Stop handlers");
  assert.ok(hooks["task-completion"].Stop[0].command.includes("stop.mjs"), "Stop hook command must reference stop.mjs");
  const architectLink = join(tempHome, ".local", "bin", "architect");
  assert.ok(lstatSync(architectLink).isSymbolicLink());
  assert.equal(readlinkSync(architectLink), join(repoRoot, "bin", "architect.mjs"));

  // Muse side: settings, presets, launcher symlink, opencode alias.
  const settings = JSON.parse(readFileSync(join(tempHome, ".config", "muse", "settings.json"), "utf8"));
  assert.deepEqual(settings.presets, { architect: {}, implementer: {}, reviewer: {}, researcher: {} });
  assert.deepEqual(settings.mcpServers["qq-workflows"], { command: "node", args: [mcpServerBin] });
  const shimLink = join(tempHome, ".local", "bin", "muse-architect");
  assert.ok(lstatSync(shimLink).isSymbolicLink());
  assert.equal(readlinkSync(shimLink), shimPath);
  const codexShimLink = join(tempHome, ".local", "bin", "codex-architect");
  assert.ok(lstatSync(codexShimLink).isSymbolicLink());
  assert.equal(readlinkSync(codexShimLink), codexShimPath);
  const codexConf = readFileSync(join(tempHome, ".codex", "config.toml"), "utf8");
  assert.ok(codexConf.includes("shell_tool = false"));
  assert.ok(codexConf.includes("unified_exec = false"));
  assert.ok(codexConf.includes("[mcp_servers.qq-workflows]"));
  assert.ok(codexConf.includes("[mcp_servers.zvec_grep]"));
  const opencodeLink = join(tempHome, ".local", "bin", "opencode");
  assert.ok(lstatSync(opencodeLink).isSymbolicLink());
  assert.equal(readlinkSync(opencodeLink), shimPath);
  accessSync(opencodeLink, constants.X_OK);
  assert.ok(logs.some((line) => line.includes("muse-architect")));
  assert.ok(logs.some((line) => line.includes("codex-architect")));
  assert.ok(logs.some((line) => line.includes("opencode alias")));
  assert.ok(logs.some((line) => line.includes("Installation complete!")));

  // The alias answers --help/--version cleanly (exit 0, no side effects).
  {
    const env = { ...process.env, HOME: tempHome };
    delete env.XDG_CONFIG_HOME;
    const help = execFileSync(opencodeLink, ["--help"], { env, encoding: "utf8" });
    assert.match(help, /Usage: muse-architect/);
    const version = execFileSync(opencodeLink, ["--version"], { env, encoding: "utf8" });
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(version.trim(), `muse-architect ${pkg.version}`);
  }

  // Second run preserves pre-existing preset content and other keys.
  const seeded = {
    model: "seeded-model",
    mcpServers: { other: { command: "o", args: [] } },
    presets: { architect: { model: "keep" }, implementer: {}, reviewer: {}, researcher: {} },
  };
  writeFileSync(join(tempHome, ".config", "muse", "settings.json"), JSON.stringify(seeded));
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: () => {} });
  const resealed = JSON.parse(readFileSync(join(tempHome, ".config", "muse", "settings.json"), "utf8"));
  assert.deepEqual(resealed.presets.architect, { model: "keep" });
  assert.equal(resealed.model, "seeded-model");
  assert.deepEqual(resealed.mcpServers.other, { command: "o", args: [] });
  assert.deepEqual(resealed.mcpServers["qq-workflows"], { command: "node", args: [mcpServerBin] });

  // Rerun keeps the alias pointed at this repo's launcher.
  const notes = [];
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: (m) => notes.push(m) });
  assert.ok(lstatSync(join(tempHome, ".local", "bin", "opencode")).isSymbolicLink());
  assert.equal(readlinkSync(join(tempHome, ".local", "bin", "opencode")), shimPath);
  assert.ok(notes.some((line) => line.includes("opencode alias already installed")));

  // A drifted alias to our launcher (stale repo path) is repointed with a note.
  rmSync(join(tempHome, ".local", "bin", "opencode"));
  symlinkSync(shimLink, join(tempHome, ".local", "bin", "opencode"));
  const repointNotes = [];
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: (m) => repointNotes.push(m) });
  assert.equal(readlinkSync(join(tempHome, ".local", "bin", "opencode")), shimPath);
  assert.ok(repointNotes.some((line) => line.includes("opencode") && line.includes("Repointed")));

  // A foreign opencode file is left alone with a note.
  rmSync(join(tempHome, ".local", "bin", "opencode"));
  writeFileSync(join(tempHome, ".local", "bin", "opencode"), "#!/bin/sh\n");
  const foreignNotes = [];
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: (m) => foreignNotes.push(m) });
  assert.equal(readFileSync(join(tempHome, ".local", "bin", "opencode"), "utf8"), "#!/bin/sh\n");
  assert.ok(foreignNotes.some((line) => line.includes("Leaving foreign opencode entry alone")));

  // A foreign opencode symlink is left alone with a note.
  rmSync(join(tempHome, ".local", "bin", "opencode"));
  symlinkSync("/opt/opencode/bin/opencode", join(tempHome, ".local", "bin", "opencode"));
  const foreignLinkNotes = [];
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: (m) => foreignLinkNotes.push(m) });
  assert.equal(readlinkSync(join(tempHome, ".local", "bin", "opencode")), "/opt/opencode/bin/opencode");
  assert.ok(foreignLinkNotes.some((line) => line.includes("Leaving foreign opencode symlink alone")));

  // Stale hardcoded architect prompt is removed with a note.
  const staleAgents = join(tempHome, ".config", "muse", "architect", "AGENTS.md");
  mkdirSync(dirname(staleAgents), { recursive: true });
  writeFileSync(staleAgents, "# stale\n");
  const notes2 = [];
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: (m) => notes2.push(m) });
  assert.equal(existsSync(staleAgents), false);
  assert.ok(notes2.some((line) => line.includes("AGENTS.md") && line.includes("Removed")));

  // Invalid settings.json does not crash the installer.
  writeFileSync(join(tempHome, ".config", "muse", "settings.json"), "{not json");
  await installAgents({ home: tempHome, xdgConfigHome: "", repoRoot, log: () => {} });
  const recovered = JSON.parse(readFileSync(join(tempHome, ".config", "muse", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(recovered.presets).sort(), ["architect", "implementer", "researcher", "reviewer"]);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

// 4. XDG run: muse settings + stale cleanup follow $XDG_CONFIG_HOME.
const xdgHome = mkdtempSync(join(tmpdir(), "architect-install-xdghome-"));
const xdgBase = mkdtempSync(join(tmpdir(), "architect-install-xdg-"));
try {
  const staleXdg = join(xdgBase, "muse", "architect", "AGENTS.md");
  mkdirSync(dirname(staleXdg), { recursive: true });
  writeFileSync(staleXdg, "# stale xdg\n");
  const notes = [];
  await installAgents({ home: xdgHome, xdgConfigHome: xdgBase, repoRoot, log: (m) => notes.push(m) });
  assert.equal(existsSync(join(xdgBase, "muse", "settings.json")), true);
  assert.equal(existsSync(join(xdgHome, ".config", "muse", "settings.json")), false);
  assert.equal(existsSync(staleXdg), false);
  assert.ok(notes.some((line) => line.includes("AGENTS.md")));
  // Gemini side still lives under the home root.
  assert.equal(existsSync(join(xdgHome, ".gemini", "config", "mcp_config.json")), true);
} finally {
  rmSync(xdgHome, { recursive: true, force: true });
  rmSync(xdgBase, { recursive: true, force: true });
}

// 5. Static pins: homedir() only as the default home root, exactly two
// launcher symlinks, and no live process execution in the installer.
{
  const installerSrc = readFileSync(join(repoRoot, "scripts", "install-agents.mjs"), "utf8");
  assert.equal(installerSrc.match(/homedir\(\)/g)?.length ?? 0, 1);
  assert.match(installerSrc, /home = homedir\(\)/);
  assert.equal(installerSrc.match(/installSymlink\(/g)?.length ?? 0, 4); // helper def + 3 calls
  assert.doesNotMatch(installerSrc, /child_process/);
  assert.doesNotMatch(installerSrc, /execFile|execSync|spawnSync|spawn\(/);
}

// 6. Shim: --help/--version exit clean with no side effects.
accessSync(shimPath, constants.X_OK);
{
  const probeHome = mkdtempSync(join(tmpdir(), "architect-shim-home-"));
  const probeWork = mkdtempSync(join(tmpdir(), "architect-shim-work-"));
  try {
    const env = { ...process.env, HOME: probeHome };
    delete env.XDG_CONFIG_HOME;
    const help = execFileSync(shimPath, ["--help"], { cwd: probeWork, env, encoding: "utf8" });
    assert.match(help, /Usage: muse-architect/);
    const version = execFileSync(shimPath, ["--version"], { cwd: probeWork, env, encoding: "utf8" });
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(version.trim(), `muse-architect ${pkg.version}`);
    assert.equal(existsSync(join(probeWork, ".architect")), false);
    assert.equal(existsSync(join(probeHome, ".config")), false);
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
    rmSync(probeWork, { recursive: true, force: true });
  }
}

// 7. Shim: full launch against a fake muse. Minimal PATH keeps the probe
// hermetic (no orca side effects, no live muse).
function shimEnv(home, fakeBin, extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    HOME: home,
    PATH: [fakeBin, "/usr/bin", "/bin"].join(":"),
  };
  delete env.XDG_CONFIG_HOME;
  return env;
}

function writeFakeBin(fakeBin, recordDir) {
  const museRecord = join(recordDir, "muse-call.txt");
  writeFileSync(
    join(fakeBin, "muse"),
    `#!/usr/bin/env bash\n{\necho "ARGS: $@"\necho "TBH: \${TBH_EVAL_APPEND_DEVELOPER_PROMPT_FILE-unset}"\nif [ -z "\${META_API_KEY+x}" ]; then echo "META: unset"; else echo "META: SET"; fi\n} > ${museRecord}\n`,
  );
  execFileSync("chmod", ["+x", join(fakeBin, "muse")]);
  // Stub orca too: the shim notifies it in the background, and a real orca
  // (or the GNOME screen reader shipped as /usr/bin/orca) must never run here.
  const orcaRecord = join(recordDir, "orca-call.txt");
  writeFileSync(join(fakeBin, "orca"), `#!/usr/bin/env bash\necho "ORCA: $@" > ${orcaRecord}\n`);
  execFileSync("chmod", ["+x", join(fakeBin, "orca")]);
  return { museRecord, orcaRecord };
}

async function waitForFile(path, timeoutMs = 5000) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectedPromptBody(sessionId) {
  const agentMd = readFileSync(join(repoRoot, "agents", "architect", "agent.md"), "utf8");
  const body = agentMd.replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.ok(body.length < agentMd.length, "frontmatter strip must remove bytes");
  return body.split("<sessionId>").join(sessionId);
}

{
  const launchHome = mkdtempSync(join(tmpdir(), "architect-shim-launch-home-"));
  const launchWork = mkdtempSync(join(tmpdir(), "architect-shim-launch-work-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-shim-fakebin-"));
  try {
    const { museRecord, orcaRecord } = writeFakeBin(fakeBin, launchHome);
    const sessionId = "shim-sess-4242";
    const out = execFileSync(shimPath, ["--session", sessionId], {
      cwd: launchWork,
      env: { ...shimEnv(launchHome, fakeBin), META_API_KEY: "secret-parent-value" },
      encoding: "utf8",
    });
    assert.match(out, /Ticket: .*\.architect\/tickets\/shim-sess-4242\.md/);

    // Ticket seeded from this repo's template (workspace has none).
    assert.equal(
      readFileSync(join(launchWork, ".architect", "tickets", `${sessionId}.md`), "utf8"),
      readFileSync(join(repoRoot, ".architect", "template.md"), "utf8"),
    );

    // Prompt rendered byte-identical to the role file apart from the id.
    const promptFile = join(launchHome, ".config", "muse", "architect", "prompt.md");
    const prompt = readFileSync(promptFile, "utf8");
    assert.equal(prompt, expectedPromptBody(sessionId));
    assert.ok(!prompt.includes("<sessionId>"));
    assert.ok(!prompt.includes("name: architect"));
    assert.ok(prompt.includes(sessionId));

    // Fake muse got the defaults, not the consumed --session flag.
    const call = readFileSync(museRecord, "utf8");
    assert.match(call, /--preset architect/);
    assert.match(call, /--model muse-spark-1\.3/);
    assert.match(call, /--reasoning-effort max/);
    assert.match(call, /--yolo/);
    assert.ok(call.includes(`--workspace ${launchWork}`));
    assert.ok(!call.includes("--session"));
    assert.ok(call.includes(`TBH: ${promptFile}`));
    assert.ok(call.includes("META: unset"));

    // The background orca notify fired with the ticket path.
    await waitForFile(orcaRecord);
    assert.equal(
      readFileSync(orcaRecord, "utf8").trim(),
      `ORCA: file open ${join(launchWork, ".architect", "tickets", `${sessionId}.md`)}`,
    );

    // Rerun reuses the ticket instead of overwriting it.
    writeFileSync(join(launchWork, ".architect", "tickets", `${sessionId}.md`), "# edited\n");
    execFileSync(shimPath, ["-c", sessionId], {
      cwd: launchWork,
      env: shimEnv(launchHome, fakeBin),
      encoding: "utf8",
    });
    assert.equal(
      readFileSync(join(launchWork, ".architect", "tickets", `${sessionId}.md`), "utf8"),
      "# edited\n",
    );
  } finally {
    rmSync(launchHome, { recursive: true, force: true });
    rmSync(launchWork, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// 8. Shim: session minting, workspace template precedence, XDG prompt path.
{
  const mintHome = mkdtempSync(join(tmpdir(), "architect-shim-mint-home-"));
  const mintWork = mkdtempSync(join(tmpdir(), "architect-shim-mint-work-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-shim-mint-fakebin-"));
  try {
    writeFakeBin(fakeBin, mintHome);
    execFileSync(shimPath, [], { cwd: mintWork, env: shimEnv(mintHome, fakeBin), encoding: "utf8" });
    const files = readdirSync(join(mintWork, ".architect", "tickets"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/);
  } finally {
    rmSync(mintHome, { recursive: true, force: true });
    rmSync(mintWork, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }

  const wsHome = mkdtempSync(join(tmpdir(), "architect-shim-ws-home-"));
  const wsWork = mkdtempSync(join(tmpdir(), "architect-shim-ws-work-"));
  const wsBin = mkdtempSync(join(tmpdir(), "architect-shim-ws-fakebin-"));
  try {
    writeFakeBin(wsBin, wsHome);
    mkdirSync(join(wsWork, ".architect"), { recursive: true });
    writeFileSync(join(wsWork, ".architect", "template.md"), "# workspace template\n");
    execFileSync(shimPath, ["--session", "ws-1"], {
      cwd: wsWork,
      env: shimEnv(wsHome, wsBin),
      encoding: "utf8",
    });
    assert.equal(
      readFileSync(join(wsWork, ".architect", "tickets", "ws-1.md"), "utf8"),
      "# workspace template\n",
    );

    // XDG set: prompt lands under $XDG_CONFIG_HOME/muse.
    const xdgBase = mkdtempSync(join(tmpdir(), "architect-shim-xdg-"));
    try {
      execFileSync(shimPath, ["--session", "ws-2"], {
        cwd: wsWork,
        env: { ...shimEnv(wsHome, wsBin), XDG_CONFIG_HOME: xdgBase },
        encoding: "utf8",
      });
      assert.equal(
        readFileSync(join(xdgBase, "muse", "architect", "prompt.md"), "utf8"),
        expectedPromptBody("ws-2"),
      );
    } finally {
      rmSync(xdgBase, { recursive: true, force: true });
    }
  } finally {
    rmSync(wsHome, { recursive: true, force: true });
    rmSync(wsWork, { recursive: true, force: true });
    rmSync(wsBin, { recursive: true, force: true });
  }
}

// 9. Shim: last-resort fallbacks when the shim's own repo has no template or
// role file (exercised via a copied shim so the real repo stays intact).
{
  const fbHome = mkdtempSync(join(tmpdir(), "architect-shim-fb-home-"));
  const fbRepo = mkdtempSync(join(tmpdir(), "architect-shim-fb-repo-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-shim-fb-fakebin-"));
  try {
    writeFakeBin(fakeBin, fbHome);
    mkdirSync(join(fbRepo, "bin"), { recursive: true });
    const copiedShim = join(fbRepo, "bin", "muse-architect.sh");
    writeFileSync(copiedShim, readFileSync(shimPath, "utf8"));
    execFileSync("chmod", ["+x", copiedShim]);
    execFileSync(copiedShim, ["--session", "fb-1"], {
      cwd: fbRepo,
      env: shimEnv(fbHome, fakeBin),
      encoding: "utf8",
    });
    const ticket = readFileSync(join(fbRepo, ".architect", "tickets", "fb-1.md"), "utf8");
    assert.match(ticket, /^# Ticket/m);
    assert.match(ticket, /bounded — straightforward work/);
    const prompt = readFileSync(join(fbHome, ".config", "muse", "architect", "prompt.md"), "utf8");
    assert.ok(prompt.includes("You are the architect. The ticket is `.architect/tickets/fb-1.md`."));
    assert.ok(prompt.includes("Do not call prepare_worktree until the operator explicitly approves."));
  } finally {
    rmSync(fbHome, { recursive: true, force: true });
    rmSync(fbRepo, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// 10. Launcher wiring: `architect prepare` requires --session, and the muse
// seat launches via muse-architect (no OPENCODE_BIN fallback).
{
  const cliWork = mkdtempSync(join(tmpdir(), "architect-cli-work-"));
  try {
    let usage = null;
    try {
      execFileSync(process.execPath, [architectBin, "prepare", "--kind", "bounded"], {
        cwd: cliWork,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      usage = error;
    }
    assert.ok(usage, "prepare without --session must fail");
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: architect prepare .*--session/);

    const launcherSrc = readFileSync(architectBin, "utf8");
    assert.match(launcherSrc, /MUSE_ARCHITECT_BIN/);
    assert.match(launcherSrc, /muse-architect/);
    assert.match(launcherSrc, /CODEX_ARCHITECT_BIN/);
    assert.match(launcherSrc, /codex-architect/);
    assert.doesNotMatch(launcherSrc, /OPENCODE_BIN/);
    assert.doesNotMatch(launcherSrc, /opencode/i);
  } finally {
    rmSync(cliWork, { recursive: true, force: true });
  }
}

// 11. Codex Shim: --help/--version exit clean with no side effects.
accessSync(codexShimPath, constants.X_OK);
{
  const probeHome = mkdtempSync(join(tmpdir(), "architect-codex-shim-home-"));
  const probeWork = mkdtempSync(join(tmpdir(), "architect-codex-shim-work-"));
  try {
    const env = { ...process.env, HOME: probeHome };
    delete env.XDG_CONFIG_HOME;
    delete env.CODEX_HOME;
    const help = execFileSync(codexShimPath, ["--help"], { cwd: probeWork, env, encoding: "utf8" });
    assert.match(help, /Usage: codex-architect/);
    const version = execFileSync(codexShimPath, ["--version"], { cwd: probeWork, env, encoding: "utf8" });
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(version.trim(), `codex-architect ${pkg.version}`);
    assert.equal(existsSync(join(probeWork, ".architect")), false);
    assert.equal(existsSync(join(probeHome, ".codex")), false);
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
    rmSync(probeWork, { recursive: true, force: true });
  }
}

// 12. Codex Shim: full launch against a fake codex.
{
  const launchHome = mkdtempSync(join(tmpdir(), "architect-codex-launch-home-"));
  const launchWork = mkdtempSync(join(tmpdir(), "architect-codex-launch-work-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-codex-fakebin-"));
  try {
    const codexRecord = join(launchHome, "codex-call.txt");
    writeFileSync(
      join(fakeBin, "codex"),
      `#!/usr/bin/env bash\necho "ARGS: $@" > ${codexRecord}\n`,
    );
    execFileSync("chmod", ["+x", join(fakeBin, "codex")]);

    const sessionId = "codex-sess-1234";
    const env = { ...process.env, HOME: launchHome, PATH: [fakeBin, "/usr/bin", "/bin"].join(":") };
    delete env.XDG_CONFIG_HOME;
    delete env.CODEX_HOME;

    execFileSync(codexShimPath, ["--session", sessionId], {
      cwd: launchWork,
      env,
      encoding: "utf8",
    });

    // Check ticket created from template
    assert.equal(
      readFileSync(join(launchWork, ".architect", "tickets", `${sessionId}.md`), "utf8"),
      readFileSync(join(repoRoot, ".architect", "template.md"), "utf8"),
    );

    // Check prompt rendered with Astra delegation model, tool list, and Git lifecycle
    const promptPath = join(launchHome, ".codex", "architect-instructions.md");
    assert.ok(existsSync(promptPath));
    const prompt = readFileSync(promptPath, "utf8");
    assert.ok(prompt.includes("You are the architect collaborating with the operator."));
    assert.ok(prompt.includes("Git Lifecycle"));
    assert.ok(prompt.includes("Tools & Delegation Model"));
    assert.ok(prompt.includes("dispatch_runner"));
    assert.ok(prompt.includes("dispatch_execution"));
    assert.ok(prompt.includes(sessionId));

    // Check fake codex was invoked with disabled shell tools and model_instructions_file
    const call = readFileSync(codexRecord, "utf8");
    assert.ok(call.includes("features.shell_tool=false"));
    assert.ok(call.includes("features.unified_exec=false"));
    assert.ok(call.includes("model_instructions_file"));
    assert.ok(call.includes("gpt-6-astra"));
    // Req 1: codex-architect DEFAULT_ARGS must include plugin-disable flags
    assert.ok(call.includes("features.plugins=false"), "codex-architect must pass features.plugins=false");
    assert.ok(call.includes("features.remote_plugin=false"), "codex-architect must pass features.remote_plugin=false");

    // Req 2: ticket content must be embedded in the rendered architect-instructions.md
    // (reuse `prompt` and `promptPath` already read above)
    assert.ok(prompt.includes("Active Ticket"), "architect-instructions.md must embed ticket content section");
    // The session's ticket file was created from the repo template above.
    const ticketContent = readFileSync(join(launchWork, ".architect", "tickets", `${sessionId}.md`), "utf8");
    // At least the section header must appear in the prompt
    assert.ok(
      prompt.includes(ticketContent.slice(0, 20)) || prompt.includes("Active Ticket"),
      "architect-instructions.md must contain embedded ticket content or the pre-seed section",
    );

    // Req 3: anti-polling floor instruction must appear in the rendered prompt
    assert.ok(
      prompt.includes("120,000ms") || prompt.includes("2 minutes"),
      "architect-instructions.md must include anti-polling floor instruction",
    );
  } finally {
    rmSync(launchHome, { recursive: true, force: true });
    rmSync(launchWork, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// 12. cleanMuseAuth is pure: removes api_key from providers while preserving tokens
{
  const withKey = JSON.stringify({
    schema_version: 1,
    providers: {
      meta: {
        access_token: "sub-token-123",
        api_key: "contributor-key-456",
        mechanism: "oauth",
        user_email: "test@example.com",
      },
    },
  });
  const cleaned = cleanMuseAuth(withKey);
  const parsed = JSON.parse(cleaned);
  assert.equal(parsed.providers.meta.access_token, "sub-token-123");
  assert.equal(parsed.providers.meta.api_key, undefined);
  assert.equal(parsed.providers.meta.mechanism, "oauth");

  const withoutKey = JSON.stringify({
    schema_version: 1,
    providers: {
      meta: {
        access_token: "sub-token-123",
      },
    },
  });
  assert.equal(cleanMuseAuth(withoutKey), withoutKey);
  assert.equal(cleanMuseAuth(""), "");
}

// 13. configureOrcaSettings is pure: sets agentCmdOverrides.codex to codex-architect
{
  const fresh = configureOrcaSettings(undefined);
  const freshParsed = JSON.parse(fresh);
  assert.equal(freshParsed.settings.agentCmdOverrides.codex, "codex-architect");

  const existing = JSON.stringify({
    settings: {
      workspaceDir: "/ws",
      agentCmdOverrides: {
        claude: "custom-claude",
      },
    },
  });
  const merged = configureOrcaSettings(existing);
  const mergedParsed = JSON.parse(merged);
  assert.equal(mergedParsed.settings.workspaceDir, "/ws");
  assert.equal(mergedParsed.settings.agentCmdOverrides.claude, "custom-claude");
  assert.equal(mergedParsed.settings.agentCmdOverrides.codex, "codex-architect");
}

// 14. installAgents cleans muse auth and configures Orca files
{
  const testHome = mkdtempSync(join(tmpdir(), "architect-orca-install-home-"));
  try {
    // Setup fake muse auth
    const museDir = join(testHome, ".config", "muse");
    mkdirSync(museDir, { recursive: true });
    writeFileSync(
      join(museDir, "auth.json"),
      JSON.stringify({
        providers: {
          meta: {
            access_token: "oauth-tok",
            api_key: "bad-contrib-key",
          },
        },
      }),
    );

    // Setup fake orca profile and managed codex account
    const orcaProfileDir = join(testHome, ".config", "orca", "profiles", "local-default");
    mkdirSync(orcaProfileDir, { recursive: true });
    writeFileSync(
      join(orcaProfileDir, "orca-data.json"),
      JSON.stringify({
        settings: { workspaceDir: "/test" },
      }),
    );

    const codexAccDir = join(testHome, ".config", "orca", "codex-accounts", "acc-uuid", "home");
    mkdirSync(codexAccDir, { recursive: true });
    writeFileSync(join(codexAccDir, "config.toml"), 'model = "gpt-6-astra"\n');

    await installAgents({ home: testHome, repoRoot });

    // Assert muse auth sanitized
    const authParsed = JSON.parse(readFileSync(join(museDir, "auth.json"), "utf8"));
    assert.equal(authParsed.providers.meta.access_token, "oauth-tok");
    assert.equal(authParsed.providers.meta.api_key, undefined);

    // Assert Orca settings updated
    const orcaParsed = JSON.parse(readFileSync(join(orcaProfileDir, "orca-data.json"), "utf8"));
    assert.equal(orcaParsed.settings.agentCmdOverrides.codex, "codex-architect");
    assert.equal(orcaParsed.settings.workspaceDir, "/test");

    // Assert Orca managed codex config updated
    const tomlContent = readFileSync(join(codexAccDir, "config.toml"), "utf8");
    assert.ok(tomlContent.includes("[features]"));
    assert.ok(tomlContent.includes("shell_tool = false"));
    assert.ok(tomlContent.includes("[mcp_servers.qq-workflows]"));
    assert.ok(tomlContent.includes("[mcp_servers.zvec_grep]"));
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
}

// 15. patchOrcaMuseSparkDisplayName is pure: display labels become
// "Muse Spark" while ids, commands, model labels, and identifiers stay.
{
  const displayMap = "exports.TUI_AGENT_DISPLAY_NAMES = {\n    opencode: 'OpenCode',\n    pi: 'Pi',\n};";
  const patchedMap = patchOrcaMuseSparkDisplayName(displayMap);
  assert.ok(patchedMap.includes("opencode: 'Muse Spark'"));
  assert.ok(patchedMap.includes("pi: 'Pi'"));
  assert.ok(!patchedMap.includes("OpenCode"));

  const commitSpec = [
    "opencode: {",
    "    id: 'opencode',",
    "    label: 'OpenCode',",
    "    binary: 'opencode',",
    "    models: [{ id: 'opencode/gpt-5.4-mini', label: 'OpenCode GPT 5.4 Mini' }],",
    "},",
  ].join("\n");
  const patchedSpec = patchOrcaMuseSparkDisplayName(commitSpec);
  assert.ok(patchedSpec.includes("label: 'Muse Spark'"));
  assert.ok(patchedSpec.includes("id: 'opencode'"));
  assert.ok(patchedSpec.includes("binary: 'opencode'"));
  assert.ok(patchedSpec.includes("label: 'OpenCode GPT 5.4 Mini'"));

  const chunk = "const e={opencode:`OpenCode`,pi:`Pi`};function t(e){return O(e)?`OpenCode`:T(e,`opencode`)?`OpenCode`:x}";
  const patchedChunk = patchOrcaMuseSparkDisplayName(chunk);
  assert.ok(!patchedChunk.includes("`OpenCode`"));
  assert.ok(patchedChunk.includes("opencode:`Muse Spark`"));

  const status = "opencode:{workingLabel:`OpenCode`,permissionLabel:`OpenCode - action required`,idleLabel:`OpenCode ready`}";
  const patchedStatus = patchOrcaMuseSparkDisplayName(status);
  assert.ok(patchedStatus.includes("workingLabel:`Muse Spark`"));
  assert.ok(patchedStatus.includes("permissionLabel:`Muse Spark - action required`"));
  assert.ok(patchedStatus.includes("idleLabel:`Muse Spark ready`"));

  const reverse = "    OpenCode: 'opencode',\n    'MiMo Code': 'mimo-code',";
  const patchedReverse = patchOrcaMuseSparkDisplayName(reverse);
  assert.ok(patchedReverse.includes("OpenCode: 'opencode', 'Muse Spark': 'opencode'"));
  const reverseMin = 'OpenCode:`opencode`,"MiMo Code":`mimo-code`';
  assert.ok(
    patchOrcaMuseSparkDisplayName(reverseMin).includes('OpenCode:`opencode`,"Muse Spark":`opencode`'),
  );

  const locale = '{"catalog":{"e7a4ca5103":"OpenCode","760bc6883d":"Codex"}}';
  assert.ok(patchOrcaMuseSparkDisplayName(locale).includes('"e7a4ca5103":"Muse Spark"'));

  // Non-labels untouched: identifiers, commands, worker messages, Go strings.
  const untouched = [
    "function isOpenCodeNativeTitle(title) {}",
    "exports.capOpenCodeHookText = capOpenCodeHookText;",
    'require("./opencode-terminal-title")',
    "detectCmd: 'opencode'",
    "`OpenCode SQLite worker exited with code ${e}`",
    '"OpenCodeUsagePane"',
    '"OpenCode Go"',
    "// Why: OpenCode owns semantic OSC session titles",
    "'OpenCode DeepSeek V4 Flash Free'",
  ].join("\n");
  assert.equal(patchOrcaMuseSparkDisplayName(untouched), untouched);

  // Idempotent: a second application changes nothing.
  for (const sample of [displayMap, commitSpec, chunk, status, reverse, reverseMin, locale]) {
    const once = patchOrcaMuseSparkDisplayName(sample);
    assert.equal(patchOrcaMuseSparkDisplayName(once), once);
  }
  assert.equal(patchOrcaMuseSparkDisplayName(""), "");
  assert.equal(patchOrcaMuseSparkDisplayName(undefined), "");
  assert.equal(patchOrcaMuseSparkDisplayName(null), "");
}

// 16. resolveOrcaOutDir discovers the unpacked tree from a home dir only.
{
  const fakeHome = mkdtempSync(join(tmpdir(), "architect-orca-resolve-home-"));
  try {
    assert.equal(resolveOrcaOutDir(fakeHome), null);
    const resDir = join(fakeHome, "fake-orca", "resources");
    const binFile = join(resDir, "bin", "orca-ide");
    mkdirSync(join(resDir, "bin"), { recursive: true });
    writeFileSync(binFile, "#!/bin/sh\n");
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
    symlinkSync(binFile, join(fakeHome, ".local", "bin", "orca"));
    // Bin link present but no unpacked tree yet: still null.
    assert.equal(resolveOrcaOutDir(fakeHome), null);
    const outDir = join(resDir, "app.asar.unpacked", "out");
    mkdirSync(outDir, { recursive: true });
    assert.equal(resolveOrcaOutDir(fakeHome), outDir);
    // orca-ide-only install resolves too.
    rmSync(join(fakeHome, ".local", "bin", "orca"));
    symlinkSync(binFile, join(fakeHome, ".local", "bin", "orca-ide"));
    assert.equal(resolveOrcaOutDir(fakeHome), outDir);
    // Chained orca -> orca-ide -> install (mirrors the real layout).
    symlinkSync(join(fakeHome, ".local", "bin", "orca-ide"), join(fakeHome, ".local", "bin", "orca"));
    assert.equal(resolveOrcaOutDir(fakeHome), outDir);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// 17. ensureOrcaMuseSparkDisplay patches staged bundles, ignores the rest.
{
  const outDir = mkdtempSync(join(tmpdir(), "architect-orca-out-"));
  try {
    const shared = join(outDir, "shared");
    const chunks = join(outDir, "main", "chunks");
    mkdirSync(shared, { recursive: true });
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(shared, "tui-agent-display-names.js"), "exports.X = {\n    opencode: 'OpenCode',\n};\n");
    writeFileSync(
      join(shared, "commit-message-agent-specs-primary.js"),
      "opencode: {\n    id: 'opencode',\n    label: 'OpenCode',\n    binary: 'opencode',\n}\n",
    );
    writeFileSync(join(chunks, "tui-agent-display-names-HASH.js"), "const e={opencode:`OpenCode`,pi:`Pi`};\n");
    writeFileSync(join(chunks, "notes.txt"), "opencode: 'OpenCode'\n");
    writeFileSync(join(shared, "unrelated.js"), "const x = 1;\n");
    const logs = [];
    const first = ensureOrcaMuseSparkDisplay(outDir, { log: (m) => logs.push(m) });
    assert.equal(first.scanned, 4);
    assert.equal(first.patched.length, 3);
    assert.ok(
      readFileSync(join(shared, "tui-agent-display-names.js"), "utf8").includes("opencode: 'Muse Spark'"),
    );
    const spec = readFileSync(join(shared, "commit-message-agent-specs-primary.js"), "utf8");
    assert.ok(spec.includes("label: 'Muse Spark'"));
    assert.ok(spec.includes("binary: 'opencode'"));
    assert.ok(
      readFileSync(join(chunks, "tui-agent-display-names-HASH.js"), "utf8").includes(
        "opencode:`Muse Spark`",
      ),
    );
    assert.equal(readFileSync(join(chunks, "notes.txt"), "utf8"), "opencode: 'OpenCode'\n");
    assert.ok(logs.some((line) => line.includes("Patched Orca Muse Spark display name")));
    const second = ensureOrcaMuseSparkDisplay(outDir, { log: () => {} });
    assert.equal(second.scanned, 4);
    assert.equal(second.patched.length, 0);
    assert.deepEqual(ensureOrcaMuseSparkDisplay(join(outDir, "missing")).patched, []);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// 18. installAgents end-to-end with a staged fake Orca: alias plus display
// patch in one run, rerun is a no-op, explicit orcaOutDir wins, and homes
// without Orca stay silent.
{
  const testHome = mkdtempSync(join(tmpdir(), "architect-orca-e2e-home-"));
  try {
    const resDir = join(testHome, "fake-orca", "resources");
    const shared = join(resDir, "app.asar.unpacked", "out", "shared");
    mkdirSync(join(resDir, "bin"), { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(resDir, "bin", "orca-ide"), "#!/bin/sh\n");
    mkdirSync(join(testHome, ".local", "bin"), { recursive: true });
    symlinkSync(join(resDir, "bin", "orca-ide"), join(testHome, ".local", "bin", "orca"));
    writeFileSync(join(shared, "tui-agent-display-names.js"), "exports.X = { opencode: 'OpenCode' };\n");
    const logs = [];
    const result = await installAgents({ home: testHome, xdgConfigHome: "", repoRoot, log: (m) => logs.push(m) });
    assert.equal(result.orcaOutDir, join(resDir, "app.asar.unpacked", "out"));
    assert.ok(
      readFileSync(join(shared, "tui-agent-display-names.js"), "utf8").includes("opencode: 'Muse Spark'"),
    );
    assert.ok(lstatSync(join(testHome, ".local", "bin", "opencode")).isSymbolicLink());
    assert.equal(readlinkSync(join(testHome, ".local", "bin", "opencode")), shimPath);
    assert.ok(logs.some((line) => line.includes("Patched Orca Muse Spark display name")));
    const rerunLogs = [];
    await installAgents({ home: testHome, xdgConfigHome: "", repoRoot, log: (m) => rerunLogs.push(m) });
    assert.ok(rerunLogs.some((line) => line.includes("already current")));
    assert.ok(rerunLogs.some((line) => line.includes("opencode alias already installed")));
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }

  const optHome = mkdtempSync(join(tmpdir(), "architect-orca-opt-home-"));
  const optOut = mkdtempSync(join(tmpdir(), "architect-orca-opt-out-"));
  try {
    writeFileSync(join(optOut, "tui-agent-display-names.js"), "exports.X = { opencode: 'OpenCode' };\n");
    const result = await installAgents({
      home: optHome,
      xdgConfigHome: "",
      repoRoot,
      orcaOutDir: optOut,
      log: () => {},
    });
    assert.equal(result.orcaOutDir, optOut);
    assert.ok(
      readFileSync(join(optOut, "tui-agent-display-names.js"), "utf8").includes("'Muse Spark'"),
    );

    const bareHome = mkdtempSync(join(tmpdir(), "architect-orca-bare-home-"));
    try {
      const logs = [];
      const bare = await installAgents({ home: bareHome, xdgConfigHome: "", repoRoot, log: (m) => logs.push(m) });
      assert.equal(bare.orcaOutDir, null);
      assert.ok(!logs.some((line) => line.includes("Muse Spark display name")));
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(optHome, { recursive: true, force: true });
    rmSync(optOut, { recursive: true, force: true });
  }
}

console.log("Install tests passed cleanly.");
