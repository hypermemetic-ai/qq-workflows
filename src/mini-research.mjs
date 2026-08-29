import { randomUUID } from "node:crypto";

import { armChildSettlement } from "./child-settlement.mjs";
import { allowInherited, MINI_INHERITED_TOOLS } from "./hide-harness.mjs";
import { buildMiniObservationSync } from "./official-mini.mjs";
import {
  MINI_SWE_BASH_SCHEMA,
  MINI_SWE_COMPLETION_COMMAND,
  isMiniSweCompletionCommand,
} from "./mini-swe-v2.mjs";

export const MINI_RESEARCH_KIND = "mini-research";
export const MINI_RESEARCH_TOOLS = Object.freeze(["bash"]);
export const MINI_RESEARCH_GLOBAL_ALLOW = MINI_INHERITED_TOOLS;
export const MINI_RESEARCH_PERSONA_SECTION = "deployment:persona";
export const MINI_RESEARCH_PERSONA_ORDER = 0;
export const MINI_RESEARCH_PROMPT = [
  "You are mini-research, a focused evidence-gathering research agent.",
  "",
  "Work backward from question.md. Code is available under repo/. Search results are leads, not evidence: materialize every web or session source you rely on with web-get or session-get. Use ordinary Unix tools to inspect the immutable snapshots under evidence/.",
  "",
  "Seek contrary evidence for important conclusions. Distinguish direct observation from inference. Stop when additional retrieval is unlikely to change the answer. Write a direct answer to answer.md, citing only acquired W### or S### refs and repo/ paths. Mark strong evidence, weak evidence, and inference where that distinction matters, and surface unresolved contradictions rather than flattening them.",
  "",
  `When answer.md is ready, run exactly: ${MINI_SWE_COMPLETION_COMMAND}`,
  "Every response must make at least one bash tool call. The completion command must be issued alone.",
].join("\n");

const BINDING = Symbol.for("qq.miniResearchBinding");
const COMPLETED = Symbol.for("qq.miniResearchCompleted");
const WRAPPED = Symbol.for("qq.miniResearchWrappedBash");
const MOUNT = Symbol.for("qq.miniResearchMount");
const MOUNT_GENERATION = Object.freeze({});
const bindings = new WeakMap();
const completed = new WeakSet();
const consecutiveFormatErrors = new WeakMap();
const lastResponseHadBash = new WeakMap();

const BUILTINS = new Set(["web-search", "web-get", "session-search", "session-get"]);
const FORMAT_ERROR = [
  "Tool call error:",
  "",
  "<error>",
  "Every response needs to use the bash tool at least once.",
  "</error>",
  "",
  "Use bash to inspect the capsule, gather evidence, or finish with the completion command alone.",
].join("\n");

function keysOf(agent) {
  return [agent, agent?.session, agent?.ctx].filter((value) => value && typeof value === "object");
}

export function isMiniResearchAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_RESEARCH_KIND || header?.agentPreset === MINI_RESEARCH_KIND;
}

export function bindMiniResearch(agent, binding) {
  if (!agent || !binding || typeof binding.submit !== "function") {
    throw new Error("mini-research binding requires an agent and research submit function");
  }
  const normalized = { ...binding };
  for (const key of keysOf(agent)) {
    bindings.set(key, normalized);
    try { key[BINDING] = normalized; } catch { /* WeakMap fallback */ }
  }
  return () => {
    for (const key of keysOf(agent)) {
      if (bindings.get(key) === normalized) bindings.delete(key);
      try { if (key[BINDING] === normalized) key[BINDING] = undefined; } catch { /* frozen */ }
    }
  };
}

function bindingFor(agent) {
  for (const key of keysOf(agent)) {
    const value = key[BINDING] ?? bindings.get(key);
    if (value && typeof value.submit === "function") return value;
  }
  return null;
}

function markCompleted(agent) {
  if (agent && typeof agent === "object") completed.add(agent);
  for (const key of keysOf(agent)) {
    try { key[COMPLETED] = true; } catch { /* best effort */ }
  }
}

function clearCompleted(agent) {
  if (agent && typeof agent === "object") completed.delete(agent);
  for (const key of keysOf(agent)) {
    try { key[COMPLETED] = undefined; } catch { /* best effort */ }
  }
}

function isCompleted(agent) {
  return completed.has(agent) || keysOf(agent).some((key) => key[COMPLETED] === true);
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
    const hadBash = messageHasBash(event);
    if (hadBash === undefined || !session || typeof session !== "object") return;
    lastResponseHadBash.set(session, hadBash);
    if (hadBash) consecutiveFormatErrors.set(session, 0);
  });
  const offStopping = agentCtx.on("agent/turn-stopping", ({ agent }) => {
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
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
  });
  return () => {
    try { offEvent?.(); } catch { /* best effort */ }
    try { offStopping?.(); } catch { /* best effort */ }
  };
}

function syntheticResult(stdout, exitCode = 0, stderr = "") {
  return {
    kind: "foreground",
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: String(stdout ?? ""), truncated: false },
    stderr: { text: String(stderr ?? ""), truncated: false },
  };
}

function firstWord(command) {
  return String(command ?? "").trimStart().match(/^([^\s;|&<>]+)/)?.[1] ?? "";
}

/** Parse a deliberately tiny shell-word subset; metacharacters fail closed. */
export function parseResearchCommand(command) {
  const source = String(command ?? "");
  const first = firstWord(source);
  if (!BUILTINS.has(first)) return null;
  const words = [];
  let token = "";
  let quote = "";
  let escaping = false;
  let active = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (escaping) {
      token += char;
      escaping = false;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') escaping = true;
      else token += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) { words.push(token); token = ""; active = false; }
      continue;
    }
    if (";|&<>`()$".includes(char)) {
      return { error: "evidence commands must be standalone (no pipelines, substitutions, or redirections)" };
    }
    token += char;
    active = true;
  }
  if (quote || escaping) return { error: "evidence command has an unterminated quote or escape" };
  if (active) words.push(token);
  if (words[0] !== first) return { error: "invalid evidence command" };
  return { name: first, args: words.slice(1) };
}

function normalizeRef(value, prefix) {
  const match = String(value ?? "").toUpperCase().match(new RegExp(`^${prefix}(\\d{1,3})$`));
  if (!match) throw new Error(`invalid ${prefix === "W" ? "web" : "session"} ref: ${String(value ?? "")}`);
  return `${prefix}${match[1].padStart(3, "0")}`;
}

async function executeBuiltin(parsed, binding) {
  const { name, args } = parsed;
  if (name === "web-search") {
    if (args.length !== 1 || !args[0].trim()) throw new Error("usage: web-search 'query'");
    if (!binding.web || typeof binding.web.search !== "function") throw new Error("web evidence provider is unavailable");
    return binding.web.search(args[0]);
  }
  if (name === "web-get") {
    if (args.length !== 1) throw new Error("usage: web-get W001");
    if (!binding.web || typeof binding.web.get !== "function") throw new Error("web evidence provider is unavailable");
    const result = await binding.web.get(normalizeRef(args[0], "W"));
    return `${result.ref} materialized ${result.path} sha256 ${result.sha256}\n`;
  }
  if (name === "session-search") {
    if (args.length === 0 || args.some((value) => !value.trim())) throw new Error("usage: session-search 'phrase one' ['phrase two']");
    if (!binding.sessions || typeof binding.sessions.search !== "function") throw new Error("session evidence provider is unavailable");
    return binding.sessions.search(args);
  }
  if (name === "session-get") {
    if (args.length !== 1) throw new Error("usage: session-get S001");
    if (!binding.sessions || typeof binding.sessions.get !== "function") throw new Error("session evidence provider is unavailable");
    const result = await binding.sessions.get(normalizeRef(args[0], "S"));
    return `${result.ref} materialized ${result.path} sha256 ${result.sha256}\n`;
  }
  throw new Error("unknown evidence command");
}

function bashPayload(result) {
  if (result?.kind === "foreground" || result?.kind === "background") return result;
  if (result?.value?.kind === "foreground" || result?.value?.kind === "background") return result.value;
  return undefined;
}

function textBlock(text) { return { type: "text", text }; }
function observationBlocks(value, fallback = []) {
  const payload = bashPayload(value);
  return payload?.kind === "foreground" ? [textBlock(buildMiniObservationSync(payload))] : fallback;
}

export function wrapMiniResearchBash(base) {
  if (!base || typeof base.execute !== "function") throw new Error("mini-research requires a bash tool to wrap");
  const output = base.output ? {
    ...base.output,
    render(args, value) {
      if (bashPayload(value)?.kind === "foreground") return observationBlocks(value);
      return typeof base.output.render === "function" ? base.output.render(args, value) : [];
    },
  } : base.output;
  return {
    ...base,
    [WRAPPED]: true,
    description: MINI_SWE_BASH_SCHEMA.description,
    parameters: structuredClone(MINI_SWE_BASH_SCHEMA.parameters),
    isConcurrencySafe() { return false; },
    ...(output ? { output } : {}),
    async execute(args, exec) {
      const command = String(args?.command ?? "");
      const binding = bindingFor(exec?.agent);
      if (isMiniSweCompletionCommand(command)) {
        if (!binding) return syntheticResult("", 1, "Submission unavailable: this child is not owned by research.\n");
        const result = await binding.submit({ agent: exec?.agent });
        if (result?.status === "refused") return syntheticResult("", 1, `Submission refused: ${result.reason || "unknown reason"}\n`);
        const success = syntheticResult("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\n", 0);
        markCompleted(exec?.agent);
        armChildSettlement(result, exec, { onFailure: () => clearCompleted(exec?.agent) });
        try { exec?.concludeTurn?.(); } catch { /* accepted result remains armed */ }
        return success;
      }
      const parsed = parseResearchCommand(command);
      const compoundEvidenceCommand = /(?:^|[|;&()\n])\s*(?:web-search|web-get|session-search|session-get)(?=\s|$)/.test(command);
      if (!parsed && compoundEvidenceCommand) {
        return syntheticResult("", 2, "evidence commands must be standalone (no pipelines, substitutions, or redirections)\n");
      }
      if (parsed) {
        if (parsed.error) return syntheticResult("", 2, `${parsed.error}\n`);
        if (!binding) return syntheticResult("", 1, "Evidence commands are unavailable for this child.\n");
        try { return syntheticResult(await executeBuiltin(parsed, binding), 0); }
        catch (error) { return syntheticResult("", 1, `${error instanceof Error ? error.message : String(error)}\n`); }
      }
      // Ordinary bash remains native; only exact evidence command invocations are intercepted.
      return base.execute(args, exec);
    },
    finalizeContent(exec, result) {
      if (bashPayload(result)?.kind === "foreground") return observationBlocks(result);
      if (Array.isArray(result?.content)) return result.content;
      return typeof base.finalizeContent === "function" ? base.finalizeContent(exec, result) : [];
    },
  };
}

function promptOf(holder) { return holder?.systemPrompt ?? holder?.get?.("systemPrompt", false) ?? null; }
function toolsOf(holder) { return holder?.tools ?? holder?.get?.("tools", false) ?? null; }

function installPersona(holder) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function" || typeof prompt.suppressRuntimeContext !== "function") {
    throw new Error("mini-research requires system prompt services");
  }
  const lift = prompt.section({
    name: MINI_RESEARCH_PERSONA_SECTION,
    order: MINI_RESEARCH_PERSONA_ORDER,
    text: MINI_RESEARCH_PROMPT,
    complete: true,
  });
  prompt.suppressRuntimeContext();
  return typeof lift === "function" ? lift : () => {};
}

function installTools(holder) {
  const tools = toolsOf(holder);
  if (!tools || typeof tools.get !== "function" || typeof tools.register !== "function") {
    throw new Error("mini-research requires bash registration services");
  }
  const lifts = [];
  const wrapped = wrapMiniResearchBash(tools.get("bash"));
  const register = tools.register(wrapped);
  if (typeof register === "function") lifts.push(register);
  return () => { for (const lift of lifts.reverse()) try { lift?.(); } catch { /* best effort */ } };
}

function ownMount(agentCtx, lifts) {
  const record = {
    generation: MOUNT_GENERATION,
    dispose() {
      for (const lift of [...lifts].reverse()) try { lift?.(); } catch { /* best effort */ }
      try { if (agentCtx[MOUNT] === record) agentCtx[MOUNT] = undefined; } catch { /* disposed */ }
    },
  };
  agentCtx[MOUNT] = record;
}

export function miniResearchSetup(agentCtx) {
  if (!agentCtx) throw new Error("mini-research setup requires an agent context");
  const previous = agentCtx[MOUNT];
  if (previous?.generation === MOUNT_GENERATION) return;
  previous?.dispose?.();
  allowInherited(agentCtx, agentCtx.agent, MINI_INHERITED_TOOLS);
  const tools = toolsOf(agentCtx);
  if (tools?.get?.("bash")?.[WRAPPED]) {
    ownMount(agentCtx, [installFormatRecovery(agentCtx)]);
    return;
  }
  const lifts = [];
  try {
    lifts.push(installPersona(agentCtx));
    lifts.push(installTools(agentCtx));
    lifts.push(installFormatRecovery(agentCtx));
    ownMount(agentCtx, lifts);
  } catch (error) {
    for (const lift of lifts.reverse()) try { lift?.(); } catch { /* rollback */ }
    throw error;
  }
}

export function ensureMiniResearchMounted(agent) {
  if (!isMiniResearchAgent(agent)) return false;
  miniResearchSetup(agent?.ctx ?? agent);
  return true;
}

export function renderMiniResearchTask() {
  return [
    "Research the question in question.md.",
    "",
    "Available host evidence commands (invoke each as a standalone bash command):",
    "  web-search 'query'",
    "  web-get W001",
    "  session-search 'phrase one' 'phrase two'",
    "  session-get S001",
    "",
    "Write answer.md and then issue the completion command alone.",
  ].join("\n");
}

export function assembleMiniResearchPrompt(sections, { runtimeSuppressed = false } = {}) {
  const complete = [...sections].reverse().find((section) => section?.complete === true);
  if (!complete) throw new Error("mini-research persona was not mounted complete");
  if (!runtimeSuppressed) throw new Error("mini-research requires runtime context suppression");
  return complete.text;
}
