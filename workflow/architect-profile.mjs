// The owned Architect profile: prompt, tool policy, compaction policy, and the
// Paseo launch configuration that selects it in the app.
//
// The profile is deliberately narrow and self-contained so it can be asserted
// at the runtime/provider boundary: the final system prompt is the owned
// Architect prompt (plus explicitly included repository instructions), the tool
// surface has no shell/editor/write path, and long sessions compact under an
// Architect-specific policy instead of relying on the shared pi default.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
//
// `receiptDelayMs` defers the receipt check the same way, and for the same
// reason in the other direction: pi appends the custom-message session entry
// AFTER its extension handlers returned (`_handleAgentEvent` persists on
// message_end), so a receipt may only be read on a later task, never inside the
// handler that observed the consumption.
export const ARCHITECT_DELIVERY = {
  readyDelayMs: 0,
  receiptDelayMs: 0,
};

// The custom message type the Architect sends for a completion. Its `details`
// carry the stable event/job identity, which pi persists verbatim into the
// session entry — that entry is the receipt recovery reconciles against.
export const ARCHITECT_COMPLETION_CUSTOM_TYPE = "qq-workflow-completion";

// Strings that identify pi's stock coding-assistant prompt. Their presence in
// the assembled Architect prompt means an uncontrolled default or append leaked.
export const STOCK_PROMPT_MARKERS = [
  "You are an expert coding assistant operating inside pi",
  "Available tools:",
];

// Architect-specific long-session policy. pi's shared setting disables automatic
// compaction globally; this profile compacts itself at a threshold so a long
// architecture session cannot silently overflow the context window.
//
// `triggerFraction`, `reserveTokens` and `minIntervalMs` are enforced by the
// extension itself (see `pi-extension/qq-architect.mjs`), which is what makes
// the policy effective even while pi's own auto-compaction is switched off.
// `keepRecentTokens` cannot be passed through `ctx.compact()`: pi 0.84.1 accepts
// only `customInstructions`/`onComplete`/`onError` there and reads the retention
// budget from `~/.pi/agent/settings.json` / `<cwd>/.pi/settings.json`. Rewriting
// those would leak the profile into unrelated pi sessions, so the profile
// declares a retention FLOOR and verifies the runtime's effective value against
// it (`readPiCompactionSettings` + `inspectCompactionPolicy`) instead of
// pretending to set it.
export const ARCHITECT_COMPACTION = {
  enabled: true,
  // Compact before the model's own reserve is exhausted; expressed as a fraction
  // of the context window so it scales with the selected model.
  triggerFraction: 0.75,
  reserveTokens: 24_576,
  // Retention floor the runtime's effective `compaction.keepRecentTokens` must
  // meet. Divergence below it is reported, never silently accepted.
  keepRecentTokens: 20_000,
  // Bounded: at most one compaction attempt per window, and none while a
  // compaction is already in flight or the session is streaming.
  minIntervalMs: 60_000,
};

// pi's own fallbacks (dist/core/compaction/compaction.js DEFAULT_COMPACTION_SETTINGS
// and dist/core/settings-manager.js getCompaction*), used when a settings file is
// absent or does not mention compaction.
export const PI_COMPACTION_DEFAULTS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export function piAgentDir(env = process.env) {
  const override = String(env?.PI_CODING_AGENT_DIR ?? "").trim();
  return override || join(homedir(), ".pi", "agent");
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Read the compaction settings pi will actually use. This is the supported,
// documented channel (pi docs/settings.md: global `~/.pi/agent/settings.json`,
// project `<cwd>/.pi/settings.json`, project overriding global); the profile
// only READS them. A missing or malformed file falls back to pi's defaults, and
// only the three keys that drive compaction are read.
export function readPiCompactionSettings({ cwd = null, env = process.env, readFile = readFileSync } = {}) {
  const paths = [join(piAgentDir(env), "settings.json")];
  if (cwd) paths.push(join(cwd, ".pi", "settings.json"));
  const effective = { ...PI_COMPACTION_DEFAULTS };
  const sources = [];
  for (const path of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(path, "utf8"));
    } catch {
      continue; // absent, unreadable, or malformed: pi's default for this scope
    }
    const compaction = parsed && typeof parsed === "object" ? parsed.compaction : null;
    if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) continue;
    if (typeof compaction.enabled === "boolean") effective.enabled = compaction.enabled;
    effective.reserveTokens = numberOr(compaction.reserveTokens, effective.reserveTokens);
    effective.keepRecentTokens = numberOr(compaction.keepRecentTokens, effective.keepRecentTokens);
    sources.push(path);
  }
  return { ...effective, sources };
}

// Compare the runtime's effective compaction settings with this profile's
// policy. The findings are deliberately truthful rather than corrective: the
// profile cannot change another scope's settings, so a divergence is surfaced.
export function inspectCompactionPolicy({ settings, policy = ARCHITECT_COMPACTION, contextWindow = null } = {}) {
  const effective = {
    ...PI_COMPACTION_DEFAULTS,
    ...(settings && typeof settings === "object" ? settings : {}),
  };
  const findings = [];
  if (effective.keepRecentTokens < policy.keepRecentTokens) {
    findings.push({
      code: "retention-below-profile-floor",
      effective: effective.keepRecentTokens,
      floor: policy.keepRecentTokens,
    });
  }
  const window = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null;
  if (window && effective.keepRecentTokens + policy.reserveTokens >= window) {
    // pi cannot cut the session down far enough in this window: the retained
    // tail plus the profile's reserve already fills it, so a manual compaction
    // can end up with nothing to summarize.
    findings.push({
      code: "retention-exceeds-window-budget",
      effective: effective.keepRecentTokens,
      reserve: policy.reserveTokens,
      window,
    });
  }
  return { ok: findings.length === 0, effective, window, findings };
}

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
- Consult relevant ADRs while framing a change: search_adrs looks up the project's committed ADR corpus (docs/adr) and read_adr returns one ADR's full exact text. Capture the decisions this change consequently makes in the ticket. A retrieved ADR is a lookup hit — never automatic mandate or approval.
- Update the ticket with update_ticket (section-scoped edits preferred).
- Delegate investigation (research, inspection, reproduction, diagnostics) with dispatch_runner and report the outcome when its completion notification arrives; check_runner is the point-in-time read (never a wait loop). Runner findings live in a durable report: read_report returns it in chunks, so long reports are never lost to a transport cap.
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

// Roles that carry a request's system instruction inside a message list. pi
// writes `system` for most models and `developer` where the provider supports
// it (openai-completions and openai-responses both branch on
// `supportsDeveloperRole`), so both are treated as the system slot.
const SYSTEM_MESSAGE_ROLES = new Set(["system", "developer"]);

function isTextBlock(block) {
  return Boolean(block) && typeof block === "object" && typeof block.text === "string";
}

// Collapse a block array onto a single owned text block: the first text block
// keeps its metadata and receives the assembled prompt, every other text block
// is DROPPED. Dropping (rather than keeping) the remaining text blocks is what
// makes an append from another extension or the daemon unable to leak: a second
// text block in the same slot is exactly that append. Non-text blocks (images,
// cache markers, tool parts) are preserved untouched.
function collapseTextBlocks(blocks, prompt, insert = null) {
  if (!Array.isArray(blocks)) return null;
  const index = blocks.findIndex(isTextBlock);
  if (index === -1) return insert ? [insert(), ...blocks] : null;
  const head = { ...blocks[index], text: prompt };
  const rest = blocks.filter((block, position) => position !== index && !isTextBlock(block));
  return [head, ...rest];
}

function replaceMessageContent(content, prompt) {
  if (typeof content === "string") return prompt;
  // A system slot with no text block at all (only, say, a cache marker): the
  // owned prompt must still BE the system instruction, so it is inserted rather
  // than reported as unenforceable.
  return collapseTextBlocks(content, prompt, () => ({ type: "text", text: prompt }));
}

function replaceSystemMessage(messages, prompt) {
  if (!Array.isArray(messages)) return null;
  const index = messages.findIndex((message) => message && typeof message === "object" && SYSTEM_MESSAGE_ROLES.has(message.role));
  if (index === -1) return null;
  const content = replaceMessageContent(messages[index].content, prompt);
  if (content === null) return null;
  const next = [...messages];
  next[index] = { ...messages[index], content };
  return next;
}

// Google's system instruction: a plain string, or `{parts:[{text}]}` inside the
// request config (`config.systemInstruction` for the @google/genai SDK shape,
// `systemInstruction` for the REST shape).
function enforceSystemInstruction(target, prompt) {
  if (typeof target.systemInstruction === "string") {
    target.systemInstruction = prompt;
    return true;
  }
  const parts = target.systemInstruction?.parts;
  if (Array.isArray(parts)) {
    const next = collapseTextBlocks(parts, prompt, () => ({ text: prompt }));
    if (next) {
      target.systemInstruction = { ...target.systemInstruction, parts: next };
      return true;
    }
  }
  return false;
}

// Rewrite provider-level system instructions so the final payload carries
// exactly the assembled Architect prompt. Covers every shape pi 0.84.1 actually
// serializes for the models an Architect session can select:
//   * `instructions`            — OpenAI/Codex Responses (openai-codex-responses)
//   * `input[].role=developer|system` — OpenAI Responses (`input`)
//   * `messages[].role=developer|system` — openai-completions, Mistral
//   * `system` string / `system[]` — Anthropic messages, Bedrock Converse
//   * `systemInstruction` / `config.systemInstruction` — Google Generative AI
//     and Vertex (string or `{parts:[{text}]}`)
// Returns what it changed so callers can assert at the boundary; a payload with
// no system slot is reported as `replaced:false` rather than claimed.
export function enforceProviderPayloadPrompt(payload, prompt) {
  if (!payload || typeof payload !== "object") return { replaced: false, path: null, payload };
  const next = Array.isArray(payload) ? [...payload] : { ...payload };
  const done = (path) => ({ replaced: true, path, payload: next });

  if (typeof next.instructions === "string") {
    next.instructions = prompt;
    return done("instructions");
  }
  if (enforceSystemInstruction(next, prompt)) return done("systemInstruction");
  if (next.config && typeof next.config === "object" && !Array.isArray(next.config)) {
    const config = { ...next.config };
    if (enforceSystemInstruction(config, prompt)) {
      next.config = config;
      return done("config.systemInstruction");
    }
  }
  if (typeof next.system === "string") {
    next.system = prompt;
    return done("system");
  }
  const systemBlocks = collapseTextBlocks(next.system, prompt);
  if (systemBlocks) {
    next.system = systemBlocks;
    return done("system[]");
  }
  const messages = replaceSystemMessage(next.messages, prompt);
  if (messages) {
    next.messages = messages;
    return done("messages");
  }
  const input = replaceSystemMessage(next.input, prompt);
  if (input) {
    next.input = input;
    return done("input");
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
