import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SECRET_NAMES = ["BRAVE_API_KEY", "EXA_API_KEY"];

export function credentialsPath({ home = homedir(), env = process.env } = {}) {
  if (env.ARCHITECT_CREDENTIALS) return env.ARCHITECT_CREDENTIALS;
  return join(env.PASEO_HOME || join(home, ".paseo"), "architect", "credentials.yaml");
}

export function parseCredentialsYaml(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (SECRET_NAMES.includes(key) && value) out[key] = value;
  }
  return out;
}

export function loadResearchSecrets({
  env = process.env,
  home = homedir(),
  readFileFn = readFileSync,
} = {}) {
  const fromEnv = {};
  for (const name of SECRET_NAMES) {
    const value = String(env[name] ?? "").trim();
    if (value) fromEnv[name] = value;
  }
  let fromFile = {};
  try {
    fromFile = parseCredentialsYaml(readFileFn(credentialsPath({ home, env }), "utf8"));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...fromEnv };
}

export function withResearchSecrets(env = process.env) {
  return { ...env, ...loadResearchSecrets({ env }) };
}

export async function loadGrokToken(env = process.env) {
  const existing = String(env.XAI_API_KEY || env.OCR_LLM_TOKEN || "").trim();
  if (existing) return existing;
  const helper = env.GROK_TOKEN_HELPER || join(env.GROK_HOME || join(homedir(), ".grok"), "get-token.sh");
  try {
    const { stdout } = await exec(helper, [], { encoding: "utf8" });
    return String(stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}
