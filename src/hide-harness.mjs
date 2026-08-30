// qq-core defaults inherited tools to an empty surface. Each workflow chair
// opts into only the inherited tools it uses; agent-local registrations remain
// visible without appearing in these lists.

export const ARCHITECT_INHERITED_TOOLS = Object.freeze([
  "read",
  "grep",
  "glob",
  "bash",
  "relay_list",
  "relay_send",
  "relay_status",
]);

export const MINI_INHERITED_TOOLS = Object.freeze(["bash"]);

export const ITERATE_HANDS_INHERITED_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "bash",
]);

export const PROJECTS_INHERITED_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "read_image",
  "grep",
  "glob",
  "bash",
  "job_output",
  "job_list",
  "job_kill",
  "skill",
  "relay_list",
  "relay_send",
  "relay_status",
]);

export function allowInherited(ctx, agent, names) {
  const qq = ctx?.get?.("qq-core", false) ?? ctx?.get?.("qq-core") ?? ctx?.get?.("qq", false) ?? ctx?.get?.("qq");
  if (typeof qq?.surface?.allow !== "function") {
    throw new Error("qq-core surface.allow is required");
  }
  qq.surface.allow(agent ?? ctx, names);
}
