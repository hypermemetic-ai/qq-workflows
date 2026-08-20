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

export function formatWorkflowList(names, selected) {
  const registered = Array.isArray(names) ? names : [];
  if (registered.length === 0 && !selected) return "no workflows loaded";
  const lines = registered.map((name) => (name === selected ? `${name} (selected)` : name));
  if (selected && !registered.includes(selected)) lines.push(`${selected} (selected, unbound)`);
  else if (!selected) lines.push("none selected");
  return lines.length > 0 ? lines.join("\n") : "no workflows loaded";
}
