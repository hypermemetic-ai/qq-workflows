#!/usr/bin/env node
// Offline tests for the DeepSeek Minimal harness promotion: the central
// harness selector, the documented Messages endpoint mapping, the output-token
// setting, the production launch spec, and the adapter's fail-closed
// boundaries. Nothing here boots the pinned runtime; the runtime acceptance
// suite lives in prototype/deepseek-minimal/tests (t7/t8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WORKER_SEATS,
  buildWorkerLaunch,
  deepSeekMinimalRuntimeRoot,
  loadWorkerConfig,
  resolveMessagesBaseUrl,
  validateWorkerConfig,
  WORKER_MESSAGES_BASE_URL,
  WORKER_MAX_OUTPUT_TOKENS_MAX,
  WORKER_DEEPSEEK_ADAPTER,
} from "../workflow/worker-config.mjs";
import {
  GATEWAY_ENV_DEFAULTS,
  assertSearchArtifacts,
  harnessEnv,
  resolveSearchBinding,
  runtimeLayout,
} from "../prototype/deepseek-minimal/adapter/runtime.mjs";
import {
  PUBLIC_TOOL_NAME,
  SEARCH_SEATS,
  SERVER_NAME,
  TOOL_NAME,
  modelFacingDescription,
  modelFacingTool,
  readSearchToolSnapshot,
} from "../prototype/deepseek-minimal/gateway/zvec-grep-tool.mjs";
import { resolveRunnerTransport } from "../prototype/deepseek-minimal/adapter/worker.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-deepseek-minimal-"));
const ADAPTER = WORKER_DEEPSEEK_ADAPTER;
const BASE = {
  provider: "deepseek",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
  wire_api: "responses",
  env_key: "DEEPSEEK_API_KEY",
  api_key_file: join(root, "missing-key-file"),
};

function writeConfig(name, extra) {
  const file = join(root, `config-${name}.json`);
  writeFileSync(file, JSON.stringify({ ...BASE, ...extra }));
  return file;
}

// 1. Harness selector: absence is codex (compatibility + rollback), the
// deepseek-minimal selection is accepted, and anything else fails closed.
{
  assert.equal(validateWorkerConfig(BASE).harness, "codex", "absence must remain codex");
  assert.equal(validateWorkerConfig({ ...BASE, harness: "codex" }).harness, "codex");
  assert.equal(validateWorkerConfig({ ...BASE, harness: " DeepSeek-Minimal " }).harness, "deepseek-minimal");
  assert.equal(validateWorkerConfig({ ...BASE, harness_type: "deepseek-minimal" }).harness, "deepseek-minimal");
  for (const bad of ["dsh", "minimal", "", 3, true]) {
    assert.throws(() => validateWorkerConfig({ ...BASE, harness: bad }), /harness/u, `harness ${JSON.stringify(bad)} must be rejected`);
  }
  // Rollback gate: the default selection still emits the Codex argv verbatim.
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), DEEPSEEK_API_KEY: "k" };
  for (const key of ["QQ_WORKER_CODEX_HOME", "QQ_SUBAGENT_BIN", "QQ_RUNNER_ID", "QQ_RUNNER_RESULT_FILE"]) delete env[key];
  const codex = buildWorkerLaunch({ seat: "reviewer", cwd: root, prompt: "x", env, config: BASE });
  assert.equal(codex.args[0], "exec", "the default harness must remain Codex");
  assert.ok(codex.args.join(" ").includes('model_provider="deepseek"'));
}

// 2. Messages endpoint mapping: the official Responses base maps to the
// documented DSH Messages root exactly once, and nothing routes silently.
{
  assert.equal(WORKER_MESSAGES_BASE_URL, "https://api.deepseek.com/anthropic");
  for (const input of [
    "https://api.deepseek.com",
    "https://api.deepseek.com/",
    "https://api.deepseek.com/anthropic",
    "https://api.deepseek.com/anthropic/",
    "https://api.deepseek.com/anthropic/v1",
  ]) {
    assert.equal(resolveMessagesBaseUrl(input), WORKER_MESSAGES_BASE_URL, `${input} must map to the documented Messages root`);
  }
  assert.equal(
    validateWorkerConfig({ ...BASE, harness: "deepseek-minimal" }).messagesBaseUrl,
    WORKER_MESSAGES_BASE_URL,
  );
  for (const bad of [
    "https://api.deepseek.com/anthropic/v1/messages",
    "https://api.deepseek.com/other",
    "https://api.deepseek.com/anthropic/extra",
    "https://proxy.example.com",
    "http://api.deepseek.com",
    "ftp://api.deepseek.com",
    "https://user:pass@api.deepseek.com",
    "https://api.deepseek.com?x=1",
  ]) {
    assert.throws(
      () => validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", base_url: bad }),
      /DeepSeek Messages|must be an http\(s\)|without credentials|\/messages endpoint|official DeepSeek host/u,
      `base_url ${bad} must be rejected rather than routed silently`,
    );
  }
  // An explicit override is honored (validated), including a loopback test root.
  assert.equal(
    validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", messages_base_url: "http://127.0.0.1:8123" }).messagesBaseUrl,
    "http://127.0.0.1:8123",
  );
  assert.equal(
    validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", base_url: "https://proxy.example.com", messages_base_url: "https://proxy.example.com/anthropic/v1" }).messagesBaseUrl,
    "https://proxy.example.com/anthropic/v1",
    "an explicit non-official root keeps its own version path (the harness never doubles it)",
  );
  assert.equal(
    validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", base_url: "https://proxy.example.com", messages_base_url: "https://proxy.example.com/anthropic/v1/v1" }).messagesBaseUrl,
    "https://proxy.example.com/anthropic/v1",
    "a duplicated /v1 segment collapses rather than being passed through",
  );
  assert.throws(
    () => validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", messages_base_url: "https://api.deepseek.com/anthropic/v1/messages" }),
    /not a \/messages endpoint/u,
  );
  // The pinned sdk-minimal bundle fixes apiKeyEnv; a different name fails closed.
  assert.throws(
    () => validateWorkerConfig({ ...BASE, harness: "deepseek-minimal", env_key: "OTHER_API_KEY" }),
    /apiKeyEnv: 'DEEPSEEK_API_KEY'/u,
  );
}

// 3. Output-token setting: optional, validated, never silently defaulted.
{
  assert.equal(validateWorkerConfig(BASE).maxOutputTokens, null, "unset must stay unset (upstream default applies)");
  assert.equal(validateWorkerConfig({ ...BASE, max_output_tokens: 2048 }).maxOutputTokens, 2048);
  assert.equal(validateWorkerConfig({ ...BASE, maxOutputTokens: WORKER_MAX_OUTPUT_TOKENS_MAX }).maxOutputTokens, WORKER_MAX_OUTPUT_TOKENS_MAX);
  for (const bad of [0, -1, 1.5, "2048", Number.MAX_SAFE_INTEGER, WORKER_MAX_OUTPUT_TOKENS_MAX + 1, true, []]) {
    assert.throws(() => validateWorkerConfig({ ...BASE, max_output_tokens: bad }), /max_output_tokens/u, `max_output_tokens ${JSON.stringify(bad)} must be rejected`);
  }
}

// 4. Production launch spec: every seat launches the adapter with an explicit
// seat and no Codex argv, and the credential never rides in argv.
{
  const configFile = writeConfig("launch", { harness: "deepseek-minimal", reasoning_effort: "max", max_output_tokens: 2048 });
  const env = {
    ...process.env,
    QQ_WORKER_CONFIG_FILE: configFile,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    DEEPSEEK_API_KEY: "sentinel-deepseek-key",
    CODEX_HOME: "/outer/codex-home-must-not-leak",
    QQ_WORKER_CODEX_HOME: join(root, "codex-home"),
    QQ_RUNNER_ID: "outer-runner-must-not-leak",
    QQ_RUNNER_RESULT_FILE: "/tmp/outer-must-not-leak.json",
    QQ_SUBAGENT_BIN: "/usr/bin/false",
  };
  const runtimeRoot = join(root, "runtime-root");
  env.QQ_DEEPSEEK_RUNTIME_ROOT = runtimeRoot;
  // Hermetic isolation: this suite may itself run inside a seat that carries a
  // live zvec-grep gateway binding. The parent launch spec must never ADD one,
  // and must never inherit one into a seat launch either, so the fixture env
  // starts without them and the assertions below stay meaningful.
  for (const key of Object.keys(env)) {
    if (key.startsWith("QQ_ZVEC_GREP_")) delete env[key];
  }
  const resolved = loadWorkerConfig({ env, file: configFile });
  assert.deepEqual(resolved.messagesBaseUrl, WORKER_MESSAGES_BASE_URL);
  assert.equal(resolved.maxOutputTokens, 2048);
  assert.equal(resolved.reasoningEffort, "max");

  const runnerId = "offline-runner-1";
  const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
  for (const seat of WORKER_SEATS) {
    const launch = buildWorkerLaunch({
      seat, cwd: root, prompt: "hi", env, config: resolved,
      mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
    });
    assert.equal(launch.harness, "deepseek-minimal");
    assert.equal(launch.bin, process.execPath, "the adapter runs under this node");
    assert.equal(launch.args[0], ADAPTER);
    assert.equal(launch.args[1], "--production", "production mode must be explicit");
    const argv = launch.args.join(" ");
    assert.ok(argv.includes(`--seat ${seat}`), `${seat} must carry an explicit --seat`);
    assert.ok(argv.includes(`--runtime-root ${runtimeRoot}`), "the shared runtime root must be passed");
    assert.doesNotMatch(argv, /(^|\s)exec(\s|$)/, "the adapter argv must not be Codex argv");
    assert.doesNotMatch(argv, /model_provider|wire_api|mcp_servers/u);
    assert.ok(!launch.args.some((arg) => arg.includes("sentinel-deepseek-key")), "the key must never enter argv");
    assert.deepEqual(launch.tools, [], "the harness exposes no parent MCP tool");
    assert.equal(launch.env.DEEPSEEK_API_KEY, "sentinel-deepseek-key", "the resolved credential reaches the adapter");
    assert.equal(launch.env.CODEX_HOME, undefined, "the Codex home must not leak into the harness");
    assert.equal(launch.env.QQ_WORKER_CODEX_HOME, undefined);
    assert.equal(launch.env.QQ_DEEPSEEK_RUNTIME_ROOT, runtimeRoot);
    assert.equal(launch.env.QQ_WORKER_CONFIG_FILE, configFile, "the adapter re-reads the same central config");
    assert.equal(launch.env.CODEX_THREAD_ID, undefined);
    if (seat === "runner") {
      assert.equal(launch.env.QQ_RUNNER_ID, runnerId, "the runner keeps its own identity");
      assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, resultFile, "the runner needs its transport path");
      assert.notEqual(launch.env.QQ_RUNNER_ID, "outer-runner-must-not-leak");
    } else {
      assert.equal(launch.env.QQ_RUNNER_ID, undefined, `${seat} must not inherit a runner identity`);
      assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, undefined, `${seat} must not inherit a transport path`);
    }
    // The seat-scoped search overlay is resolved by the ADAPTER, from the
    // materialized runtime root and the seat's own cwd: the parent launch spec
    // carries neither the overlay patch nor a bound search root, so no caller
    // above the adapter can widen the surface or redirect the bound root.
    assert.ok(!launch.args.includes("--patch"), `${seat}: the overlay is the adapter's business, never the parent's`);
    assert.equal(launch.env.QQ_ZVEC_GREP_ROOT, undefined, `${seat}: the parent must not bind a search root`);
    assert.equal(launch.env.QQ_ZVEC_GREP_BIN, undefined, `${seat}: the parent must not choose the zg binary`);
  }
  // Runner seat without a bound identity fails closed at the launch boundary.
  assert.throws(
    () => buildWorkerLaunch({ seat: "runner", cwd: root, prompt: "hi", env, config: resolved }),
    /bound runner identity/u,
  );
  assert.throws(
    () => buildWorkerLaunch({ seat: "runner", cwd: root, prompt: "hi", env, config: resolved, mcpEnv: { QQ_RUNNER_ID: runnerId } }),
    /explicit result transport path/u,
  );
}

// 4b. Seat-scoped search binding (pure, offline): only the implementer and
// reviewer seats bind, the root is the seat's own worktree, and a runtime root
// that cannot mount the gateway fails closed with an actionable diagnostic -
// dsh reports a failed plugin row as a warning, so this check is what keeps a
// silently search-less seat from ever starting.
{
  assert.deepEqual([...SEARCH_SEATS].sort(), ["implementer", "reviewer"], "only the two search seats are in scope");
  assert.equal(TOOL_NAME, "zvec_grep_search", "the raw upstream name that goes on the wire");
  assert.equal(`mcp__${SERVER_NAME}__${TOOL_NAME}`, PUBLIC_TOOL_NAME, "the bridge's server-qualified composition");
  assert.equal(PUBLIC_TOOL_NAME, "mcp__zvec_grep__zvec_grep_search", "the qualified model-facing name");

  const worktree = join(root, "search-worktree");
  mkdirSync(worktree, { recursive: true });
  for (const seat of WORKER_SEATS) {
    const binding = resolveSearchBinding(seat, worktree);
    if (seat === "runner") assert.equal(binding, null, "the runner seat never binds search");
    else assert.deepEqual(binding, { root: worktree, seat }, `${seat} must bind its own worktree`);
  }
  assert.throws(() => resolveSearchBinding("implementer", undefined), /requires an explicit worktree cwd/u);
  assert.throws(() => resolveSearchBinding("reviewer", join(root, "no-such-worktree")), /not an existing directory/u);
  assert.throws(() => resolveSearchBinding("implementer", join(root, "config-launch.json")), /not an existing directory/u);

  // The model-facing description is the pinned snapshot's OWN text: only the
  // documented hidden-root adaptation may differ, and a snapshot that loses the
  // reviewed wording must fail closed instead of publishing unreviewed prose.
  const snapshot = readSearchToolSnapshot();
  const officialDescription = snapshot.tool.description;
  const adaptedDescription = modelFacingDescription(snapshot.tool);
  assert.equal(
    adaptedDescription,
    officialDescription.replace("Search an existing workspace index", "Search the bound worktree's index"),
    "the description must be the official text with only the hidden-root reference adapted",
  );
  for (const sentence of [
    "Use it when exact lookup alone cannot answer a workspace-grounded question.",
    "Read freshness and background_refresh from the response without a status preflight; when results are served_from_current_index, use them if sufficient.",
  ]) {
    assert.ok(
      officialDescription.includes(sentence) && adaptedDescription.includes(sentence),
      `the official sentence must be retained verbatim: ${sentence}`,
    );
  }
  assert.doesNotMatch(adaptedDescription, /CURRENT WORKTREE|No matches\./u, "no authored prose may be published");
  assert.equal(modelFacingTool(snapshot.tool).description, adaptedDescription, "the tool definition must publish the official description");
  assert.throws(() => modelFacingDescription({}), /description is missing/u, "a snapshot without the official description must fail closed");
  assert.throws(
    () => modelFacingDescription({ description: "Search something else." }),
    /refresh the gateway snapshot/u,
    "unreviewed upstream wording must fail closed",
  );

  // A materialized layout passes; each reviewed artifact is load-bearing.
  const fixtureRoot = join(root, "gateway-fixture");
  const layout = {
    root: fixtureRoot,
    gateway: join(fixtureRoot, "gateway"),
    searchOverlay: join(fixtureRoot, "profile", "zvec-grep-gateway.patch.yml"),
    profileDir: join(fixtureRoot, "dsh-home", "profiles", "sdk-minimal"),
  };
  const artifacts = [
    join(layout.gateway, "zvec-grep-gateway.mjs"),
    join(layout.gateway, "zvec-grep-tool.mjs"),
    join(layout.gateway, "zvec-grep-search.tool.json"),
    join(layout.gateway, "node_modules", "@modelcontextprotocol", "server"),
    join(layout.gateway, "node_modules", "@modelcontextprotocol", "client"),
    layout.searchOverlay,
    join(layout.profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client"),
  ];
  assert.throws(() => assertSearchArtifacts(layout), /zvec-grep search gateway is not materialized/u, "a root with no gateway must fail closed");
  for (const artifact of artifacts) {
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "");
  }
  assert.equal(assertSearchArtifacts(layout), layout, "a fully materialized root passes");
  for (const artifact of artifacts) {
    const backup = `${artifact}.bak`;
    renameSync(artifact, backup);
    assert.throws(
      () => assertSearchArtifacts(layout),
      (error) => /zvec-grep search gateway is not materialized/u.test(error.message)
        && error.message.includes("setup-runtime.mjs")
        && error.message.length < 400,
      `a root missing ${artifact} must fail closed with a bounded, actionable diagnostic`,
    );
    renameSync(backup, artifact);
  }
}

// 5. Adapter fail-closed boundaries (no runtime, no provider contact needed).
{
  const run = (args, env = {}) => {
    const childEnv = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), ...env };
    for (const key of ["QQ_RUNNER_ID", "QQ_RUNNER_RESULT_FILE", "QQ_RUNNER_MARKER_FILE", "DEEPSEEK_API_KEY"]) delete childEnv[key];
    for (const [k, v] of Object.entries(env)) childEnv[k] = v;
    return spawnSync(process.execPath, [ADAPTER, ...args], { encoding: "utf8", env: childEnv, timeout: 30_000 });
  };
  const cases = [
    { label: "no --seat", args: ["--production", "--cwd", root, "--prompt", "p"], code: /seat_required/u },
    {
      // The retired researcher seat is refused outright, never aliased onto the
      // runner, even with a valid config and a production credential present.
      label: "retired researcher seat",
      args: ["--production", "--seat", "researcher", "--cwd", root, "--prompt", "p"],
      env: { DEEPSEEK_API_KEY: "sentinel-deepseek-key" },
      code: /--seat must be one of runner, implementer, reviewer \(got "researcher"\)/u,
    },
    { label: "runner without identity", args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "p"], code: /runner_identity_required/u },
    {
      label: "runner without transport",
      args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "p"],
      env: { QQ_RUNNER_ID: "r-offline" },
      code: /runner_transport_required/u,
    },
    {
      label: "runner with a non-shared transport",
      args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "p"],
      env: { QQ_RUNNER_ID: "r-offline", QQ_RUNNER_RESULT_FILE: "/qq-transport-not-in-tmp/qq-runner-result-r-offline.json" },
      code: /outside the shared os\.tmpdir\(\) transport root/u,
    },
    {
      label: "production with a mock-only flag",
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "p", "--base-url", "http://127.0.0.1:9"],
      code: /mock-only flag/u,
    },
    { label: "mock without an endpoint", args: ["--seat", "implementer", "--cwd", root, "--prompt", "p"], code: /mock mode requires --base-url/u },
  ];
  for (const { label, args, env, code } of cases) {
    const result = run(args, env);
    assert.notEqual(result.status, 0, `${label} must fail closed`);
    assert.equal(result.stdout, "", `${label} must not emit protocol lines`);
    assert.match(result.stderr, code, `${label} diagnostic`);
    assert.ok(result.stderr.length < 600, `${label} diagnostic must be bounded`);
  }
}

// 6. Runner transport resolution is the shared os.tmpdir() location only.
{
  const runnerId = "offline-transport";
  assert.deepEqual(resolveRunnerTransport({ QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: join(tmpdir(), `qq-runner-result-${runnerId}.json`) }), {
    runnerId,
    resultFile: join(tmpdir(), `qq-runner-result-${runnerId}.json`),
  });
  // An explicit path inside the shared temp root (the prototype suite's own
  // temp workdirs) stays acceptable; anything outside it does not.
  const localPath = join(tmpdir(), "qq-runner-transport-subdir", `result-${runnerId}.json`);
  assert.equal(resolveRunnerTransport({ QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: localPath }).resultFile, localPath);
  for (const [env, pattern] of [
    [{ QQ_RUNNER_RESULT_FILE: "/tmp/x.json" }, /bound runner identity/u],
    [{ QQ_RUNNER_ID: runnerId }, /explicit QQ_RUNNER_RESULT_FILE/u],
    [{ QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: "relative/x.json" }, /must be absolute/u],
    [{ QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: "/qq-transport-not-in-tmp/qq-runner-result-offline.json" }, /outside the shared os\.tmpdir\(\)/u],
  ]) {
    assert.throws(() => resolveRunnerTransport(env), pattern);
  }
}

// 7. Harness child environment separation: production refuses dummy auth, mock
// never receives a real credential, and both scrub inherited secrets.
{
  const runtime = (mode) => ({ mode, dshHome: join(root, "dsh"), instructions: "seat instructions", endpoint: "http://127.0.0.1:9" });
  const inherited = {
    HOME: root,
    DEEPSEEK_API_KEY: "operator-real-key",
    OPENAI_API_KEY: "another-secret",
    GITHUB_TOKEN: "token-value",
    QQ_RUNNER_ID: "outer-runner",
    QQ_RUNNER_RESULT_FILE: "/tmp/outer.json",
    QQ_WORKER_CONFIG_FILE: "/tmp/worker-config.json",
    QQ_IMPLEMENTER_PROVIDER: "gemini",
    CODEX_THREAD_ID: "thread",
    PATH: process.env.PATH,
  };
  const mockEnv = harnessEnv({ env: inherited, runtime: runtime("mock") });
  assert.equal(mockEnv.DEEPSEEK_API_KEY, "prototype-dummy-key", "mock mode must present only the dummy credential");
  assert.equal(mockEnv.OPENAI_API_KEY, undefined);
  assert.equal(mockEnv.GITHUB_TOKEN, undefined);
  assert.equal(mockEnv.QQ_RUNNER_ID, undefined);
  assert.equal(mockEnv.QQ_RUNNER_RESULT_FILE, undefined);
  assert.equal(mockEnv.QQ_WORKER_CONFIG_FILE, undefined);
  assert.equal(mockEnv.QQ_IMPLEMENTER_PROVIDER, undefined);
  assert.equal(mockEnv.CODEX_THREAD_ID, undefined);
  assert.equal(mockEnv.DSH_HOME, join(root, "dsh"));
  assert.equal(mockEnv.PATH, process.env.PATH, "the child still runs normally");
  assert.throws(() => harnessEnv({ env: inherited, runtime: runtime("production") }), /requires a resolved provider credential/u);
  const productionEnv = harnessEnv({ env: inherited, runtime: runtime("production"), apiKey: "production-key" });
  assert.equal(productionEnv.DEEPSEEK_API_KEY, "production-key");
  assert.equal(productionEnv.DEEPSEEK_BASE_URL, "http://127.0.0.1:9");
  // A non-search seat binds no search environment at all.
  assert.equal(mockEnv.QQ_ZVEC_GREP_ROOT, undefined);
  assert.equal(mockEnv.QQ_ZVEC_GREP_SEAT, undefined);

  // A search seat carries exactly the bound root, the seat, the binary, and the
  // bounded budgets - nothing about the model can widen them.
  const searchRuntime = { ...runtime("mock"), search: { root, seat: "implementer" } };
  const searchEnv = harnessEnv({ env: inherited, runtime: searchRuntime });
  assert.equal(searchEnv.QQ_ZVEC_GREP_ROOT, root, "the bound root must be the runtime's own binding");
  assert.equal(searchEnv.QQ_ZVEC_GREP_SEAT, "implementer");
  assert.equal(searchEnv.QQ_ZVEC_GREP_BIN, GATEWAY_ENV_DEFAULTS.QQ_ZVEC_GREP_BIN);
  assert.deepEqual(Object.keys(GATEWAY_ENV_DEFAULTS).sort(), [
    "QQ_ZVEC_GREP_BIN",
    "QQ_ZVEC_GREP_INDEX_TIMEOUT_MS",
    "QQ_ZVEC_GREP_RECONCILE_ATTEMPTS",
    "QQ_ZVEC_GREP_RECONCILE_DELAY_MS",
    "QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS",
  ]);
  for (const [name, fallback] of Object.entries(GATEWAY_ENV_DEFAULTS)) {
    assert.equal(searchEnv[name], fallback, `${name} must default to the reviewed default`);
  }
  // The operator may point the gateway at a different zg binary; nothing else
  // is inherited from the ambient environment.
  const overridden = harnessEnv({ env: { ...inherited, QQ_ZVEC_GREP_BIN: "/opt/fake-zg" }, runtime: searchRuntime });
  assert.equal(overridden.QQ_ZVEC_GREP_BIN, "/opt/fake-zg");
  assert.equal(overridden.QQ_ZVEC_GREP_ROOT, root);
  assert.equal(mockEnv.DEEPSEEK_API_KEY, "prototype-dummy-key", "the search binding never touches the credential handling");
  const searchLayout = runtimeLayout({ runtimeRoot: join(root, "unused-root") });
  assert.equal(searchLayout.root, join(root, "unused-root"));
  assert.equal(searchLayout.gateway, join(root, "unused-root", "gateway"), "the gateway is root-bound, never repo-relative");
  assert.ok(!searchLayout.gateway.includes("prototype/deepseek-minimal/gateway"), "no checkout fallback may silently mount the gateway");
}

// 8. The runtime root is private and configurable, never inside a checkout.
{
  assert.equal(deepSeekMinimalRuntimeRoot({ HOME: root, QQ_DEEPSEEK_RUNTIME_ROOT: "/custom/root" }), "/custom/root");
  const stateDefault = deepSeekMinimalRuntimeRoot({ HOME: root, XDG_STATE_HOME: join(root, "state") });
  assert.equal(stateDefault, join(root, "state", "qq-workflows", "deepseek-minimal-runtime"));
  assert.equal(
    deepSeekMinimalRuntimeRoot({ HOME: root }),
    join(root, ".local", "state", "qq-workflows", "deepseek-minimal-runtime"),
  );
  assert.ok(!stateDefault.includes(".qq-worktrees"), "the runtime root must not be repo-relative");
}

rmSync(root, { recursive: true, force: true });
console.log("DeepSeek Minimal promotion (offline) tests passed cleanly.");
