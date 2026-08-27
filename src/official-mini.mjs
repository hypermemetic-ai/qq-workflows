// Architect child adapted from mini-swe-agent v2's official mini.yaml.
// DSH intentionally substitutes host concerns: model budgets/routing, approval
// policy, durable sessions, sandbox, relay, and Land. The upstream prompt,
// model-visible bash schema, sequential actions, JSON observation envelope,
// tool-less-response retry guidance, and documented completion command are
// preserved here. DSH keeps a child session reusable after three misses rather
// than terminating a Python CLI run with RepeatedFormatError.

import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

import { armChildSettlement } from "./child-settlement.mjs";
import {
  OBSERVATION_HEAD_CHARS,
  OBSERVATION_MAX_CHARS,
  OBSERVATION_TAIL_CHARS,
  codePointCount,
  sliceCodePoints,
  truncateObservation,
  truncationMarker,
} from "./observation.mjs";

export {
  OBSERVATION_HEAD_CHARS,
  OBSERVATION_MAX_CHARS,
  OBSERVATION_TAIL_CHARS,
  codePointCount,
  truncateObservation,
  truncationMarker,
};

import {
  MINI_SWE_BASH_SCHEMA,
  MINI_SWE_COMPLETION_COMMAND,
  MINI_SWE_CONFIG,
  MINI_SWE_MIGRATION,
  MINI_SWE_REPOSITORY,
  MINI_SWE_SHA,
  MINI_SWE_SYSTEM_PROMPT,
  MINI_SWE_VERSION,
  isMiniSweCompletionCommand,
  renderMiniSweTask,
} from "./mini-swe-v2.mjs";

export {
  MINI_SWE_COMPLETION_COMMAND,
  MINI_SWE_CONFIG,
  MINI_SWE_MIGRATION,
  MINI_SWE_REPOSITORY,
  MINI_SWE_SHA,
  MINI_SWE_VERSION,
  renderMiniSweTask,
};

// Keep the persisted kind stable so existing child sessions still resume.
export const MINI_KIND = "mini";
export const MINI_TOOLS = Object.freeze(["bash"]);
export const MINI_GLOBAL_ALLOW = Object.freeze(["bash"]);
export const MINI_PERSONA_SECTION = "deployment:persona";
export const MINI_PERSONA_ORDER = 0;
export const MINI_PROMPT = MINI_SWE_SYSTEM_PROMPT;
export const MINI_PAGER_EXPORT = "export PAGER=cat MANPAGER=cat GIT_PAGER=cat LESS=-R PIP_PROGRESS_BAR=off TQDM_DISABLE=1";
const UTF8_MAX_BYTES_PER_CP = 4;
const FILE_SCAN_CHUNK = 64 * 1024;
const MINI_SUBMIT = Symbol.for("qq.officialMiniSubmit");
const MINI_COMPLETED = Symbol.for("qq.officialMiniCompleted");
const MINI_WRAPPED_BASH = Symbol.for("qq.officialMiniWrappedBash");
const MINI_MOUNT = Symbol.for("qq.officialMiniMount");
const MOUNT_GENERATION = Object.freeze({});
const submits = new WeakMap();
const completed = new WeakSet();
const consecutiveFormatErrors = new WeakMap();
const lastResponseHadBash = new WeakMap();
const observationCache = new Map();

const FORMAT_ERROR = [
  "Tool call error:",
  "",
  "<error>",
  "Every response needs to use the 'bash' tool at least once to execute commands.",
  "</error>",
  "",
  "Call the bash tool with your command as the argument:",
  "- Tool: bash",
  '- Arguments: {"command": "your_command_here"}',
  "",
  `If you want to end the task, issue \`${MINI_SWE_COMPLETION_COMMAND}\` without any other command.`,
].join("\n");

export function isMiniAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_KIND || header?.agentPreset === MINI_KIND;
}

function submitKeys(agent) {
  return [agent, agent?.session, agent?.ctx].filter((value) => value && typeof value === "object");
}

/** Bind official completion to Land without exposing a second model-visible tool. */
export function bindMiniSubmit(agent, submit) {
  if (!agent || typeof submit !== "function") throw new Error("mini submit binding requires an agent and submit function");
  const keys = submitKeys(agent);
  for (const key of keys) {
    submits.set(key, submit);
    try { key[MINI_SUBMIT] = submit; } catch { /* WeakMap fallback */ }
  }
  return () => {
    for (const key of keys) {
      submits.delete(key);
      try {
        if (key[MINI_SUBMIT] === submit) key[MINI_SUBMIT] = undefined;
      } catch { /* frozen object */ }
    }
  };
}

function submitFor(agent) {
  for (const key of submitKeys(agent)) {
    const submit = key[MINI_SUBMIT] ?? submits.get(key);
    if (typeof submit === "function") return submit;
  }
  return undefined;
}

function messageHasBash(event) {
  if (event?.type !== "assistant/message") return undefined;
  const content = event?.data?.message?.content ?? event?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "tool-call" && block?.name === "bash");
}

function markCompleted(agent) {
  if (agent && typeof agent === "object") completed.add(agent);
  for (const key of submitKeys(agent)) {
    try { key[MINI_COMPLETED] = true; } catch { /* WeakSet fallback */ }
  }
}

function clearCompleted(agent) {
  if (agent && typeof agent === "object") completed.delete(agent);
  for (const key of submitKeys(agent)) {
    try { key[MINI_COMPLETED] = undefined; } catch { /* WeakSet fallback */ }
  }
}

function isCompleted(agent) {
  if (completed.has(agent)) return true;
  return submitKeys(agent).some((key) => key[MINI_COMPLETED] === true);
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

export function withPagerEnv(command) {
  const text = String(command ?? "");
  if (text.startsWith(`${MINI_PAGER_EXPORT};`)) return text;
  return `${MINI_PAGER_EXPORT}; ${text}`;
}

function utf8SeqLen(lead) {
  if (lead < 0x80) return 1;
  if (lead < 0xc0) return 1;
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  if (lead < 0xf8) return 4;
  return 1;
}

function decodeCompleteUtf8Prefix(buf) {
  let i = 0;
  while (i < buf.length) {
    const len = utf8SeqLen(buf[i]);
    if (i + len > buf.length) break;
    i += len;
  }
  return buf.subarray(0, i).toString("utf8");
}

function summarizeText(text) {
  const value = String(text ?? "");
  const points = Array.from(value);
  return {
    chars: points.length,
    full: points.length < OBSERVATION_MAX_CHARS ? value : null,
    head: points.slice(0, OBSERVATION_HEAD_CHARS).join(""),
    tail: points.slice(-OBSERVATION_TAIL_CHARS).join(""),
  };
}

async function countFileCodePoints(fh, size) {
  if (size <= 0) return 0;
  const buf = Buffer.alloc(Math.min(FILE_SCAN_CHUNK, size));
  let offset = 0;
  let carry = Buffer.alloc(0);
  let count = 0;
  while (offset < size) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    if (bytesRead === 0) break;
    const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
    let i = 0;
    while (i < data.length) {
      const len = utf8SeqLen(data[i]);
      if (i + len > data.length) break;
      i += len;
      count++;
    }
    carry = i < data.length ? Buffer.from(data.subarray(i)) : Buffer.alloc(0);
    offset += bytesRead;
  }
  if (carry.length > 0) count += codePointCount(carry.toString("utf8"));
  return count;
}

async function readPrefixCodePoints(fh, size, maxCps) {
  if (maxCps <= 0 || size <= 0) return "";
  let have = 0;
  let acc = Buffer.alloc(0);
  while (have < size) {
    const soFar = codePointCount(decodeCompleteUtf8Prefix(acc));
    const want = Math.min(size - have, Math.max(UTF8_MAX_BYTES_PER_CP, (maxCps - soFar) * UTF8_MAX_BYTES_PER_CP));
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, buf.length, have);
    if (bytesRead === 0) break;
    acc = Buffer.concat([acc, buf.subarray(0, bytesRead)]);
    have += bytesRead;
    const decoded = have >= size ? acc.toString("utf8") : decodeCompleteUtf8Prefix(acc);
    const points = Array.from(decoded);
    if (points.length >= maxCps) return points.slice(0, maxCps).join("");
    if (have >= size) return points.join("");
  }
  return sliceCodePoints(acc.toString("utf8"), 0, maxCps);
}

async function readSuffixCodePoints(fh, size, maxCps) {
  if (maxCps <= 0 || size <= 0) return "";
  const byteBudget = Math.min(size, maxCps * UTF8_MAX_BYTES_PER_CP + 3);
  const buf = Buffer.alloc(byteBudget);
  const pos = size - byteBudget;
  const { bytesRead } = await fh.read(buf, 0, byteBudget, pos);
  let start = 0;
  if (pos > 0) while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
  return sliceCodePoints(buf.subarray(start, bytesRead).toString("utf8"), -maxCps);
}

async function summarizeFile(path) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const chars = await countFileCodePoints(fh, size);
    if (chars < OBSERVATION_MAX_CHARS) return summarizeText(await fh.readFile("utf8"));
    return {
      chars,
      full: null,
      head: await readPrefixCodePoints(fh, size, OBSERVATION_HEAD_CHARS),
      tail: await readSuffixCodePoints(fh, size, OBSERVATION_TAIL_CHARS),
    };
  } finally {
    await fh.close();
  }
}

async function summarizeStream(stream) {
  if (stream?.truncated && typeof stream.spillPath === "string") {
    try { return await summarizeFile(stream.spillPath); } catch { /* use visible text */ }
  }
  return summarizeText(stream?.text);
}

function countFileCodePointsSync(fd, size) {
  if (size <= 0) return 0;
  const buf = Buffer.alloc(Math.min(FILE_SCAN_CHUNK, size));
  let offset = 0;
  let carry = Buffer.alloc(0);
  let count = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
    if (bytesRead === 0) break;
    const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
    let i = 0;
    while (i < data.length) {
      const len = utf8SeqLen(data[i]);
      if (i + len > data.length) break;
      i += len;
      count++;
    }
    carry = i < data.length ? Buffer.from(data.subarray(i)) : Buffer.alloc(0);
    offset += bytesRead;
  }
  if (carry.length > 0) count += codePointCount(carry.toString("utf8"));
  return count;
}

function readPrefixCodePointsSync(fd, size, maxCps) {
  if (maxCps <= 0 || size <= 0) return "";
  const byteBudget = Math.min(size, maxCps * UTF8_MAX_BYTES_PER_CP);
  const buf = Buffer.alloc(byteBudget);
  const bytesRead = readSync(fd, buf, 0, byteBudget, 0);
  return sliceCodePoints(buf.subarray(0, bytesRead).toString("utf8"), 0, maxCps);
}

function readSuffixCodePointsSync(fd, size, maxCps) {
  if (maxCps <= 0 || size <= 0) return "";
  const byteBudget = Math.min(size, maxCps * UTF8_MAX_BYTES_PER_CP + 3);
  const buf = Buffer.alloc(byteBudget);
  const pos = size - byteBudget;
  const bytesRead = readSync(fd, buf, 0, byteBudget, pos);
  let start = 0;
  if (pos > 0) while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
  return sliceCodePoints(buf.subarray(start, bytesRead).toString("utf8"), -maxCps);
}

function summarizeFileSync(path) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const chars = countFileCodePointsSync(fd, size);
    if (chars < OBSERVATION_MAX_CHARS) {
      const buf = Buffer.alloc(size);
      const bytesRead = readSync(fd, buf, 0, size, 0);
      return summarizeText(buf.subarray(0, bytesRead).toString("utf8"));
    }
    return {
      chars,
      full: null,
      head: readPrefixCodePointsSync(fd, size, OBSERVATION_HEAD_CHARS),
      tail: readSuffixCodePointsSync(fd, size, OBSERVATION_TAIL_CHARS),
    };
  } finally {
    closeSync(fd);
  }
}

function summarizeStreamSync(stream) {
  if (stream?.truncated && typeof stream.spillPath === "string") {
    try { return summarizeFileSync(stream.spillPath); } catch { /* use visible text */ }
  }
  return summarizeText(stream?.text);
}

function partChars(part) {
  return typeof part === "string" ? codePointCount(part) : part.chars;
}

function materialize(parts) {
  return parts.map((part) => typeof part === "string" ? part : (part.full ?? "")).join("");
}

function takePrefix(parts, n) {
  let out = "";
  let have = 0;
  for (const part of parts) {
    if (have >= n) break;
    const text = typeof part === "string" ? part : (part.full ?? part.head);
    const slice = sliceCodePoints(text, 0, n - have);
    out += slice;
    have += codePointCount(slice);
  }
  return out;
}

function takeSuffix(parts, n) {
  let out = "";
  let have = 0;
  for (let i = parts.length - 1; i >= 0 && have < n; i--) {
    const part = parts[i];
    const text = typeof part === "string" ? part : (part.full ?? part.tail);
    const slice = sliceCodePoints(text, -(n - have));
    out = slice + out;
    have += codePointCount(slice);
  }
  return out;
}

function endsWithNewline(summary) {
  return (summary.full ?? summary.tail).endsWith("\n");
}

function combinedParts(stdout, stderr) {
  const parts = [stdout];
  if (stderr.chars > 0) {
    if (stdout.chars > 0 && !endsWithNewline(stdout)) parts.push("\n");
    parts.push(stderr);
  }
  return parts;
}

function returnCode(result) {
  if (result?.sandbox?.denied || result?.timedOut || result?.signal != null) return -1;
  return Number.isInteger(result?.exitCode) ? result.exitCode : 0;
}

function exceptionInfo(result) {
  if (result?.sandbox?.denied) return `sandbox denied under ${result.sandbox.mode} mode`;
  if (result?.timedOut) return `command timed out after ${result.timeoutMs}ms`;
  if (result?.signal != null) return `command killed by signal ${result.signal}`;
  return "";
}

function formatSummaries(stdout, stderr, result) {
  const parts = combinedParts(stdout, stderr);
  const chars = parts.reduce((sum, part) => sum + partChars(part), 0);
  const observation = chars < OBSERVATION_MAX_CHARS
    ? { returncode: returnCode(result), output: materialize(parts) }
    : {
      returncode: returnCode(result),
      output_head: takePrefix(parts, OBSERVATION_HEAD_CHARS),
      output_tail: takeSuffix(parts, OBSERVATION_TAIL_CHARS),
      elided_chars: chars - OBSERVATION_MAX_CHARS,
      warning: "Output too long.",
    };
  const exception = exceptionInfo(result);
  if (exception) observation.exception_info = exception;
  return JSON.stringify(observation, null, 2);
}

export async function buildMiniObservation(result) {
  return formatSummaries(await summarizeStream(result?.stdout), await summarizeStream(result?.stderr), result);
}

function observationCacheKey(result) {
  const stdout = result?.stdout;
  const stderr = result?.stderr;
  if (!stdout?.spillPath && !stderr?.spillPath) return "";
  return JSON.stringify([
    stdout?.spillPath ?? "", stdout?.truncated === true,
    stderr?.spillPath ?? "", stderr?.truncated === true,
    result?.exitCode ?? null, result?.signal ?? null,
    result?.timedOut === true, result?.aborted === true,
    result?.sandbox?.mode ?? "", result?.sandbox?.denied === true,
  ]);
}

export function buildMiniObservationSync(result) {
  const key = observationCacheKey(result);
  if (key && observationCache.has(key)) return observationCache.get(key);
  const observation = formatSummaries(summarizeStreamSync(result?.stdout), summarizeStreamSync(result?.stderr), result);
  if (key) {
    observationCache.set(key, observation);
    while (observationCache.size > 32) observationCache.delete(observationCache.keys().next().value);
  }
  return observation;
}

function textBlock(text) {
  return { type: "text", text };
}

function bashPayload(result) {
  if (result?.kind === "foreground" || result?.kind === "background") return result;
  if (result?.value?.kind === "foreground" || result?.value?.kind === "background") return result.value;
  return undefined;
}

function observationBlocks(value, fallback = []) {
  const payload = bashPayload(value);
  if (payload?.kind === "foreground") return [textBlock(buildMiniObservationSync(payload))];
  return Array.isArray(fallback) ? fallback : [];
}

function syntheticResult(output, exitCode) {
  return {
    kind: "foreground",
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: output, truncated: false },
    stderr: { text: "", truncated: false },
  };
}

export function wrapMiniBash(base) {
  if (!base || typeof base.execute !== "function") throw new Error("mini requires a bash tool to wrap");
  const output = base.output ? {
    ...base.output,
    render(args, value) {
      if (bashPayload(value)?.kind === "foreground") return observationBlocks(value);
      return typeof base.output.render === "function" ? base.output.render(args, value) : [];
    },
  } : base.output;
  return {
    ...base,
    [MINI_WRAPPED_BASH]: true,
    description: MINI_SWE_BASH_SCHEMA.description,
    parameters: structuredClone(MINI_SWE_BASH_SCHEMA.parameters),
    // Upstream DefaultAgent executes multiple actions sequentially.
    isConcurrencySafe() { return false; },
    ...(output ? { output } : {}),
    async execute(args, exec) {
      if (isMiniSweCompletionCommand(args?.command)) {
        const submit = submitFor(exec?.agent);
        if (!submit) return syntheticResult("Submission unavailable: this child is not owned by Land.\n", 1);
        const result = await submit({ agent: exec?.agent, ref: "HEAD" });
        if (result?.status === "refused") {
          return syntheticResult(`Submission refused: ${result.reason || "unknown reason"}\n`, 1);
        }
        const success = syntheticResult("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\n", 0);
        markCompleted(exec?.agent);
        armChildSettlement(result, exec, {
          onFailure: () => clearCompleted(exec?.agent),
        });
        try { exec?.concludeTurn?.(); } catch { /* accepted result remains armed */ }
        return success;
      }
      return base.execute({
        command: withPagerEnv(args?.command),
        description: "Execute Mini SWE bash command",
      }, exec);
    },
    finalizeContent(exec, result) {
      if (bashPayload(result)?.kind === "foreground") return observationBlocks(result);
      if (Array.isArray(result?.content)) return result.content;
      if (typeof base.finalizeContent === "function") return base.finalizeContent(exec, result);
      return [];
    },
  };
}

function promptOf(holder) {
  return holder?.systemPrompt ?? holder?.get?.("systemPrompt", false) ?? null;
}

function toolsOf(holder) {
  return holder?.tools ?? holder?.get?.("tools", false) ?? null;
}

function installMiniPersona(holder) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") throw new Error("mini requires systemPrompt.section");
  if (typeof prompt.suppressRuntimeContext !== "function") throw new Error("mini requires systemPrompt.suppressRuntimeContext");
  const lift = prompt.section({
    name: MINI_PERSONA_SECTION,
    order: MINI_PERSONA_ORDER,
    text: MINI_PROMPT,
    complete: true,
  });
  prompt.suppressRuntimeContext();
  return typeof lift === "function" ? lift : () => {};
}

function installMiniTools(holder) {
  const tools = toolsOf(holder);
  if (!tools || typeof tools.restrict !== "function" || typeof tools.register !== "function" || typeof tools.get !== "function") {
    throw new Error("mini requires tools.get, tools.register, and tools.restrict");
  }
  const wrapped = wrapMiniBash(tools.get("bash"));
  const lifts = [];
  const bashLift = tools.register(wrapped);
  if (typeof bashLift === "function") lifts.push(bashLift);
  const restrict = () => tools.restrict({ allow: [...MINI_GLOBAL_ALLOW] });
  if (typeof holder.effect === "function") {
    const lift = holder.effect(restrict, "qq-workflows official mini-swe");
    if (typeof lift === "function") lifts.push(lift);
  } else {
    const lift = restrict();
    if (typeof lift === "function") lifts.push(lift);
  }
  return () => {
    for (const lift of lifts) {
      try { lift(); } catch { /* best effort */ }
    }
  };
}

function isOfficialWrappedBash(tool) {
  if (tool?.[MINI_WRAPPED_BASH] === true) return true;
  const names = Object.keys(tool?.parameters?.properties ?? {});
  return tool?.description === MINI_SWE_BASH_SCHEMA.description
    && names.length === 1
    && names[0] === "command";
}

function ownMount(agentCtx, lifts) {
  const record = {
    generation: MOUNT_GENERATION,
    dispose() {
      for (const lift of [...lifts].reverse()) {
        try { lift?.(); } catch { /* best effort */ }
      }
      try {
        if (agentCtx[MINI_MOUNT] === record) agentCtx[MINI_MOUNT] = undefined;
      } catch { /* context disposal */ }
    },
  };
  try {
    agentCtx[MINI_MOUNT] = record;
  } catch (error) {
    record.dispose();
    throw new Error("mini requires an extensible agent context for HMR ownership", { cause: error });
  }
  return record;
}

export function miniSetup(agentCtx) {
  if (!agentCtx) throw new Error("mini setup requires an agent context");
  const previous = agentCtx[MINI_MOUNT];
  if (previous?.generation === MOUNT_GENERATION) return;
  previous?.dispose?.();

  const tools = toolsOf(agentCtx);
  const currentBash = tools?.get?.("bash");
  if (!tools || !currentBash?.execute) throw new Error("mini setup requires prompt and bash services");

  // A wrapper from this adapter but without a current generation record can be
  // reused long enough to replace its recovery ownership. Pre-v2 Mini mounts
  // are intentionally restart-only: they expose a different tool surface and
  // have no disposer that can make an in-place HMR migration honest.
  if (isOfficialWrappedBash(currentBash)) {
    ownMount(agentCtx, [installFormatRecovery(agentCtx)]);
    return;
  }

  const prompt = promptOf(agentCtx);
  if (!prompt) throw new Error("mini setup requires prompt and bash services");
  const lifts = [];
  try {
    lifts.push(installMiniPersona(agentCtx));
    lifts.push(installMiniTools(agentCtx));
    lifts.push(installFormatRecovery(agentCtx));
    ownMount(agentCtx, lifts);
  } catch (error) {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort rollback */ }
    }
    throw error;
  }
}

/** Restore the persisted Mini preset when DSH recreates a child session. */
export function ensureMiniMounted(agent) {
  if (!isMiniAgent(agent)) return false;
  miniSetup(agent?.ctx ?? agent);
  return true;
}

export function assembleMiniPrompt(sections, { runtimeSuppressed = false } = {}) {
  const complete = [...sections].reverse().find((section) => section?.complete === true);
  if (!complete) throw new Error("mini persona was not mounted complete");
  if (!runtimeSuppressed) throw new Error("mini requires runtime context suppression");
  return complete.text;
}
