// The owned Architect profile: prompt, tool policy, compaction policy, and the
// Paseo launch configuration that selects it in the app.
//
// The profile is deliberately narrow and self-contained so it can be asserted
// at the runtime/provider boundary: the final system prompt is the owned
// Architect prompt (plus explicitly included repository instructions), the tool
// surface has no shell/editor/write path, and long sessions compact under an
// Architect-specific policy instead of relying on the shared pi default.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ARCHITECT_PROVIDER_ID = "qq-architect";
export const ARCHITECT_PROVIDER_LABEL = "Architect (qq-workflows)";
export const ARCHITECT_PROFILE_ENV = "QQ_ARCHITECT_PROFILE";
export const ARCHITECT_OWNER_ENV = "QQ_ARCHITECT_OWNER_AGENT_ID";
export const ARCHITECT_PROMPT_MARKER = "<!-- qq-architect:owned-system-prompt -->";

// Repository root of this checkout, used to locate the owned prompt and the
// extension file the provider entry injects.
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ARCHITECT_PROMPT_FILE = join(REPO_ROOT, "agents", "architect", "agent.md");
export const ARCHITECT_EXTENSION_FILE = join(REPO_ROOT, "pi-extension", "qq-architect.mjs");

// Local inspection stays read-only. `bash`, `edit`, and `write` are never part
// of this profile: the Architect inspects and delegates, and only ticket
// updates plus the managed delegation path mutate anything.
export const ARCHITECT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const ARCHITECT_DENIED_TOOLS = ["bash", "edit", "write"];

// Completion-delivery readiness. A session_start handler runs while pi is still
// opening the session; a completion must not fabricate a turn there. This profile
// therefore starts delivery (and restart recovery) on a deferred tick that runs
// after the handler returned and pi's own initialization continuation resumed.
export const ARCHITECT_DELIVERY = {
  readyDelayMs: 0,
};

// Strings that identify pi's stock coding-assistant prompt. Their presence in
// the assembled Architect prompt means an uncontrolled default or append leaked.
export const STOCK_PROMPT_MARKERS = [
  "You are an expert coding assistant operating inside pi",
  "Available tools:",
];

// Architect-specific long-session policy. pi's shared setting disables automatic
// compaction globally; this profile compacts itself at a threshold so a long
// architecture session cannot silently overflow the context window.
export const ARCHITECT_COMPACTION = {
  enabled: true,
  // Compact before the model's own reserve is exhausted; expressed as a fraction
  // of the context window so it scales with the selected model.
  triggerFraction: 0.75,
  reserveTokens: 24_576,
  keepRecentTokens: 20_000,
  // Bounded: at most one compaction attempt per window, and none while a
  // compaction is already in flight or the session is streaming.
  minIntervalMs: 60_000,
};

export function stripFrontmatter(markdown) {
  const text = String(markdown ?? "");
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1).replace(/^\s*\n/, "");
}

export function loadArchitectPrompt({ promptFile = ARCHITECT_PROMPT_FILE, readFile = readFileSync } = {}) {
  const raw = readFile(promptFile, "utf8");
  const body = stripFrontmatter(raw).trim();
  if (!body) throw new Error(`owned Architect prompt is empty: ${promptFile}`);
  if (/^name:\s*architect/m.test(raw) === false) {
    // Not fatal: the frontmatter is optional for a custom prompt, but an empty
    // role file must never be silently accepted as the owned prompt.
    if (body.length < 40) throw new Error(`owned Architect prompt looks malformed: ${promptFile}`);
  }
  return body;
}

// Profile guidance is owned text, appended to the owned prompt so the workflow
// capability contract travels with the profile rather than with the tool list.
export const ARCHITECT_PROFILE_GUIDANCE = `## Environment

You are running as the qq-workflows Architect inside pi, launched by Paseo. The workflow session identity is the Paseo agent ID: your ticket is fixed for this session and survives reopen and resume.

- Inspect the repository with the read-only tools (read, grep, find, ls). You have no shell, editor, or write tool; deliberate delegation is the mutation path.
- Update the ticket with update_ticket (section-scoped edits preferred).
- Delegate read-only investigation with dispatch_runner, then await_runner or check_runner. Runner findings live in a durable report: read_report returns it in chunks, so long reports are never lost to a transport cap.
- When the operator approves the ticket, use the managed execution pipeline rather than editing code or landing branches yourself.
- Job records, cancellation tombstones, and undelivered completion results survive a restart. If a job is reported interrupted or reconciliation-required, treat it as unknown: inspect the artifacts with check_runner/list_jobs and decide explicitly instead of assuming completion.
- Completion notifications are delivered to this session: an idle turn is started for you, and while you are busy the result is queued (never injected mid-turn). Never infer a result from a notification alone; read it.`;

function formatProjectsContext(contextFiles = []) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) return "";
  let out = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const file of contextFiles) {
    const path = file?.path ?? "(unknown)";
    const content = file?.content ?? "";
    out += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
  }
  return `${out}</project_context>\n`;
}

function formatSkills(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const lines = skills
    .map((skill) => (skill?.name ? `- ${skill.name}: ${skill.description ?? ""}`.trim() : null))
    .filter(Boolean);
  if (lines.length === 0) return "";
  return `\n\n<available_skills>\n\n${lines.join("\n")}\n</available_skills>\n`;
}

// Assemble the FINAL Architect system prompt. The owned prompt replaces pi's
// stock prompt entirely; repository instructions and skills are re-included
// through this single controlled mechanism, and the profile marker makes the
// replacement auditable.
export function assembleArchitectSystemPrompt({
  ownedPrompt,
  contextFiles = [],
  skills = [],
  cwd = null,
  guidance = ARCHITECT_PROFILE_GUIDANCE,
} = {}) {
  if (typeof ownedPrompt !== "string" || !ownedPrompt.trim()) {
    throw new Error("the owned Architect prompt is required to assemble the system prompt");
  }
  let prompt = `${ARCHITECT_PROMPT_MARKER}\n${ownedPrompt.trim()}`;
  if (guidance) prompt += `\n\n${String(guidance).trim()}`;
  prompt += formatProjectsContext(contextFiles);
  prompt += formatSkills(skills);
  if (cwd) prompt += `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;
  return prompt;
}

// Guard used at the runtime/provider boundary and in tests: the assembled
// prompt must be ours and must not carry the stock coding prompt.
export function inspectAssembledPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const markers = STOCK_PROMPT_MARKERS.filter((marker) => text.includes(marker));
  const duplications = text.split(ARCHITECT_PROMPT_MARKER).length - 1;
  return {
    ok: text.includes(ARCHITECT_PROMPT_MARKER) && markers.length === 0 && duplications === 1,
    ownedMarkerCount: duplications,
    stockMarkers: markers,
    hasOwnedMarker: text.includes(ARCHITECT_PROMPT_MARKER),
  };
}

// Rewrite provider-level system instructions so the final payload carries
// exactly the assembled Architect prompt. Handles the shapes pi's providers
// serialize: Responses `instructions`, Anthropic `system`, and a leading system
// message. Returns what it changed so callers can assert at the boundary.
export function enforceProviderPayloadPrompt(payload, prompt) {
  if (!payload || typeof payload !== "object") return { replaced: false, path: null, payload };
  const next = Array.isArray(payload) ? [...payload] : { ...payload };
  if (typeof next.instructions === "string") {
    next.instructions = prompt;
    return { replaced: true, path: "instructions", payload: next };
  }
  if (typeof next.system === "string") {
    next.system = prompt;
    return { replaced: true, path: "system", payload: next };
  }
  if (Array.isArray(next.system)) {
    const blocks = next.system.filter((block) => block && block.type === "text");
    if (blocks.length > 0) {
      next.system = [{ ...blocks[0], text: prompt }, ...next.system.filter((block) => !blocks.includes(block))];
      return { replaced: true, path: "system[]", payload: next };
    }
  }
  if (Array.isArray(next.messages) && next.messages[0]?.role === "system") {
    next.messages = [{ ...next.messages[0], content: prompt }, ...next.messages.slice(1)];
    return { replaced: true, path: "messages[0]", payload: next };
  }
  return { replaced: false, path: null, payload: next };
}

// ---------------------------------------------------------------------------
// Paseo launch configuration (app-selectable Architect).
// ---------------------------------------------------------------------------

// The custom provider entry written into the daemon config. It extends `pi`, so
// the operator's model selection and pi authentication are preserved, and it
// injects ONLY the owned extension: `--no-extensions` keeps global pi
// extensions (Orca helpers, the obsolete dangling qq/subagent links) out of the
// Architect session while Paseo's own generated extension still loads through
// the explicit `--extension` Paseo passes itself.
export function architectProviderEntry({ repoRoot = REPO_ROOT, piBinary = "pi" } = {}) {
  const extension = join(repoRoot, "pi-extension", "qq-architect.mjs");
  return {
    extends: "pi",
    label: ARCHITECT_PROVIDER_LABEL,
    description: "qq-workflows Architect: owned prompt, read-only inspection, native workflow tools.",
    command: [piBinary, "--no-extensions", "--extension", extension],
  };
}

export function architectAgentProfile({ providerId = ARCHITECT_PROVIDER_ID } = {}) {
  return {
    id: providerId,
    name: "Architect",
    provider: providerId,
    notes:
      "Ticket-driven planning and architecture. Owns the session ticket, inspects read-only, and delegates implementation/review through the managed pipeline. Choose this for architecture sessions; the model is whatever you select.",
  };
}

export function isArchitectProfile(env = process.env) {
  return env?.[ARCHITECT_PROFILE_ENV] === "1";
}

// Merge the provider entry and profile into an existing daemon config without
// touching unrelated configuration. Returns the next config plus a change report.
export function applyArchitectPaseoConfig(
  config,
  { repoRoot = REPO_ROOT, providerId = ARCHITECT_PROVIDER_ID, enablePlugins = false } = {},
) {
  const base = config && typeof config === "object" ? config : {};
  const agents = { ...(base.agents ?? {}) };
  const providers = { ...(agents.providers ?? {}) };
  const entry = architectProviderEntry({ repoRoot });
  const previous = providers[providerId];
  providers[providerId] = entry;
  agents.providers = providers;

  const daemon = { ...(base.daemon ?? {}) };
  const profiles = Array.isArray(daemon.agentProfiles) ? [...daemon.agentProfiles] : [];
  const profileEntry = architectAgentProfile({ providerId });
  const profileIndex = profiles.findIndex((profile) => profile?.id === providerId);
  if (profileIndex === -1) profiles.push(profileEntry);
  else profiles[profileIndex] = { ...profiles[profileIndex], ...profileEntry, ...(profiles[profileIndex].model ? { model: profiles[profileIndex].model } : {}) };
  daemon.agentProfiles = profiles;

  const changes = [];
  if (!previous) changes.push("provider-added");
  else if (JSON.stringify(previous) !== JSON.stringify(entry)) changes.push("provider-updated");
  if (profileIndex === -1) changes.push("profile-added");

  // The binding plugin only runs while the daemon-wide plugin switch is on
  // (resolvePluginStatus requires pluginsEnabled === true). Setting it is part of
  // installing this architecture, not a side effect: without it the plugin half of
  // the profile is inert. The pre-install backup restores the previous value.
  const next = { ...base, agents, daemon };
  if (enablePlugins) {
    if (base.pluginsEnabled !== true) changes.push("plugins-enabled");
    next.pluginsEnabled = true;
  }

  return { config: next, changes, providerId };
}

// Remove only what this installer owns.
export function removeArchitectPaseoConfig(config, { providerId = ARCHITECT_PROVIDER_ID } = {}) {
  const base = config && typeof config === "object" ? config : {};
  const agents = { ...(base.agents ?? {}) };
  const providers = { ...(agents.providers ?? {}) };
  const removedProvider = Boolean(providers[providerId]);
  delete providers[providerId];
  agents.providers = providers;

  const daemon = { ...(base.daemon ?? {}) };
  const profiles = Array.isArray(daemon.agentProfiles) ? daemon.agentProfiles.filter((profile) => profile?.id !== providerId) : [];
  const removedProfile = Array.isArray(daemon.agentProfiles) && profiles.length !== daemon.agentProfiles.length;
  if (Array.isArray(daemon.agentProfiles)) daemon.agentProfiles = profiles;

  return {
    config: { ...base, agents, daemon },
    removed: { provider: removedProvider, profile: removedProfile },
    providerId,
  };
}
