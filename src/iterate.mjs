// Iterate workflow: a desk, not a conversation someone else notes.
//
// The operator talks in turns. The intake (talking) model extracts what it
// heard — nits, praise, theory, directive — shows the receipt, and sits.
// When the operator says go, this breath's nits go out together to one
// fresh hands session. An independent reviewer judges pass/fail. Fail sits.
// Passed hands dump unstructured wiki nodes; the desk files them later.
//
// Own chair, own hang (workflows:iterate), own tools. No pixel tools on the
// desk. Architect and iterate do not share a session.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pluginUserMessage } from "./tools.mjs";
import { formatProjection, projectJournal } from "./journal.mjs";
import { randomUUID } from "node:crypto";
import { oneShot } from "../../qq/src/ask.mjs";

export const ITERATE_LABEL = "workflows:iterate";
export const CHILD_ORIGIN = "subagent";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HANDS_LOCATION = "qq-ui";

export const REVIEWER_SYSTEM = [
  "You are the iterate reviewer for one hands delivery. Judge pass or fail only.",
  "Pass when the delivery honors the directive, does not break the keep-outs (praise), and actually answers this breath's nits.",
  "Use the shots listing and the patch-surface diff together with the hands report. Do not run tools.",
  "Fail otherwise. Respond with exactly \"PASS\" or \"FAIL: <short reason>\". Nothing else.",
].join("\n");

export const PACKET_CYCLE = [
  "Method (one inner cycle): orient once, do the bundle, then change \u2192 shoot \u2192 maybe one fix. Do not accumulate five failed attempts. When done, deliver a short plain report of what changed and end your turn. An independent reviewer judges after you deliver; do not self-grade.",
].join("\n");

export const PACKET_PATCH_LIST = [
  "Patch surface (the only files you own):",
  "- qq-ui/src/render.mjs",
  "- qq-ui/assets/console.css",
  "- maybe a tiny qq-ui/assets/browser-*.js",
  "Do not touch SSE owner/target (#console-stream, #session-panel), PWA cache, DSH APIs, or the live host to make the UI look better. Use the fixture, not live DSH. Do not make a worktree per nit.",
].join("\n");

export const PATCH_SURFACE = Object.freeze([
  "qq-ui/src/render.mjs",
  "qq-ui/assets/console.css",
]);

const DIFF_CHARS = 24_000;
const SHOT_LIST_CAP = 80;

/** A chair that may be selected as iterate. Children never are. */
export function isIterateCandidate(agent) {
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

function relayOf(ctx) {
  return ctx.get?.("qq-relay", false) ?? null;
}

function logLine(ctx, level, message) {
  const logger = ctx?.logger;
  if (logger && typeof logger[level] === "function") {
    logger[level](message);
    return;
  }
  if (level === "warn") console.warn(message);
}

function hangLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.hang !== "function") return false;
  try {
    relay.hang(sessionId, ITERATE_LABEL);
    logLine(ctx, "info", `qq-workflows: hung ${ITERATE_LABEL} on ${sessionId}`);
    return true;
  } catch (error) {
    logLine(
      ctx,
      "warn",
      `qq-workflows: failed to hang ${ITERATE_LABEL} on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function clearLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.clear !== "function") return false;
  try {
    relay.clear(sessionId, ITERATE_LABEL);
    return true;
  } catch {
    return false;
  }
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function shotsHome(env = process.env) {
  const stateHome = env.XDG_STATE_HOME
    ? env.XDG_STATE_HOME
    : join(env.HOME || homedir(), ".local", "state");
  return join(stateHome, "qq", "frontend-design-loop", "shots");
}

function listShotEntries(dir, { prefix = "", limit = SHOT_LIST_CAP } = {}) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of names) {
    if (entries.length >= limit) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...listShotEntries(full, { prefix: rel, limit: limit - entries.length }));
      continue;
    }
    let size = 0;
    try { size = statSync(full).size; } catch {}
    entries.push(`${rel} (${size} bytes)`);
  }
  return entries;
}

function patchSurfacePaths(cwd) {
  const paths = [...PATCH_SURFACE];
  const assets = join(cwd || "", "qq-ui", "assets");
  if (!cwd || !existsSync(assets)) return paths;
  try {
    for (const name of readdirSync(assets).sort()) {
      if (/^browser-.*\.js$/.test(name)) paths.push(`qq-ui/assets/${name}`);
    }
  } catch {}
  return paths;
}

function collectPatchDiff(cwd) {
  if (!cwd) return "(no working directory)";
  try {
    const out = execFileSync("git", ["diff", "--", ...patchSurfacePaths(cwd)], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 200_000,
    }).trim();
    if (!out) return "(no patch-surface diff)";
    return out.length > DIFF_CHARS ? `${out.slice(0, DIFF_CHARS)}\n…(truncated)` : out;
  } catch {
    return "(could not read patch-surface diff)";
  }
}

/** Text the one-shot reviewer can actually read: shots listing + patch-surface diff. */
export function collectReviewEvidence({ cwd, env = process.env } = {}) {
  const home = shotsHome(env);
  const shots = listShotEntries(home);
  const listing = shots.length ? shots.join("\n") : "(no shots)";
  const diff = collectPatchDiff(cwd);
  return [
    `Shots from the design loop (${home}):`,
    listing,
    "",
    "Patch-surface diff:",
    diff,
  ].join("\n");
}

/** Deterministic hands packet. Off-session (compiled here, not by the talking model). */
export function buildHandsPacket({ bundle, cwd, parentSession, parentAlias }) {
  const lines = [];
  lines.push("You are hands. This is a fresh session; the desk does not continue anything here.");
  lines.push(`Work on the ${HANDS_LOCATION} presentation workbench. Working directory: ${cwd ?? "(inherited)"}.`);
  lines.push("");
  if (bundle.directive?.text) {
    lines.push(`Directive (the living sentence — honor it):\n${bundle.directive.text}`);
    lines.push("");
  }
  if (bundle.theory?.text) {
    lines.push(`Theory (the story the pile is telling):\n${bundle.theory.text}`);
    lines.push("");
  }
  if (bundle.praise?.length) {
    lines.push("Keep-outs (praise — do not break these):");
    for (const item of bundle.praise) lines.push(`- ${item.text}`);
    lines.push("");
  }
  lines.push("This breath's nits (the work, all of it, in this one session):");
  for (const note of bundle.nits) lines.push(`- ${note.id} [seq ${note.seq}]: ${note.text}`);
  if (!bundle.nits?.length) lines.push("- (none)");
  lines.push("");
  if (bundle.wikiNodes?.length) {
    lines.push("Selected wiki notes (what the last hands learned; missable on purpose):");
    for (const node of bundle.wikiNodes) {
      const label = node.labels?.length ? `[${node.labels.join(", ")}] ` : "";
      lines.push(`- ${label}${node.text}`);
    }
    lines.push("");
  }
  lines.push(PACKET_PATCH_LIST);
  lines.push("");
  lines.push(PACKET_CYCLE);
  if (parentSession) {
    const address = parentAlias
      ? `Return address: session ${parentSession} (alias ${parentAlias}).`
      : `Return address: session ${parentSession}.`;
    lines.push(`${address} Results are delivered through qq-relay default steer.`);
  }
  return lines.join("\n");
}

export function createIterate({
  ctx,
  journal,
  wiki,
  settings,
  llm,
  agents,
  run = oneShot,
  registerHandsTools,
} = {}) {
  const attached = new Map();
  let liveHands = null;

  async function reviewDelivery({ bundle, text, cwd }) {
    const binding = settings?.get?.("reviewer");
    if (!binding) return { pass: false, reason: "reviewer role unbound" };
    const user = [
      "Directive:",
      bundle.directive?.text ?? "(none)",
      "",
      "Keep-outs (praise):",
      ...(bundle.praise ?? []).map((item) => `- ${item.text}`),
      "",
      "This breath's nits:",
      ...bundle.nits.map((note) => `- ${note.id}: ${note.text}`),
      "",
      `Hands delivery:\n${text || "(empty)"}`,
      "",
      collectReviewEvidence({ cwd }),
    ].join("\n");
    const verdict = await run(llm, binding, { system: REVIEWER_SYSTEM, user });
    const verdictText = String(verdict ?? "").trim();
    if (/^pass(?:$|\s)/i.test(verdictText)) return { pass: true, reason: "" };
    const reason = verdictText.replace(/^fail:?\s*/i, "").trim() || "not stated";
    return { pass: false, reason };
  }

  function mailRoot() {
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function") return () => {};
    return async (payload) => {
      try { await relay.send(payload); } catch {}
    };
  }

  /** Child completion → review → verdict mail to the desk. One shot. */
  function watchHandsReturn({ child, parentId, bundle, queued, cwd }) {
    const childId = child?.session?.id;
    let done = false;
    const finish = async (event) => {
      if (done || !childId) return;
      done = true;
      liveHands = null;
      const seq = Number.isSafeInteger(event?.seq) ? event.seq : 0;
      const aliases = typeof relayOf(ctx)?.alias === "function" ? relayOf(ctx).alias(childId) : undefined;
      const alias = aliases ?? "";
      const text = lastAssistantText(child.session?.events ?? []);
      const verdict = await reviewDelivery({ bundle, text, cwd });
      const sendMail = mailRoot();
      if (verdict.pass) {
        for (const note of bundle.nits) {
          try { journal.closeNote(parentId, { target: note.id, seq, reason: "review-pass" }); } catch {}
        }
        const dumped = [];
        for (const line of queued) {
          try {
            const node = wiki.dump(parentId, { text: line, seq, source: "hands" });
            dumped.push(node.id);
          } catch {}
        }
        queued.length = 0;
        const snippet = text.slice(0, 300) || "(no report)";
        const fileHint = dumped.length
          ? ` Wiki nodes to file: ${dumped.join(", ")}.`
          : "";
        await sendMail({
          fromId: childId,
          to: parentId,
          message: `hands ${alias ? `${alias} ` : ""}passed review.${fileHint} ${snippet}`,
          delivery: "default",
        });
      } else {
        queued.length = 0;
        const snippet = text.slice(0, 300) || "(no report)";
        await sendMail({
          fromId: childId,
          to: parentId,
          message: `hands ${alias ? `${alias} ` : ""}failed review: ${verdict.reason} ${snippet}`,
          delivery: "default",
        });
      }
    };
    const dispose = child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type === "turn/end") await finish(event);
    });
    return typeof dispose === "function" ? dispose : () => {};
  }

  function attach(agent) {
    if (!isIterateCandidate(agent)) return null;
    const session = agent.session;
    const sessionId = session.id;
    if (attached.has(sessionId)) return attached.get(sessionId);
    journal.ensure(sessionId);
    wiki.ensure(sessionId);
    hangLabel(ctx, sessionId);

    let lastProjection = "";
    let disposeAssemble;
    try {
      // Stable projection injected at request assemble (architect's pattern):
      // directive, theory, open nits / praise, selected wiki index. Same order
      // every turn. New entries append; the prefix never reshuffles.
      disposeAssemble = agent.ctx?.on?.("agent/request", async (_payload, next) => {
        try {
          const latest = `${journal.load(sessionId).entries.length}/${wiki.load(sessionId).entries.length}`;
          if (latest !== lastProjection) {
            lastProjection = latest;
            const body = [
              "desk projection (stable order):",
              formatProjection(journal.load(sessionId), wiki.index(sessionId)),
            ].join("\n");
            if (typeof session.append === "function") {
              session.append("user/message", pluginUserMessage(body, "notice"), { surfaceOp: "append" });
            }
          }
        } catch {
          // Projection is best-effort. Journal tools still answer on demand.
        }
        return next();
      });
    } catch {
      // Listeners are best-effort. Journal + wiki + label must survive.
    }

    const handle = {
      sessionId,
      detach() {
        disposeAssemble?.();
        clearLabel(ctx, sessionId);
        attached.delete(sessionId);
      },
    };
    attached.set(sessionId, handle);
    return handle;
  }

  function detach(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : agentOrId?.session?.id ?? agentOrId?.id;
    const handle = attached.get(sessionId);
    handle?.detach();
    return Boolean(handle);
  }

  async function go({ agent, justThese = false, includeIds = [] } = {}) {
    const relay = relayOf(ctx);
    if (!relay) return { status: "refused", reason: "go requires qq-relay" };
    const parent = agent?.session;
    if (!parent?.id || !isIterateCandidate(agent) || !attached.has(parent.id)) {
      return { status: "refused", reason: "go requires a live iterate session" };
    }
    if (liveHands) return { status: "refused", reason: "one live hands at a time; next go is a new child" };
    if (!settings?.get?.("reviewer")) {
      return { status: "refused", reason: "go requires the reviewer role binding" };
    }
    if (!agents || typeof agents.create !== "function") {
      return { status: "refused", reason: "go requires ctx.agents.create" };
    }
    const bundle = journal.collectBreath(parent.id, { justThese, includeIds });
    if (bundle.nits.length === 0) {
      return { status: "refused", reason: "praise-only is not work; nothing was sent" };
    }
    // Selected wiki nodes only. Missable on purpose.
    const selectedNodes = wiki.selected(parent.id, bundle.selected);
    const packet = buildHandsPacket({
      bundle: { ...bundle, wikiNodes: selectedNodes },
      cwd: parent.header?.cwd,
      parentSession: parent.id,
      parentAlias: typeof relay.alias === "function" ? relay.alias(parent.id) : undefined,
    });

    const childId = `session-${randomUUID()}`;
    const handsBinding = settings?.get?.("hands");
    const handle = await agents.create({
      sessionId: childId,
      meta: {
        cwd: parent.header?.cwd,
        parentSession: parent.id,
        origin: CHILD_ORIGIN,
      },
      ...(handsBinding
        ? { agentOptions: { provider: handsBinding.provider, model: handsBinding.model, ...(handsBinding.effort ? { reasoningEffort: handsBinding.effort } : {}) } }
        : {}),
    });
    const child = handle?.agent ?? handle;
    liveHands = { childId: child.session?.id ?? childId, bundle, queued: [] };
    const queued = liveHands.queued;
    registerHandsTools?.(child, queued);
    journal.recordGo(parent.id, {
      breath: bundle.breath,
      nitIds: bundle.nits.map((note) => note.id),
      child: child.session?.id ?? childId,
      seq: 0,
    });
    watchHandsReturn({ child, parentId: parent.id, bundle, queued, cwd: parent.header?.cwd });
    child.followup({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: packet }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
    const alias = typeof relay.alias === "function" ? relay.alias(child.session?.id ?? childId) : undefined;
    return {
      status: "ok",
      child: child.session?.id ?? childId,
      alias: alias ?? "",
      delivery: "default",
      breath: bundle.breath,
    };
  }

  return Object.freeze({
    attach,
    detach,
    go,
    attached: (sessionId) => attached.get(sessionId),
    live: () => liveHands,
    label: ITERATE_LABEL,
    project: (sessionId) => projectJournal(journal.load(sessionId)),
  });
}

export const internals = Object.freeze({
  lastAssistantText,
  buildHandsPacket,
  shotsHome,
  listShotEntries,
  collectPatchDiff,
  collectReviewEvidence,
  patchSurfacePaths,
});
