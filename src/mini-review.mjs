import { randomUUID } from "node:crypto";

import { armChildSettlement, childToolOutput } from "./child-settlement.mjs";
import { createQaVerdict } from "./qa-verdict.mjs";
import {
  MINI_REVIEW_GLOB_SCHEMA,
  MINI_REVIEW_GREP_SCHEMA,
  MINI_REVIEW_KIND,
  MINI_REVIEW_SUBMIT_SCHEMA,
  MINI_REVIEW_SYSTEM_PROMPT,
  MINI_REVIEW_TOOL_NAMES,
  MINI_REVIEW_VIEW_SCHEMA,
  renderMiniReviewTask,
} from "./mini-review-v2.mjs";

export * from "./mini-review-v2.mjs";

export const MINI_REVIEW_PERSONA_SECTION = "deployment:persona";
export const MINI_REVIEW_PERSONA_ORDER = 0;

const MINI_REVIEW_BINDING = Symbol.for("qq.miniReviewBinding");
const MINI_REVIEW_COMPLETED = Symbol.for("qq.miniReviewCompleted");
const MINI_REVIEW_MOUNT = Symbol.for("qq.miniReviewMount");
const MOUNT_GENERATION = Object.freeze({});
const bindings = new WeakMap();
const completed = new WeakSet();
const consecutiveFormatErrors = new WeakMap();
const lastResponseHadTool = new WeakMap();

const FORMAT_ERROR = [
  "Tool call error:",
  "",
  "<error>",
  "Every response needs to use at least one review tool.",
  "</error>",
  "",
  "Use grep, glob, or view to inspect specific evidence, or finish with submit_review.",
].join("\n");

function textBlock(text) {
  return { type: "text", text: String(text ?? "") };
}

function keysOf(agent) {
  return [agent, agent?.session, agent?.ctx].filter((value) => value && typeof value === "object");
}

export function isMiniReviewAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_REVIEW_KIND || header?.agentPreset === MINI_REVIEW_KIND;
}

/** Bind one immutable look oracle and its durable verdict sink. */
export function bindMiniReviewSubmit(agent, oracleOrBinding, maybeSubmit) {
  if (!agent) throw new Error("mini-review binding requires an agent");
  const binding = typeof oracleOrBinding === "object" && oracleOrBinding?.oracle
    ? {
        oracle: oracleOrBinding.oracle,
        submit: oracleOrBinding.submit,
        isCompleted: oracleOrBinding.isCompleted,
      }
    : { oracle: oracleOrBinding, submit: maybeSubmit };
  if (!binding.oracle || typeof binding.submit !== "function") {
    throw new Error("mini-review binding requires an oracle and submit function");
  }
  const keys = keysOf(agent);
  for (const key of keys) {
    bindings.set(key, binding);
    try { key[MINI_REVIEW_BINDING] = binding; } catch { /* WeakMap fallback */ }
  }
  return () => {
    for (const key of keys) {
      if (bindings.get(key) === binding) bindings.delete(key);
      try {
        if (key[MINI_REVIEW_BINDING] === binding) key[MINI_REVIEW_BINDING] = undefined;
      } catch { /* frozen object */ }
    }
  };
}

function bindingFor(agent) {
  for (const key of keysOf(agent)) {
    const binding = key[MINI_REVIEW_BINDING] ?? bindings.get(key);
    if (binding?.oracle && typeof binding.submit === "function") return binding;
  }
  return null;
}

function markCompleted(agent) {
  if (agent && typeof agent === "object") completed.add(agent);
  for (const key of keysOf(agent)) {
    try { key[MINI_REVIEW_COMPLETED] = true; } catch { /* WeakSet fallback */ }
  }
}

function clearCompleted(agent) {
  if (agent && typeof agent === "object") completed.delete(agent);
  for (const key of keysOf(agent)) {
    try { key[MINI_REVIEW_COMPLETED] = undefined; } catch { /* WeakSet fallback */ }
  }
}

function isCompleted(agent) {
  if (completed.has(agent)) return true;
  return keysOf(agent).some((key) => key[MINI_REVIEW_COMPLETED] === true);
}

function bindingIsCompleted(binding, agent) {
  if (typeof binding?.isCompleted !== "function") return false;
  try {
    return binding.isCompleted(agent) === true;
  } catch {
    return false;
  }
}

function hasPersistedVerdict(agent) {
  return bindingIsCompleted(bindingFor(agent), agent);
}

function messageHasReviewTool(event) {
  if (event?.type !== "assistant/message") return undefined;
  const content = event?.data?.message?.content ?? event?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "tool-call" && MINI_REVIEW_TOOL_NAMES.includes(block?.name));
}

function installFormatRecovery(agentCtx) {
  if (typeof agentCtx?.on !== "function") return () => {};
  const offEvent = agentCtx.on("session/event", (session, event) => {
    if (!session || typeof session !== "object") return;
    const hadTool = messageHasReviewTool(event);
    if (hadTool === undefined) return;
    lastResponseHadTool.set(session, hadTool);
    if (hadTool) consecutiveFormatErrors.set(session, 0);
  });
  const offStopping = agentCtx.on("agent/turn-stopping", ({ agent }) => {
    if (!agent || isCompleted(agent) || hasPersistedVerdict(agent)) return;
    const key = agent.session ?? agent;
    if (lastResponseHadTool.get(key) === true) return;
    const count = (consecutiveFormatErrors.get(key) ?? 0) + 1;
    consecutiveFormatErrors.set(key, count);
    if (count >= 3 || typeof agent.steer !== "function") return;
    agent.steer({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: FORMAT_ERROR }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
  });
  return () => {
    try { offEvent?.(); } catch { /* best effort */ }
    try { offStopping?.(); } catch { /* best effort */ }
  };
}

export function reviewFindingsToVerdictInput(findings) {
  if (!Array.isArray(findings)) throw new Error("findings must be an array");
  if (findings.length === 0) {
    return {
      verdict: "pass",
      summary: "no defects introduced by this change",
      feedback: "",
      tests_modified: false,
    };
  }
  const feedback = findings.map((finding) => `${finding.path}:${finding.line}: ${finding.body}`).join("\n\n");
  return {
    verdict: "fail",
    summary: String(findings[0].body).slice(0, 240),
    feedback,
    tests_modified: false,
  };
}

function inspectTool(name, schema, method) {
  return {
    name,
    description: schema.description,
    parameters: structuredClone(schema.parameters),
    output: {
      schema: { type: "string" },
      render: (_args, value) => [textBlock(value)],
    },
    isConcurrencySafe() { return true; },
    async execute(args, exec) {
      const binding = bindingFor(exec?.agent);
      if (!binding) return "ERROR mini-review repository inspection is unavailable";
      try {
        return await binding.oracle[method](args ?? {});
      } catch (error) {
        return `ERROR ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export function buildMiniReviewTools() {
  const grep = inspectTool("grep", MINI_REVIEW_GREP_SCHEMA, "grep");
  const glob = inspectTool("glob", MINI_REVIEW_GLOB_SCHEMA, "glob");
  const view = inspectTool("view", MINI_REVIEW_VIEW_SCHEMA, "view");
  const submit = {
    name: "submit_review",
    description: MINI_REVIEW_SUBMIT_SCHEMA.description,
    parameters: structuredClone(MINI_REVIEW_SUBMIT_SCHEMA.parameters),
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          verdict: { type: "string" },
          outcome: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value?.status === "refused"
        ? `Review submission refused: ${value.reason}`
        : value?.outcome || `review ${value?.verdict ?? "submitted"}`)],
    },
    isConcurrencySafe() { return false; },
    async execute(args, exec) {
      const binding = bindingFor(exec?.agent);
      if (!binding) return { status: "refused", reason: "submit_review is unavailable" };
      try {
        if (!args || typeof args !== "object" || Array.isArray(args)
          || Object.keys(args).length !== 1 || !Object.hasOwn(args, "findings")) {
          throw new Error("submit_review requires only the findings field");
        }
        let verdict;
        let findings;
        if (!bindingIsCompleted(binding, exec?.agent)) {
          findings = await binding.oracle.validateFindings(args.findings);
          verdict = createQaVerdict(reviewFindingsToVerdictInput(findings));
        }
        const result = await binding.submit({ agent: exec?.agent, verdict, findings });
        if (result?.status !== "refused") {
          markCompleted(exec?.agent);
          armChildSettlement(result, exec, { onFailure: () => clearCompleted(exec?.agent) });
          const output = childToolOutput(result);
          try { exec?.concludeTurn?.(); } catch { /* accepted result remains armed */ }
          return output;
        }
        return result;
      } catch (error) {
        return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return [grep, glob, view, submit];
}

function promptOf(holder) {
  return holder?.systemPrompt ?? holder?.get?.("systemPrompt", false) ?? null;
}

function toolsOf(holder) {
  return holder?.tools ?? holder?.get?.("tools", false) ?? null;
}

function installPersona(holder, persona = MINI_REVIEW_SYSTEM_PROMPT) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") throw new Error("mini-review requires systemPrompt.section");
  if (typeof prompt.suppressRuntimeContext !== "function") throw new Error("mini-review requires systemPrompt.suppressRuntimeContext");
  const lift = prompt.section({
    name: MINI_REVIEW_PERSONA_SECTION,
    order: MINI_REVIEW_PERSONA_ORDER,
    text: persona,
    complete: true,
  });
  prompt.suppressRuntimeContext();
  return typeof lift === "function" ? lift : () => {};
}

function installTools(holder) {
  const tools = toolsOf(holder);
  if (!tools || typeof tools.register !== "function" || typeof tools.restrict !== "function") {
    throw new Error("mini-review requires tools.register and tools.restrict");
  }
  const lifts = [];
  // Empty allow inherits no DSH globals. Register the immutable Git-oracle
  // implementations only after isolation, so live-workspace grep/glob cannot
  // leak into a review look. Restriction failures intentionally abort setup.
  const restrict = () => tools.restrict({ allow: [] });
  if (typeof holder.effect === "function") {
    const lift = holder.effect(restrict, "qq-workflows mini-review");
    if (typeof lift === "function") lifts.push(lift);
  } else {
    const lift = restrict();
    if (typeof lift === "function") lifts.push(lift);
  }
  for (const tool of buildMiniReviewTools()) {
    const lift = tools.register(tool);
    if (typeof lift === "function") lifts.push(lift);
  }
  return () => {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort */ }
    }
  };
}

function ownMount(agentCtx, lifts) {
  const record = {
    generation: MOUNT_GENERATION,
    dispose() {
      for (const lift of [...lifts].reverse()) {
        try { lift?.(); } catch { /* best effort */ }
      }
      try {
        if (agentCtx[MINI_REVIEW_MOUNT] === record) agentCtx[MINI_REVIEW_MOUNT] = undefined;
      } catch { /* context disposal */ }
    },
  };
  try {
    agentCtx[MINI_REVIEW_MOUNT] = record;
  } catch (error) {
    record.dispose();
    throw new Error("mini-review requires an extensible agent context for HMR ownership", { cause: error });
  }
  return record;
}

export function miniReviewSetup(agentCtx, options = {}) {
  if (!agentCtx) throw new Error("mini-review setup requires an agent context");
  const previous = agentCtx[MINI_REVIEW_MOUNT];
  if (previous?.generation === MOUNT_GENERATION) return;
  previous?.dispose?.();
  const lifts = [];
  try {
    lifts.push(installPersona(agentCtx, options.prompt ?? MINI_REVIEW_SYSTEM_PROMPT));
    lifts.push(installTools(agentCtx));
    lifts.push(installFormatRecovery(agentCtx));
    ownMount(agentCtx, lifts);
  } catch (error) {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort rollback */ }
    }
    throw error;
  }
}

export function ensureMiniReviewMounted(agent) {
  if (!isMiniReviewAgent(agent)) return false;
  miniReviewSetup(agent?.ctx ?? agent);
  return true;
}

export function assembleMiniReviewPrompt(sections, { runtimeSuppressed = false } = {}) {
  const complete = [...sections].reverse().find((section) => section?.complete === true);
  if (!complete) throw new Error("mini-review persona was not mounted complete");
  if (!runtimeSuppressed) throw new Error("mini-review requires runtime context suppression");
  return complete.text;
}
