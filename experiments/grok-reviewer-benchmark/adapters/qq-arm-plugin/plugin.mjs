/** Experiment-only binding of DSH headless to the production Mini QA preset. */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eventCount, usageFrom } from "./usage.mjs";

export const name = "qq-benchmark-mini-qa";
export const inject = ["agents"];

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`qq benchmark plugin requires ${name}`);
  return value;
};
const toolSource = resolve(required("BENCH_TOOL_SOURCE"));
const [mini, oracleModule, isolation, approval] = await Promise.all([
  import(pathToFileURL(join(toolSource, "src/mini-qa.mjs"))),
  import(pathToFileURL(join(toolSource, "src/repo-oracle.mjs"))),
  import(pathToFileURL(join(toolSource, "src/child-isolation.mjs"))),
  import(pathToFileURL(join(toolSource, "src/approval-policy.mjs"))),
]);

function normalizedFinding(finding) {
  return {
    path: finding.path,
    line: finding.line,
    body: finding.body,
    severity: null,
    confidence: null,
    blocks_merge: true,
  };
}

export function apply(ctx) {
  const repository = resolve(required("BENCH_REPOSITORY"));
  const base = required("BENCH_BASE");
  const head = required("BENCH_HEAD");
  const resultPath = resolve(required("BENCH_RESULT_PATH"));
  let pending = null;
  let wrote = false;

  const createdOff = ctx.on("agent/created", ({ agent } = {}) => {
    if (!agent || wrote) return;
    mini.miniQaSetup(agent.ctx ?? agent);
    approval.pinNonInteractiveApproval(agent, { delegated: true });
    isolation.pinChildSandbox(agent, "qa");
    isolation.assertChildSandbox(agent, "qa");
    const oracle = new oracleModule.RepoOracle(base, head, { gitDir: join(repository, ".git") });
    mini.bindMiniQaSubmit(agent, {
      oracle,
      isCompleted: () => pending !== null,
      submit: async ({ verdict, findings }) => {
        pending = { verdict, findings };
        return {
          status: "ok",
          verdict: verdict.verdict,
          outcome: findings.length ? "review failed" : "review passed",
        };
      },
    });
    mini.bindMiniShellIsolation(agent, (command) => isolation.isolatedShellCommand({
      workspace: repository,
      worktree: repository,
      command,
      writable: false,
      env: process.env,
    }));
    // Preserve the durable session identity for raw audit artifacts.
    writeFileSync(join(resolve(required("BENCH_OUTPUT_DIR")), "session-id.txt"), `${agent.session.id}\n`, { mode: 0o600 });
  });

  const eventOff = ctx.on("session/event", (session, event) => {
    if (wrote || !pending || event?.type !== "turn/end") return;
    wrote = true;
    const native = usageFrom(session.events);
    if (native.requestCount < 1 || native.responseModels.some((model) => model !== "grok-4.6")) {
      throw new Error("qq Mini QA session did not prove exact grok-4.6 responses");
    }
    const events = session.events;
    const failures = eventCount(events, (item) => item.type === "turn/end" && item.data?.reason?.kind === "error");
    const retries = eventCount(events, (item) => /retry/i.test(item.type));
    const truncationEvents = eventCount(events, (item) => /truncat|max.?tokens/i.test(item.type)
      || item.type === "turn/end" && /max.?tokens/i.test(String(item.data?.reason?.kind ?? "")));
    const contextEvents = eventCount(events, (item) => /compact|context/i.test(item.type));
    const findings = pending.findings.map(normalizedFinding);
    const payload = {
      schema: "qq.grok-reviewer-arm-result/v1",
      arm_id: required("BENCH_ARM_ID"),
      case_id: required("BENCH_CASE_ID"),
      model: required("BENCH_CLIENT_MODEL"),
      provider_model: required("BENCH_PROVIDER_MODEL"),
      mode: { reviewer: "current-production", bash: true, publishing: false },
      effective_config: {
        provider: "xai-auth",
        model: "grok-4.6",
        reasoning_effort: "high",
        temperature: null,
        max_output_tokens: null,
        prompt: "production-mini-qa",
        shell_isolation: "production-read-only-bwrap",
      },
      verdict: findings.length ? "fail" : "pass",
      findings,
      usage: { host_captured: native.usage },
      telemetry: {
        request_count: native.requestCount,
        retries,
        failures,
        truncation_events: truncationEvents,
        context_events: contextEvents,
      },
      isolation: { prior_findings_visible: false, publishing: false },
      provider_evidence: {
        request_models: native.requestModels,
        response_models: native.responseModels,
      },
    };
    writeFileSync(resultPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(resolve(required("BENCH_OUTPUT_DIR")), "session-events.json"), `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 });
  });
  return () => {
    createdOff?.();
    eventOff?.();
  };
}
