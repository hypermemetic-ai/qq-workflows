import { randomUUID } from "node:crypto";

import { wrapMiniBash } from "./official-mini.mjs";
import { allowInherited, MINI_INHERITED_TOOLS } from "./hide-harness.mjs";

const ADAPTER_NAME = "qq-workflows:mini-docs";

export const MINI_DOCS_KIND = "mini-docs";
export const MINI_DOCS_COMPLETION_COMMAND = "echo COMPLETE_DOCS_AND_EXIT";
export const MINI_DOCS_TOOLS = Object.freeze(["bash"]);
export const MINI_DOCS_PERSONA_SECTION = "deployment:persona";
export const MINI_DOCS_PERSONA_ORDER = 0;

const MINI_DOCS_COMPLETED = Symbol.for("qq.miniDocsCompleted");
const MINI_DOCS_MOUNT = Symbol.for("qq.miniDocsMount");
const MOUNT_GENERATION = Object.freeze({});
const HEADLESS_QQ_CORE = Object.freeze({
  surface: Object.freeze({ allow() {} }),
});
const completed = new WeakSet();
const consecutiveFormatErrors = new WeakMap();
const lastResponseHadBash = new WeakMap();

const FORMAT_ERROR = [
  "Tool call error:",
  "",
  "<error>",
  "Every response needs to call bash.",
  "</error>",
  "",
  "Call bash to continue working, or finish by calling bash with:",
  `- {"command": "${MINI_DOCS_COMPLETION_COMMAND}"}`,
].join("\n");

function keysOf(agent) {
  return [agent, agent?.session, agent?.ctx].filter((value) => value && typeof value === "object");
}

export function isMiniDocsAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_DOCS_KIND || header?.agentPreset === MINI_DOCS_KIND;
}

function markCompleted(agent) {
  if (agent && typeof agent === "object") completed.add(agent);
  for (const key of keysOf(agent)) {
    try { key[MINI_DOCS_COMPLETED] = true; } catch { /* WeakSet fallback */ }
  }
}

function isCompleted(agent) {
  if (completed.has(agent)) return true;
  return keysOf(agent).some((key) => key[MINI_DOCS_COMPLETED] === true);
}

export function isMiniDocsCompletionCommand(command) {
  return String(command ?? "").trim() === MINI_DOCS_COMPLETION_COMMAND;
}

function completionResult() {
  return {
    kind: "foreground",
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: "COMPLETE_DOCS_AND_EXIT\n", truncated: false },
    stderr: { text: "", truncated: false },
  };
}

function messageHasBash(event) {
  if (event?.type !== "assistant/message") return undefined;
  const content = event?.data?.message?.content ?? event?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "tool-call" && block?.name === "bash");
}

function installFormatRecovery(agentCtx) {
  if (typeof agentCtx?.on !== "function") return () => {};
  const offEvent = agentCtx.on("session/event", (session, event) => {
    if (!session || typeof session !== "object") return;
    const hadBash = messageHasBash(event);
    if (hadBash === undefined) return;
    lastResponseHadBash.set(session, hadBash);
    if (hadBash) consecutiveFormatErrors.set(session, 0);
  });
  const offStopping = agentCtx.on("agent/turn-stopping", ({ agent } = {}) => {
    if (!agent || isCompleted(agent)) return;
    const key = agent.session ?? agent;
    if (lastResponseHadBash.get(key) === true) return;
    const count = (consecutiveFormatErrors.get(key) ?? 0) + 1;
    consecutiveFormatErrors.set(key, count);
    if (count >= 3 || typeof agent.steer !== "function") return;
    agent.steer({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: FORMAT_ERROR }],
      source: { kind: "plugin", plugin: ADAPTER_NAME, form: "notice" },
    });
  });
  return () => {
    try { offEvent?.(); } catch { /* best effort */ }
    try { offStopping?.(); } catch { /* best effort */ }
  };
}

function promptOf(holder) {
  return holder?.systemPrompt ?? holder?.get?.("systemPrompt", false) ?? null;
}

function toolsOf(holder) {
  return holder?.tools ?? holder?.get?.("tools", false) ?? null;
}

function writerPrompt(config) {
  const prompt = config?.env?.QQ_WIKI_WRITER_PROMPT ?? process.env.QQ_WIKI_WRITER_PROMPT;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("mini-docs requires a non-blank QQ_WIKI_WRITER_PROMPT");
  }
  return prompt;
}

function installPersona(holder, config) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") throw new Error("mini-docs requires systemPrompt.section");
  if (typeof prompt.suppressRuntimeContext !== "function") {
    throw new Error("mini-docs requires systemPrompt.suppressRuntimeContext");
  }
  const lift = prompt.section({
    name: MINI_DOCS_PERSONA_SECTION,
    order: MINI_DOCS_PERSONA_ORDER,
    text: writerPrompt(config),
    complete: true,
  });
  try {
    prompt.suppressRuntimeContext();
  } catch (error) {
    try { lift?.(); } catch { /* best effort rollback */ }
    throw error;
  }
  return typeof lift === "function" ? lift : () => {};
}

function installTools(holder) {
  const tools = toolsOf(holder);
  if (!tools || typeof tools.get !== "function" || typeof tools.register !== "function") {
    throw new Error("mini-docs requires tools.get and tools.register");
  }

  const miniBash = wrapMiniBash(tools.get("bash"), { interceptCompletion: false });
  const docsBash = {
    ...miniBash,
    async execute(args, exec) {
      if (isMiniDocsCompletionCommand(args?.command)) {
        markCompleted(exec?.agent);
        try { exec?.concludeTurn?.(); } catch { /* completion remains accepted */ }
        return completionResult();
      }
      return miniBash.execute(args, exec);
    },
  };

  const lifts = [];
  try {
    const bashLift = tools.register(docsBash);
    if (typeof bashLift === "function") lifts.push(bashLift);
  } catch (error) {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort rollback */ }
    }
    throw error;
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
        if (agentCtx[MINI_DOCS_MOUNT] === record) agentCtx[MINI_DOCS_MOUNT] = undefined;
      } catch { /* context disposal */ }
    },
  };
  try {
    agentCtx[MINI_DOCS_MOUNT] = record;
  } catch (error) {
    record.dispose();
    throw new Error("mini-docs requires an extensible agent context for HMR ownership", { cause: error });
  }
  return record;
}

export function miniDocsSetup(agentCtx, config = {}) {
  if (!agentCtx) throw new Error("mini-docs setup requires an agent context");
  const previous = agentCtx[MINI_DOCS_MOUNT];
  if (previous?.generation === MOUNT_GENERATION) return;
  previous?.dispose?.();
  // qq-wiki's headless writer profile intentionally omits qq-core. Keep this
  // compatibility surface local so every other adapter still requires real core.
  if (!agentCtx.get?.("qq-core", false) && typeof agentCtx.provide === "function") {
    agentCtx.provide("qq-core", HEADLESS_QQ_CORE);
  }
  allowInherited(agentCtx, agentCtx.agent, MINI_INHERITED_TOOLS);

  const lifts = [];
  try {
    lifts.push(installPersona(agentCtx, config));
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

export function ensureMiniDocsMounted(agent, config = {}) {
  if (!isMiniDocsAgent(agent)) return false;
  miniDocsSetup(agent?.ctx ?? agent, config);
  return true;
}
