// One-shot scribe hop for clerk and invoke-packet compilation.
//
// Uses the existing execution-profile `scribe` binding when present. The
// talking model is never asked to write notes or compile packets. DSH
// GenerateOptions has no cacheRetention field; a fresh sessionId on each
// call is the one-shot / no-reuse contract.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const CLERK_SYSTEM = [
  "You are the architect clerk. You receive the notebook and a spine of the latest operator+architect turn.",
  "Append one short note, or one withdraw line (\"X withdrawn / replaced by \u2026\"), or output NOTHING if the spine is empty or adds no durable fact.",
  "Do not dump the turn. Do not write reasoning. Do not rewrite the notebook.",
].join("\n");

export const PACKET_SYSTEM = [
  "You compile an invoke packet for a live child session.",
  "Read the notebook and the DSH log spine (text + tool names only). Write a short packet the child can start from.",
  "No reasoning. No tool dumps. No essay.",
].join("\n");

function defaultPolicyPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome && isAbsolute(configHome)) return join(configHome, "qq", "execution-profiles.json");
  const home = env.HOME || homedir();
  if (home && isAbsolute(home)) return join(home, ".config", "qq", "execution-profiles.json");
  return null;
}

/** Resolve the scribe binding from plugin config or the execution-profile file. */
export function resolveScribeBinding(config = {}, env = process.env) {
  if (config.scribe && typeof config.scribe.provider === "string" && typeof config.scribe.model === "string") {
    return {
      provider: config.scribe.provider,
      model: config.scribe.model,
      effort: config.scribe.effort,
    };
  }
  const path = config.executionProfilesPath ?? defaultPolicyPath(env);
  if (!path || !existsSync(path)) return null;
  try {
    const policy = JSON.parse(readFileSync(path, "utf8"));
    const scribe = policy.scribe ?? policy.compactor;
    if (!scribe || typeof scribe.provider !== "string" || typeof scribe.model !== "string") return null;
    return { provider: scribe.provider, model: scribe.model, effort: scribe.effort };
  } catch {
    return null;
  }
}

function textOfChunk(chunk) {
  if (chunk?.type === "text-delta" && typeof chunk.text === "string") return chunk.text;
  if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
    return chunk.block.text;
  }
  return "";
}

function userMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
  };
}

/**
 * One-shot llm.stream. Returns trimmed text, or empty string on miss/failure.
 * `cacheRetention: none` is recorded on the call options object for tests even
 * though DSH GenerateOptions does not accept the field; it is stripped before
 * the stream call.
 */
export async function runScribe(llm, binding, { system, user, signal } = {}) {
  if (!llm || typeof llm.stream !== "function") return "";
  if (!binding?.provider || !binding?.model) return "";
  const options = {
    provider: binding.provider,
    model: binding.model,
    ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
    system,
    messages: [userMessage(user)],
    sessionId: `session-${randomUUID()}`,
    cacheRetention: "none",
    ...(signal ? { signal } : {}),
  };
  const { cacheRetention: _none, ...request } = options;
  let text = "";
  try {
    for await (const chunk of llm.stream(request)) {
      if (chunk?.type === "text-delta") text += chunk.text ?? "";
    }
  } catch {
    return "";
  }
  return text.trim();
}

export function parseClerkOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^(nothing|none|\(none\)|n\/a)$/i.test(trimmed)) {
    return { action: "nothing" };
  }
  if (/\bwithdrawn\b/i.test(trimmed) || /^x withdrawn/i.test(trimmed)) {
    return { action: "withdraw", text: trimmed };
  }
  return { action: "note", text: trimmed };
}

export const internals = Object.freeze({
  defaultPolicyPath,
  textOfChunk,
  userMessage,
});
