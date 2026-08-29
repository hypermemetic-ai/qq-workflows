import { readFile } from "node:fs/promises";

export const DELEGATION_PACKET_SCHEMA = "qq.delegation-packet/v1";
const PACKET_POINTER_LIMIT = 8;

function reason(result, fallback) {
  return result?.stderr?.trim() || result?.stdout?.trim() || fallback;
}

async function checked(run, command, args, options, label) {
  const result = await run(command, args, options);
  if (result?.code !== 0) throw new Error(`${label}: ${reason(result, "command failed")}`);
  return result;
}

export function parseNumstat(source) {
  const files = [];
  for (const line of String(source ?? "").split("\n")) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    files.push({
      path,
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
    });
  }
  return files;
}

const POINTER_HEADER_LIMIT = 64 * 1024;

function createDiffPointerCollector(limit = PACKET_POINTER_LIMIT) {
  const pointers = [];
  let path = "";
  let line = "";
  let mode = "candidate";
  let streamed = false;

  function couldBePointerHeader(value) {
    return "+++ ".startsWith(value) || value.startsWith("+++ ")
      || "@@ ".startsWith(value) || value.startsWith("@@ ");
  }

  function consumeLine() {
    if (mode === "discard") return;
    const source = line.endsWith("\r") ? line.slice(0, -1) : line;
    const file = source.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (file) {
      path = file[1] === "/dev/null" ? "" : file[1];
      return;
    }
    const hunk = source.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (!hunk || !path) return;
    const context = hunk[2].trim();
    pointers.push(context ? `${path}:${hunk[1]} ${context}` : `${path}:${hunk[1]}`);
  }

  function append(segment) {
    if (mode === "discard" || !segment) return;
    const available = Math.max(0, POINTER_HEADER_LIMIT - line.length);
    line += segment.slice(0, available);
    if (!couldBePointerHeader(line)) {
      line = "";
      mode = "discard";
    } else if (segment.length > available) {
      // A pathological changed line must not become a replacement full-diff
      // buffer. The metadata prefix remains sufficient for a hunk pointer.
      mode = "truncated";
    }
  }

  function resetLine() {
    line = "";
    mode = "candidate";
  }

  return {
    get streamed() { return streamed; },
    write(chunk, fromStream = false) {
      if (fromStream) streamed = true;
      const text = String(chunk ?? "");
      let offset = 0;
      while (offset < text.length && pointers.length < limit) {
        const newline = text.indexOf("\n", offset);
        if (newline === -1) {
          append(text.slice(offset));
          break;
        }
        append(text.slice(offset, newline));
        consumeLine();
        resetLine();
        offset = newline + 1;
      }
      return pointers.length < limit;
    },
    finish() {
      if (line && pointers.length < limit) consumeLine();
      resetLine();
      return pointers;
    },
  };
}

export function parseDiffPointers(source, limit = PACKET_POINTER_LIMIT) {
  const collector = createDiffPointerCollector(limit);
  collector.write(source);
  return collector.finish();
}

function fileCounts(file) {
  return { path: file.path, added: file.added ?? null, deleted: file.deleted ?? null };
}

async function packFor(run, state) {
  const result = await checked(
    run,
    "git",
    ["diff", "--numstat", "--no-renames", `${state.baseRef}...${state.ref}`, "--"],
    { cwd: state.worktree },
    "cannot inspect proposal",
  );
  return parseNumstat(result.stdout);
}

async function readBrief(state) {
  if (!state?.ticketPath) return "";
  try { return (await readFile(state.ticketPath, "utf8")).trim(); } catch { return ""; }
}

export async function compilePacket(run, state, options = {}) {
  const view = { ...state, ref: options.ref ?? state.ref };
  const files = (options.files ?? await packFor(run, view)).map(fileCounts);
  const collector = createDiffPointerCollector();
  const unified = await checked(
    run,
    "git",
    ["diff", "-U0", "--no-color", `${view.baseRef}...${view.ref}`, "--"],
    {
      cwd: view.worktree,
      onStdout(chunk) { return collector.write(chunk, true); },
    },
    "cannot collect packet pointers",
  );
  // Injected runners may not implement streaming. Preserve compatibility for
  // their bounded stdout results without duplicating streamed data.
  if (!collector.streamed) collector.write(unified.stdout);
  return {
    schema: DELEGATION_PACKET_SCHEMA,
    brief: options.brief ?? await readBrief(view),
    files,
    pointers: collector.finish(),
    mark: options.mark ?? null,
  };
}

export function formatPacket(packet) {
  const files = (packet?.files ?? []).map((file) => `${file.path} +${file.added ?? "?"}/-${file.deleted ?? "?"}`);
  const pointers = packet?.pointers ?? [];
  return [
    `Mark: ${packet?.mark ?? "review"}`,
    packet?.brief ?? "",
    files.length ? `Files:\n${files.join("\n")}` : "Files:",
    pointers.length ? `Pointers:\n${pointers.join("\n")}` : "Pointers:",
  ].filter(Boolean).join("\n\n");
}

export function isTestPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => ["test", "tests", "spec", "specs", "__tests__", "fixtures", "__fixtures__", "snapshots", "__snapshots__"].includes(part.toLowerCase()))) return true;
  return /(?:^test[_-].+|.+[._-](?:test|spec|snap))\.[^.]+$/i.test(name);
}

export function parseChangedPaths(source) {
  const text = String(source ?? "");
  return text.split(text.includes("\0") ? "\0" : "\n").filter(Boolean);
}
