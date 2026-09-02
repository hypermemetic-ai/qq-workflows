import { randomUUID } from "node:crypto";

import { armChildSettlement, childToolOutput } from "./child-settlement.mjs";
import { childServicesReady, installChildConversationServices, messageHasChildAction, observeLiveChildSetup } from "./child-conversation-services.mjs";
import { allowInherited, MINI_INHERITED_TOOLS } from "./hide-harness.mjs";
import { createQaVerdict } from "./qa-verdict.mjs";
import { wrapMiniBash } from "./official-mini.mjs";
import {
  MINI_QA_KIND,
  LEGACY_MINI_QA_KIND,
  MINI_QA_SUBMIT_SCHEMA,
  MINI_QA_SYSTEM_PROMPT,
  MINI_QA_TOOL_NAMES,
  renderMiniQaTask,
} from "./mini-qa-v2.mjs";

export * from "./mini-qa-v2.mjs";

export const MINI_QA_PERSONA_SECTION = "deployment:persona";
export const MINI_QA_PERSONA_ORDER = 0;

const MINI_QA_BINDING = Symbol.for("qq.miniQaBinding");
const MINI_QA_COMPLETED = Symbol.for("qq.miniQaCompleted");
const MINI_QA_MOUNT = Symbol.for("qq.miniQaMount");
const MINI_QA_SHARED_STATE = Symbol.for("@hypermemetic-ai/qq-workflows/mini-qa-shared-state/v1");
const MOUNT_GENERATION = Object.freeze({});

function sharedMiniQaState() {
  const existing = globalThis[MINI_QA_SHARED_STATE];
  if (existing?.bindings instanceof WeakMap && existing?.completed instanceof WeakSet
    && existing?.consecutiveFormatErrors instanceof WeakMap
    && existing?.lastResponseHadTool instanceof WeakMap) return existing;
  const state = Object.freeze({
    bindings: new WeakMap(),
    completed: new WeakSet(),
    consecutiveFormatErrors: new WeakMap(),
    lastResponseHadTool: new WeakMap(),
  });
  Object.defineProperty(globalThis, MINI_QA_SHARED_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return state;
}

// DSH may expose non-extensible Agent/Session proxies, so symbol properties are
// only a cross-version fallback. The global symbol-owned weak collections are
// authoritative across live query-import/HMR module generations.
const {
  bindings,
  completed,
  consecutiveFormatErrors,
  lastResponseHadTool,
} = sharedMiniQaState();

const FORMAT_ERROR = [
  "Tool call error:",
  "",
  "<error>",
  "Every response needs to call bash, session_history, or submit_review.",
  "</error>",
  "",
  "Use bash to inspect specific evidence, or finish with submit_review.",
].join("\n");

function textBlock(text) {
  return { type: "text", text: String(text ?? "") };
}

function keysOf(agent) {
  return [agent, agent?.session, agent?.ctx].filter((value) => value && typeof value === "object");
}

export function isMiniQaAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_QA_KIND || header?.agentPreset === MINI_QA_KIND
    || header?.kind === LEGACY_MINI_QA_KIND || header?.agentPreset === LEGACY_MINI_QA_KIND;
}

/** Bind one look findings validator and its durable verdict sink. */
export function bindMiniQaSubmit(agent, oracleOrBinding, maybeSubmit) {
  if (!agent) throw new Error("mini-qa binding requires an agent");
  const binding = typeof oracleOrBinding === "object" && oracleOrBinding?.oracle
    ? {
        oracle: oracleOrBinding.oracle,
        submit: oracleOrBinding.submit,
        isCompleted: oracleOrBinding.isCompleted,
      }
    : { oracle: oracleOrBinding, submit: maybeSubmit };
  if (!binding.oracle || typeof binding.submit !== "function") {
    throw new Error("mini-qa binding requires an oracle and submit function");
  }
  const keys = keysOf(agent);
  for (const key of keys) {
    bindings.set(key, binding);
    try { key[MINI_QA_BINDING] = binding; } catch { /* WeakMap fallback */ }
  }
  return () => {
    for (const key of keys) {
      if (bindings.get(key) === binding) bindings.delete(key);
      try {
        if (key[MINI_QA_BINDING] === binding) key[MINI_QA_BINDING] = undefined;
      } catch { /* frozen object */ }
    }
  };
}

function bindingFor(agent) {
  for (const key of keysOf(agent)) {
    const binding = bindings.get(key) ?? key[MINI_QA_BINDING];
    if (binding?.oracle && typeof binding.submit === "function") return binding;
  }
  return null;
}

function markCompleted(agent) {
  if (agent && typeof agent === "object") completed.add(agent);
  for (const key of keysOf(agent)) {
    try { key[MINI_QA_COMPLETED] = true; } catch { /* WeakSet fallback */ }
  }
}

function clearCompleted(agent) {
  if (agent && typeof agent === "object") completed.delete(agent);
  for (const key of keysOf(agent)) {
    try { key[MINI_QA_COMPLETED] = undefined; } catch { /* WeakSet fallback */ }
  }
}

function isCompleted(agent) {
  if (completed.has(agent)) return true;
  return keysOf(agent).some((key) => key[MINI_QA_COMPLETED] === true);
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
  return messageHasChildAction(event, MINI_QA_TOOL_NAMES);
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

export function buildMiniQaTools() {
  const submit = {
    name: "submit_review",
    description: MINI_QA_SUBMIT_SCHEMA.description,
    parameters: structuredClone(MINI_QA_SUBMIT_SCHEMA.parameters),
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
      if (isCompleted(exec?.agent)) {
        try { exec?.concludeTurn?.(); } catch { /* accepted review remains terminal */ }
        return { status: "ok", alreadySubmitted: true };
      }
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
          if (!Array.isArray(args.findings)) throw new Error("findings must be an array");
          findings = args.findings.length === 0
            ? []
            : await binding.oracle.validateFindings(args.findings);
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
  return [submit];
}

function promptOf(holder) {
  return holder?.systemPrompt ?? holder?.get?.("systemPrompt", false) ?? null;
}

function toolsOf(holder) {
  return holder?.tools ?? holder?.get?.("tools", false) ?? null;
}

function installPersona(holder, persona = MINI_QA_SYSTEM_PROMPT) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") throw new Error("mini-qa requires systemPrompt.section");
  if (typeof prompt.suppressRuntimeContext !== "function") throw new Error("mini-qa requires systemPrompt.suppressRuntimeContext");
  const lift = prompt.section({
    name: MINI_QA_PERSONA_SECTION,
    order: MINI_QA_PERSONA_ORDER,
    text: persona,
    complete: true,
  });
  prompt.suppressRuntimeContext();
  return typeof lift === "function" ? lift : () => {};
}

function installTools(holder) {
  const tools = toolsOf(holder);
  if (!tools || typeof tools.get !== "function" || typeof tools.register !== "function") {
    throw new Error("mini-qa requires tools.get and tools.register");
  }
  const wrappedBash = wrapMiniBash(tools.get("bash"), { interceptCompletion: false });
  const lifts = [];
  const bashLift = tools.register(wrappedBash);
  if (typeof bashLift === "function") lifts.push(bashLift);
  for (const tool of buildMiniQaTools()) {
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
        if (agentCtx[MINI_QA_MOUNT] === record) agentCtx[MINI_QA_MOUNT] = undefined;
      } catch { /* context disposal */ }
    },
  };
  try {
    agentCtx[MINI_QA_MOUNT] = record;
  } catch (error) {
    record.dispose();
    throw new Error("mini-qa requires an extensible agent context for HMR ownership", { cause: error });
  }
  return record;
}

export function miniQaSetup(agentCtx, options = {}) {
  if (!agentCtx) throw new Error("mini-qa setup requires an agent context");
  const previous = agentCtx[MINI_QA_MOUNT];
  if (previous?.generation === MOUNT_GENERATION) return;
  previous?.dispose?.();
  allowInherited(agentCtx, agentCtx.agent, MINI_INHERITED_TOOLS);
  const lifts = [];
  try {
    lifts.push(installPersona(agentCtx, options.prompt ?? MINI_QA_SYSTEM_PROMPT));
    lifts.push(installTools(agentCtx));
    lifts.push(installFormatRecovery(agentCtx));
    const childServices = installChildConversationServices(agentCtx);
    lifts.push(childServices);
    ownMount(agentCtx, lifts);
    return childServicesReady(childServices);
  } catch (error) {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort rollback */ }
    }
    throw error;
  }
}

export function ensureMiniQaMounted(agent) {
  if (!isMiniQaAgent(agent)) return false;
  const readiness = miniQaSetup(agent?.ctx ?? agent);
  observeLiveChildSetup(agent, readiness, "mini-qa");
  return true;
}

export function assembleMiniQaPrompt(sections, { runtimeSuppressed = false } = {}) {
  const complete = [...sections].reverse().find((section) => section?.complete === true);
  if (!complete) throw new Error("mini-qa persona was not mounted complete");
  if (!runtimeSuppressed) throw new Error("mini-qa requires runtime context suppression");
  return complete.text;
}
