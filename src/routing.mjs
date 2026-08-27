import { readFile } from "node:fs/promises";

export const ROUTE_PACKET_SCHEMA = "qq.route-packet/v1";
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

export function parseDiffPointers(source, limit = PACKET_POINTER_LIMIT) {
  const pointers = [];
  let path = "";
  for (const line of String(source ?? "").split("\n")) {
    const file = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (file) {
      path = file[1] === "/dev/null" ? "" : file[1];
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (!hunk || !path) continue;
    const context = hunk[2].trim();
    pointers.push(context ? `${path}:${hunk[1]} ${context}` : `${path}:${hunk[1]}`);
    if (pointers.length >= limit) break;
  }
  return pointers;
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
  const unified = await checked(
    run,
    "git",
    ["diff", "-U0", "--no-color", `${view.baseRef}...${view.ref}`],
    { cwd: view.worktree },
    "cannot collect packet pointers",
  );
  return {
    schema: ROUTE_PACKET_SCHEMA,
    brief: options.brief ?? await readBrief(view),
    files,
    pointers: parseDiffPointers(unified.stdout),
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

export function parseRouteStamp(source) {
  const first = String(source ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  return first === "land" || first === "review" ? first : undefined;
}

const REVIEW_PATH = /(^|\/)(?:session|store|identity|review|land|run|dsh)[^/]*\.(?:mjs|ts|js)$/i;
const REVIEW_WORD = /\b(?:session|store|identity|review|land|run|handoff|relay)\b/i;
const PAINT_PATH = /\.(?:css|scss|less|svg)$/i;
const PAINT_WORD = /\b(?:paint|css|stylesheet|copy|comment|color|typo)\b/i;

export function stampFromEvidence(packet) {
  const files = packet?.files ?? [];
  const brief = String(packet?.brief ?? "");
  const evidence = `${brief}\n${files.map((file) => file.path).join("\n")}`;
  if (files.some((file) => REVIEW_PATH.test(file.path)) || REVIEW_WORD.test(evidence)) return "review";
  if (files.length > 0 && files.every((file) => PAINT_PATH.test(file.path)) && PAINT_WORD.test(brief)) return "land";
  return "review";
}

export function formatRouteEvidence(packet) {
  const files = (packet?.files ?? []).map((file) => `${file.path} +${file.added ?? "?"}/-${file.deleted ?? "?"}`);
  return [
    "Original brief:", packet?.brief ?? "", "", "Files touched:", files.join("\n") || "(none)",
    "", "Pointers:", (packet?.pointers ?? []).join("\n") || "(none)",
  ].join("\n");
}

export async function routePacket(packet, options = {}) {
  const fallback = stampFromEvidence(packet);
  if (typeof options.complete !== "function") return fallback;
  try {
    const source = await options.complete({
      system: options.prompt ?? "Return exactly land or review. Default to review when uncertain.",
      user: formatRouteEvidence(packet),
    });
    return parseRouteStamp(typeof source === "string" ? source : "") ?? fallback;
  } catch {
    return fallback;
  }
}

export function look1FixPrompt(state, verdict) {
  return `qa look 1 rejected ${state.task?.id ?? state.id}. ${verdict.feedback || verdict.summary} Fix once, commit the result, then call done again with ref HEAD.`;
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
