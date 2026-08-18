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
  if (!Array.isArray(names) || names.length === 0) return "no workflows loaded";
  const lines = names.map((name) => (name === selected ? `${name} (selected)` : name));
  if (!selected) lines.push("none selected");
  return lines.join("\n");
}
