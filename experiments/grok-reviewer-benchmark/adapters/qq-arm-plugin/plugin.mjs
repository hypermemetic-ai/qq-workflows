/** Experiment-only binding of DSH headless to the production Mini QA preset. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eventCount, providerAttempts, usageFrom } from "./usage.mjs";

export const name = "qq-benchmark-mini-qa";
export const inject = ["agents", "qq-core"];

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`qq benchmark plugin requires ${name}`);
  return value;
};
const toolSource = resolve(required("BENCH_TOOL_SOURCE"));
const [mini, officialMini, oracleModule, isolation, approval] = await Promise.all([
  import(pathToFileURL(join(toolSource, "src/mini-qa.mjs"))),
  import(pathToFileURL(join(toolSource, "src/official-mini.mjs"))),
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
  let dshSessionId = null;

  const createdOff = ctx.on("agent/created", ({ agent } = {}) => {
    if (!agent || wrote) return;
    const expectedSessionId = required("QQ_DSH_SESSION_ID");
    if (agent.session?.id !== expectedSessionId) {
      throw new Error("qq Mini QA DSH session identity differs from launcher environment");
    }
    dshSessionId = expectedSessionId;
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
    officialMini.bindMiniShellIsolation(agent, (command) => isolation.isolatedShellCommand({
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
    const outputDir = resolve(required("BENCH_OUTPUT_DIR"));
    const attempts = providerAttempts(readFileSync(join(outputDir, "qq-provider-attempts.jsonl"), "utf8"));
    if (attempts.length < native.requestCount) {
      throw new Error("qq provider attempt log has fewer HTTP attempts than completed model calls");
    }
    const events = session.events;
    const failures = attempts.filter((item) => !item.ok).length;
    const retries = attempts.length - native.requestCount;
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
        session_id: dshSessionId,
        temperature: null,
        max_output_tokens: null,
        prompt: "production-mini-qa",
        shell_isolation: "production-read-only-bwrap",
        provider_attempt_instrumentation: "trusted-fetch-status-only",
      },
      native_verdict: null,
      normalized_verdict: findings.length ? "fail" : "pass",
      verdict_source: "adapter_findings",
      findings,
      usage: { host_captured: native.usage },
      telemetry: {
        request_count: attempts.length,
        retries,
        failures,
        truncation_events: truncationEvents,
        context_events: contextEvents,
      },
      isolation: { prior_findings_visible: false, publishing: false },
      provider_evidence: {
        request_models: attempts.map((item) => item.model),
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
