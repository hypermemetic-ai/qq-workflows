// /workflows grammar. The wrapper lists and selects; each workflow owns settings.

export function parseWorkflowsInput(rawInput) {
  const tokens = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "list" };
  const [head, ...rest] = tokens;
  if (head === "none" || head === "off") {
    if (rest.length > 0) return { action: "error", text: "usage: /workflows none" };
    return { action: "clear" };
  }
  if (head === "settings") {
    if (rest.length === 0) return { action: "settings-list", workflow: null };
    const [workflow, role, provider, model, effort, ...extra] = rest;
    if (!role) return { action: "settings-list", workflow };
    if (!provider || !model || extra.length > 0) {
      return {
        action: "error",
        text: "usage: /workflows settings <workflow> <role> <provider> <model> [effort]",
      };
    }
    return {
      action: "settings-write",
      workflow,
      role,
      binding: {
        provider,
        model,
        ...(effort ? { effort } : {}),
      },
    };
  }
  if (rest.length > 0) return { action: "error", text: `usage: /workflows ${head}` };
  return { action: "select", workflow: head };
}

export const SETTINGS_ROLES = Object.freeze({
  architect: Object.freeze(["talking", "hands"]),
  land: Object.freeze(["router", "qa", "implementer"]),
  base: Object.freeze(["talking"]),
});

export const SETTINGS_PROVIDERS = Object.freeze(["openai-codex", "xai-auth"]);

export const SETTINGS_MODELS = Object.freeze({
  "openai-codex": Object.freeze(["gpt-5.6-sol"]),
  "xai-auth": Object.freeze(["grok-4.6"]),
});

export const SETTINGS_EFFORTS = Object.freeze({
  "gpt-5.6-sol": Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]),
  "grok-4.6": Object.freeze(["low", "medium", "high", "xhigh"]),
});

function matching(values, partial) {
  return values.filter((value) => value.startsWith(partial));
}

function sharedPrefix(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * Next-token completion for `/workflows` raw input (bytes after the command name).
 * `rawInput` includes the leading separator space from parseCommand, if any.
 */
export function completeWorkflowsInput(rawInput, {
  names = [],
  roles = SETTINGS_ROLES,
} = {}) {
  const raw = String(rawInput ?? "");
  const trailingSpace = /\s$/.test(raw) || /^\s+$/.test(raw);
  const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);
  const partial = trailingSpace || tokens.length === 0 ? "" : tokens.at(-1);
  const committed = trailingSpace || tokens.length === 0 ? tokens : tokens.slice(0, -1);
  const selectable = [...names, "none", "settings"].sort();
  let pool = [];
  if (committed.length === 0) {
    pool = selectable;
  } else if (committed[0] === "settings") {
    if (committed.length === 1) {
      pool = Object.keys(roles).sort();
    } else if (committed.length === 2) {
      pool = [...(roles[committed[1]] ?? [])];
    } else if (committed.length === 3) {
      pool = [...SETTINGS_PROVIDERS];
    } else if (committed.length === 4) {
      pool = [...(SETTINGS_MODELS[committed[3]] ?? [])];
    } else if (committed.length === 5) {
      pool = [...(SETTINGS_EFFORTS[committed[4]] ?? [])];
    }
  }
  const candidates = matching(pool, partial);
  const fill = candidates.length === 1 ? candidates[0] : sharedPrefix(candidates);
  const spaced = candidates.length === 1 && (
    committed.length === 0
      ? fill === "settings"
      : committed[0] === "settings" && committed.length < 5
  );
  const nextPartial = fill.length > partial.length ? fill : partial;
  const completed = candidates.length === 0
    ? raw.replace(/\s+$/, "")
    : `${[...committed, nextPartial].join(" ")}${spaced ? " " : ""}`;
  return Object.freeze({
    completed,
    candidates: Object.freeze([...candidates]),
  });
}

export function completeComposerLine(line, options) {
  const value = String(line ?? "");
  const match = /^(\/workflows)([\t ]+.*)?$/su.exec(value);
  if (!match) {
    const commands = ["/workflows"];
    const candidates = matching(commands, value);
    if (value.length === 0 || !value.startsWith("/")) {
      return Object.freeze({ completed: value, candidates: Object.freeze([]) });
    }
    const fill = candidates.length === 1 ? `${candidates[0]} ` : sharedPrefix(candidates);
    return Object.freeze({
      completed: fill.length > value.length ? fill : value,
      candidates: Object.freeze([...candidates]),
    });
  }
  const inner = completeWorkflowsInput(match[2] ?? "", options);
  return Object.freeze({
    completed: inner.candidates.length === 0 ? value : `/workflows ${inner.completed}`,
    candidates: inner.candidates,
  });
}

export function formatWorkflowList(names, selected) {
  const registered = Array.isArray(names) ? names : [];
  if (registered.length === 0 && !selected) return "no workflows loaded";
  const lines = registered.map((name) => (name === selected ? `${name} (selected)` : name));
  if (selected && !registered.includes(selected)) lines.push(`${selected} (selected, unbound)`);
  else if (!selected) lines.push("none selected");
  return lines.length > 0 ? lines.join("\n") : "no workflows loaded";
}
