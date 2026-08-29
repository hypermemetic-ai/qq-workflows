export const DELEGATION_PACKET_SCHEMA = "qq.delegation-packet/v1";
export const PACKET_FILE_PREVIEW_LIMIT = 24;
export const PACKET_POINTER_LIMIT = 8;
export const PACKET_LINE_MAX_CHARS = 240;
export const PACKET_FORMAT_MAX_CHARS = 12_000;

function reason(result, fallback) {
  return result?.stderr?.trim() || result?.stdout?.trim() || fallback;
}

async function checked(run, command, args, options, label) {
  const result = await run(command, args, options);
  if (result?.code !== 0) throw new Error(`${label}: ${reason(result, "command failed")}`);
  return result;
}

function singleLine(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
}

export function boundedPacketLine(value, limit = PACKET_LINE_MAX_CHARS) {
  const text = singleLine(value);
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  const suffix = `… [${omitted} chars omitted]`;
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`.slice(0, limit);
}

export function boundFormattedText(value, limit = PACKET_FORMAT_MAX_CHARS, label = "packet") {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const suffix = `\n[${label} omitted ${text.length - limit} chars; inspect the referenced artifacts/revisions for complete data]`;
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`.slice(0, limit);
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

// Unified diff headers can themselves be hostile/pathological. Only enough of
// each current header is retained to derive one bounded hunk pointer.
const POINTER_HEADER_LIMIT = PACKET_LINE_MAX_CHARS * 2;

function createDiffPointerCollector(limit = PACKET_POINTER_LIMIT) {
  const pointers = [];
  let path = "";
  let line = "";
  let mode = "candidate";
  let streamed = false;
  let saturated = false;

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
    pointers.push(boundedPacketLine(context ? `${path}:${hunk[1]} ${context}` : `${path}:${hunk[1]}`));
    if (pointers.length >= limit) saturated = true;
  }

  function append(segment) {
    if (mode === "discard" || !segment) return;
    const available = Math.max(0, POINTER_HEADER_LIMIT - line.length);
    line += segment.slice(0, available);
    if (!couldBePointerHeader(line)) {
      line = "";
      mode = "discard";
    } else if (segment.length > available) {
      mode = "truncated";
    }
  }

  function resetLine() {
    line = "";
    mode = "candidate";
  }

  return {
    get streamed() { return streamed; },
    get saturated() { return saturated; },
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
  return {
    path: boundedPacketLine(file.path),
    added: Number.isFinite(file.added) ? file.added : null,
    deleted: Number.isFinite(file.deleted) ? file.deleted : null,
  };
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

export async function compilePacket(run, state, options = {}) {
  const view = { ...state, ref: options.ref ?? state.ref };
  const allFiles = options.files ?? await packFor(run, view);
  const fileCount = allFiles.length;
  const files = allFiles.slice(0, PACKET_FILE_PREVIEW_LIMIT).map(fileCounts);
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
  if (!collector.streamed) collector.write(unified.stdout);
  const pointers = collector.finish();
  return {
    schema: DELEGATION_PACKET_SCHEMA,
    fileCount,
    omittedFiles: Math.max(0, fileCount - files.length),
    files,
    pointers,
    pointersOmitted: collector.saturated,
    mark: options.mark ?? null,
  };
}

export function formatPacket(packet) {
  const rawFiles = Array.isArray(packet?.files) ? packet.files : [];
  const fileCount = Number.isSafeInteger(packet?.fileCount) && packet.fileCount >= rawFiles.length
    ? packet.fileCount
    : rawFiles.length;
  const files = rawFiles.slice(0, PACKET_FILE_PREVIEW_LIMIT).map((file) =>
    `${boundedPacketLine(file?.path)} +${file?.added ?? "?"}/-${file?.deleted ?? "?"}`);
  const omittedFiles = Number.isSafeInteger(packet?.omittedFiles) && packet.omittedFiles >= 0
    ? Math.max(packet.omittedFiles, fileCount - files.length)
    : Math.max(0, fileCount - files.length);
  const pointers = (Array.isArray(packet?.pointers) ? packet.pointers : [])
    .slice(0, PACKET_POINTER_LIMIT)
    .map((pointer) => boundedPacketLine(pointer));
  const pointerOmission = packet?.pointersOmitted || (packet?.pointers?.length ?? 0) > pointers.length;
  const legacyBrief = packet?.brief
    ? `Legacy brief preview:\n${boundFormattedText(packet.brief, 1_000, "legacy brief")}`
    : "";
  const body = [
    `Mark: ${boundedPacketLine(packet?.mark ?? "review", 40)}`,
    `Changed files: ${fileCount} total; ${files.length} shown; ${omittedFiles} omitted.`,
    legacyBrief,
    files.length ? `Files (bounded preview):\n${files.join("\n")}` : "Files (bounded preview): none",
    omittedFiles ? `[${omittedFiles} changed files omitted from preview]` : "[changed-file preview complete]",
    pointers.length ? `Hunk pointers (bounded preview):\n${pointers.join("\n")}` : "Hunk pointers (bounded preview): none",
    pointerOmission ? `[additional hunk pointers omitted after ${pointers.length}]` : "[hunk-pointer preview complete]",
  ].filter(Boolean).join("\n\n");
  return boundFormattedText(body, PACKET_FORMAT_MAX_CHARS, "proposal packet");
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
