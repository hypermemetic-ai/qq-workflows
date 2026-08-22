// Silent leftover bank. The pile is host-wide and per-project, not
// session-keyed. Look at what is already there: append or edit existing
// tickets, or create, including more than one.

export const BANK_SYSTEM = [
  "You bank unfinished leftover into the project task pile.",
  "You see the leftover and the live pile. Do not duplicate a ticket that already says this.",
  "If it belongs on an existing ticket, APPEND that id.",
  "If it belongs on several, APPEND each.",
  "If it should rewrite a ticket, EDIT that id.",
  "If it is new, CREATE.",
  "NOTHING if the leftover is already represented.",
  "Output only CREATE/APPEND/EDIT blocks or NOTHING. No essay.",
].join("\n");

export function formatBankPile(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "(empty pile)";
  return rows.map((row) => {
    const line = row.oneLine ? ` — ${row.oneLine}` : "";
    return `${row.id} [${row.project}] ${row.title}${line}`;
  }).join("\n");
}

function flushOp(current, ops) {
  if (!current) return;
  const body = current.body.join("\n").trim();
  if (current.kind === "create") {
    if (!current.title) return;
    ops.push({ op: "create", title: current.title, body });
    return;
  }
  if (current.kind === "append") {
    if (!current.id) return;
    ops.push({ op: "append", id: current.id, text: body || current.rest });
    return;
  }
  if (current.kind === "edit") {
    if (!current.id) return;
    const patch = { id: current.id };
    if (current.rest) patch.title = current.rest;
    if (body) patch.body = body;
    ops.push({ op: "edit", ...patch });
  }
}

export function parseBankOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^(nothing|none|\(none\)|n\/a)$/i.test(trimmed)) {
    return { action: "nothing", ops: [] };
  }
  const ops = [];
  let current = null;
  for (const line of trimmed.split(/\n/)) {
    const raw = line.trim();
    const create = /^CREATE\s+(\S.*)$/i.exec(raw);
    const append = /^APPEND\s+(\S+)\s*(.*)$/i.exec(raw);
    const edit = /^EDIT\s+(\S+)\s*(.*)$/i.exec(raw);
    if (create) {
      flushOp(current, ops);
      current = { kind: "create", title: create[1].trim(), body: [] };
      continue;
    }
    if (append) {
      flushOp(current, ops);
      current = { kind: "append", id: append[1].trim(), rest: append[2].trim(), body: [] };
      continue;
    }
    if (edit) {
      flushOp(current, ops);
      current = { kind: "edit", id: edit[1].trim(), rest: edit[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flushOp(current, ops);
  if (ops.length === 0) {
    return { action: "error", reason: "refused: need CREATE, APPEND, EDIT, or NOTHING", ops: [] };
  }
  return { action: "bank", ops };
}

function applyOps(tasks, ops) {
  const ids = [];
  for (const op of ops) {
    if (op.op === "create") {
      ids.push(String(tasks.create({ title: op.title, body: op.body ?? "" })));
      continue;
    }
    if (op.op === "append") {
      tasks.append(op.id, op.text);
      ids.push(String(op.id));
      continue;
    }
    if (op.op === "edit") {
      const patch = {};
      if (op.title) patch.title = op.title;
      if (op.body !== undefined) patch.body = op.body;
      tasks.edit(op.id, patch);
      ids.push(String(op.id));
    }
  }
  return ids;
}

/**
 * File leftover against the live pile. Falls back to create when the
 * scribe hop is unbound or the model output is unusable.
 */
export async function bankLeftover({
  tasks,
  title,
  leftover,
  llm,
  binding,
  run,
  project,
} = {}) {
  if (!tasks || typeof tasks.create !== "function") {
    return { status: "refused", reason: "bank requires qq-tasks" };
  }
  const prose = String(leftover ?? "").trim();
  const heading = String(title ?? "").trim() || "Leftover";
  if (!prose) return { status: "ok", action: "nothing", ids: [], title: heading };

  const canHop = llm && binding && typeof run === "function"
    && typeof tasks.list === "function";
  if (canHop) {
    try {
      const rows = typeof project === "string"
        ? tasks.list({ project })
        : tasks.list();
      const user = [
        "Leftover:",
        heading,
        prose,
        "",
        "Live pile:",
        formatBankPile(rows),
      ].join("\n");
      const raw = await run(llm, binding, { system: BANK_SYSTEM, user });
      const parsed = parseBankOutput(raw);
      if (parsed.action === "nothing") {
        return { status: "ok", action: "nothing", ids: [], title: heading };
      }
      if (parsed.action === "bank") {
        const ids = applyOps(tasks, parsed.ops);
        return {
          status: "ok",
          action: "bank",
          id: ids[0],
          ids,
          title: heading,
          ops: parsed.ops,
        };
      }
    } catch {
      // Fall through to create so the leftover is not lost.
    }
  }

  const id = String(tasks.create({ title: heading, body: prose, project }));
  return { status: "ok", action: "bank", id, ids: [id], title: heading };
}

export function bankNotice(filed, title) {
  const heading = title || filed?.title || "Leftover";
  if (filed?.action === "nothing") return "Leftover already on the pile.";
  const ids = filed?.ids ?? (filed?.id ? [filed.id] : []);
  if (ids.length === 0) return `Leftover banked: ${heading}`;
  return `Leftover banked as ${ids.join(", ")}: ${heading}`;
}
