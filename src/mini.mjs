// Mini: architect's child. Bash plus done. Official Mini-SWE command examples.
// Not a smaller model. Origin stays subagent. DSH persists agentPreset, not kind.

import { open } from "node:fs/promises";

export const MINI_KIND = "mini";
export const MINI_TOOLS = Object.freeze(["bash", "done"]);
/** Globals only. Local `done` merges after the allow mask; naming it here throws. */
export const MINI_GLOBAL_ALLOW = Object.freeze(["bash"]);
export const MINI_PERSONA_SECTION = "deployment:persona";
export const MINI_PERSONA_ORDER = 0;
/** Unicode code points, not tokens. Official Mini `len(output)`. */
export const OBSERVATION_MAX_CHARS = 10_000;
export const OBSERVATION_HEAD_CHARS = 5_000;
export const OBSERVATION_TAIL_CHARS = 5_000;
export const MINI_OBSERVATION = Symbol.for("qq.miniObservation");
export const MINI_PAGER_EXPORT = "export PAGER=cat MANPAGER=cat GIT_PAGER=cat";

const STDERR_HEADER = "[stderr]\n";
const UTF8_MAX_BYTES_PER_CP = 4;
const FILE_SCAN_CHUNK = 64 * 1024;

export const MINI_PROMPT = [
  "You are a helpful assistant that can interact with a computer.",
  "",
  "You can execute bash commands and edit files to implement the necessary changes.",
  "",
  "## Recommended Workflow",
  "",
  "This workflow should be done step-by-step so that you can iterate on your changes and any possible problems.",
  "",
  "1. Analyze the codebase by finding and reading relevant files",
  "2. Create a script to reproduce the issue",
  "3. Edit the source code to resolve the issue",
  "4. Verify your fix works by running your script again",
  "5. Test edge cases to ensure your fix is robust",
  "6. Submit your changes by calling `done`. Do not combine it with any other command. After this command, you cannot continue working on this task.",
  "",
  "Each turn must include a bash action until you call `done`.",
  "",
  "Each action executes in a new subshell. Directory changes and shell",
  "environment changes therefore do not persist between turns, while",
  "filesystem changes do persist. You can prefix any action with",
  "`VAR=value cd /path/to/dir && ...` or write/load environment variables from files.",
  "",
  "## Useful command examples",
  "",
  "Create a new file:",
  "",
  "cat <<'EOF' > newfile.py",
  "hello = \"world\"",
  "print(hello)",
  "EOF",
  "",
  "Edit files with sed:",
  "",
  "sed -i 's/old_string/new_string/g' filename.py",
  "sed -i 's/old_string/new_string/' filename.py",
  "sed -i '1s/old_string/new_string/' filename.py",
  "sed -i '1,10s/old_string/new_string/g' filename.py",
  "",
  "View file content:",
  "",
  "nl -ba filename.py | sed -n '10,20p'",
].join("\n");

export function isMiniAgent(agent) {
  const header = agent?.session?.header ?? agent?.header;
  return header?.kind === MINI_KIND || header?.agentPreset === MINI_KIND;
}

export function codePointCount(value) {
  let n = 0;
  for (const _ of String(value ?? "")) n++;
  return n;
}

export function truncationMarker(omittedChars) {
  return `\n[... environment output truncated: ${omittedChars} chars omitted ...]\n`;
}

function sliceCodePoints(text, start, end) {
  return Array.from(String(text ?? "")).slice(start, end).join("");
}

export function truncateObservation(value) {
  const text = String(value ?? "");
  const chars = codePointCount(text);
  if (chars <= OBSERVATION_MAX_CHARS) return text;
  const omitted = chars - OBSERVATION_HEAD_CHARS - OBSERVATION_TAIL_CHARS;
  return `${sliceCodePoints(text, 0, OBSERVATION_HEAD_CHARS)}${truncationMarker(omitted)}${sliceCodePoints(text, -OBSERVATION_TAIL_CHARS)}`;
}

function truncateContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return { ...block, text: truncateObservation(block.text) };
    }
    return block;
  });
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
  const cps = Array.from(value);
  const chars = cps.length;
  return {
    chars,
    full: chars <= OBSERVATION_MAX_CHARS ? value : null,
    head: cps.slice(0, OBSERVATION_HEAD_CHARS).join(""),
    tail: cps.slice(-OBSERVATION_TAIL_CHARS).join(""),
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
    const data = carry.length > 0
      ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
      : buf.subarray(0, bytesRead);
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
    const cps = Array.from(decoded);
    if (cps.length >= maxCps) return cps.slice(0, maxCps).join("");
    if (have >= size) return cps.join("");
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
  if (pos > 0) {
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
  }
  return sliceCodePoints(buf.subarray(start, bytesRead).toString("utf8"), -maxCps);
}

export async function summarizeFile(path) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size <= OBSERVATION_MAX_CHARS) return summarizeText(await fh.readFile("utf8"));
    const chars = await countFileCodePoints(fh, size);
    if (chars <= OBSERVATION_MAX_CHARS) return summarizeText(await fh.readFile("utf8"));
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
    try {
      return await summarizeFile(stream.spillPath);
    } catch {
      return summarizeText(stream.text);
    }
  }
  return summarizeText(stream?.text);
}

function partChars(part) {
  return typeof part === "string" ? codePointCount(part) : part.chars;
}

function endsWithNewline(summary) {
  const text = summary.full ?? summary.tail;
  return text.endsWith("\n");
}

function takePrefix(parts, n) {
  let out = "";
  let have = 0;
  for (const part of parts) {
    if (have >= n) break;
    const need = n - have;
    const text = typeof part === "string" ? part : (part.full ?? part.head);
    const slice = sliceCodePoints(text, 0, need);
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
    const need = n - have;
    const text = typeof part === "string" ? part : (part.full ?? part.tail);
    const slice = sliceCodePoints(text, -need);
    out = slice + out;
    have += codePointCount(slice);
  }
  return out;
}

function materialize(parts) {
  let out = "";
  for (const part of parts) {
    out += typeof part === "string" ? part : (part.full ?? "");
  }
  return out;
}

function truncateParts(parts) {
  let chars = 0;
  for (const part of parts) chars += partChars(part);
  if (chars <= OBSERVATION_MAX_CHARS) return materialize(parts);
  const omitted = chars - OBSERVATION_HEAD_CHARS - OBSERVATION_TAIL_CHARS;
  return `${takePrefix(parts, OBSERVATION_HEAD_CHARS)}${truncationMarker(omitted)}${takeSuffix(parts, OBSERVATION_TAIL_CHARS)}`;
}

function resultMarkers(result) {
  const markers = [];
  if (result?.sandbox?.denied) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`);
  }
  if (result?.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result?.signal != null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result?.exitCode != null && result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`);
  }
  return markers;
}

/** Official Mini 5k+5k on the full command output. Exit markers stay outside the 10k window. */
export async function buildMiniObservation(result) {
  const stdout = await summarizeStream(result?.stdout);
  const stderr = await summarizeStream(result?.stderr);
  const parts = [stdout];
  if (stderr.chars > 0) {
    if (stdout.chars > 0 && !endsWithNewline(stdout)) parts.push("\n");
    parts.push(STDERR_HEADER, stderr);
  }
  let body = truncateParts(parts);
  if (body.length === 0) body = "(no output)";
  const markers = resultMarkers(result);
  if (markers.length === 0) return body;
  return body.endsWith("\n") ? body + markers.join("\n") : `${body}\n${markers.join("\n")}`;
}

function observationBlocks(result, fallback) {
  if (typeof result?.[MINI_OBSERVATION] === "string") {
    return [{ type: "text", text: result[MINI_OBSERVATION] }];
  }
  return truncateContentBlocks(fallback);
}

function textBlock(text) {
  return { type: "text", text };
}

export function buildMiniDonePlaceholder() {
  return {
    name: "done",
    description: "Submit this worktree for land or review. Land adoption replaces this placeholder.",
    parameters: {
      ref: {
        type: "string",
        description: "Commit to submit. Defaults to HEAD.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value.status === "refused" ? `Done refused: ${value.reason}` : "done")],
    },
    async execute() {
      return { status: "refused", reason: "done requires land adoption" };
    },
  };
}

export function wrapMiniBash(base) {
  if (!base || typeof base.execute !== "function") {
    throw new Error("mini requires a bash tool to wrap");
  }
  const output = base.output
    ? {
      ...base.output,
      render(args, value) {
        if (typeof value?.[MINI_OBSERVATION] === "string") {
          return [{ type: "text", text: value[MINI_OBSERVATION] }];
        }
        const authored = typeof base.output.render === "function"
          ? base.output.render(args, value)
          : undefined;
        return observationBlocks(value, authored ?? []);
      },
    }
    : base.output;
  return {
    ...base,
    ...output ? { output } : {},
    async execute(args, exec) {
      const value = await base.execute({ ...args, command: withPagerEnv(args?.command) }, exec);
      if (value?.kind !== "foreground") return value;
      return { ...value, [MINI_OBSERVATION]: await buildMiniObservation(value) };
    },
    finalizeContent(exec, result) {
      if (typeof result?.[MINI_OBSERVATION] === "string") {
        return [{ type: "text", text: result[MINI_OBSERVATION] }];
      }
      const authored = typeof base.finalizeContent === "function"
        ? base.finalizeContent(exec, result)
        : typeof base.output?.render === "function"
          ? base.output.render({}, result)
          : result?.content;
      return observationBlocks(result, authored ?? []);
    },
  };
}

function promptOf(holder) {
  return holder?.systemPrompt
    ?? holder?.get?.("systemPrompt", false)
    ?? null;
}

function toolsOf(holder) {
  return holder?.tools
    ?? holder?.get?.("tools", false)
    ?? null;
}

function installMiniPersona(holder) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") {
    throw new Error("mini requires systemPrompt.section");
  }
  if (typeof prompt.suppressRuntimeContext !== "function") {
    throw new Error("mini requires systemPrompt.suppressRuntimeContext");
  }
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
  if (!tools || typeof tools.restrict !== "function" || typeof tools.register !== "function") {
    throw new Error("mini requires tools.register and tools.restrict");
  }
  if (typeof tools.get !== "function") {
    throw new Error("mini requires tools.get to wrap bash");
  }
  const wrapped = wrapMiniBash(tools.get("bash"));
  const lifts = [];
  const bashLift = tools.register(wrapped);
  if (typeof bashLift === "function") lifts.push(bashLift);
  const doneLift = tools.register(buildMiniDonePlaceholder());
  if (typeof doneLift === "function") lifts.push(doneLift);
  const restrict = () => {
    try {
      return tools.restrict({ allow: [...MINI_GLOBAL_ALLOW] });
    } catch (error) {
      throw new Error(`mini tool restriction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (typeof holder.effect === "function") {
    holder.effect(restrict, "qq-workflows mini");
  } else {
    const lift = restrict();
    if (typeof lift === "function") lifts.push(lift);
  }
  return () => {
    for (const lift of lifts) {
      try { lift(); } catch { /* lift is best-effort */ }
    }
  };
}

function applyMiniTo(holder) {
  const prompt = promptOf(holder);
  if (!prompt || typeof prompt.section !== "function") {
    throw new Error("mini requires systemPrompt.section");
  }
  if (typeof prompt.suppressRuntimeContext !== "function") {
    throw new Error("mini requires systemPrompt.suppressRuntimeContext");
  }
  const tools = toolsOf(holder);
  if (!tools || typeof tools.restrict !== "function" || typeof tools.register !== "function") {
    throw new Error("mini requires tools.register and tools.restrict");
  }
  if (typeof tools.get !== "function") {
    throw new Error("mini requires tools.get to wrap bash");
  }
  const bash = tools.get("bash");
  if (!bash || typeof bash.execute !== "function") {
    throw new Error("mini requires a bash tool to wrap");
  }
  const lifts = [installMiniPersona(holder), installMiniTools(holder)];
  return () => {
    for (const lift of lifts) {
      try { lift(); } catch { /* lift is best-effort */ }
    }
  };
}

/** Mount Mini during unpublished create setup. Do not inject-and-return: create will publish a default agent. */
export function miniSetup(agentCtx) {
  if (!agentCtx) throw new Error("mini setup requires an agent context");
  applyMiniTo(agentCtx);
}

/** Complete-mode assembly: Mini persona is the only system-prompt section. */
export function assembleMiniPrompt(sections, { runtimeSuppressed = false } = {}) {
  const complete = [...sections].reverse().find((section) => section?.complete === true);
  if (!complete) throw new Error("mini persona was not mounted complete");
  if (!runtimeSuppressed) throw new Error("mini requires runtime context suppression");
  return complete.text;
}
