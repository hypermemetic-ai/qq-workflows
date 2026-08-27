// URL-capable product capture for iterate hands. The design-loop fixture
// remains a harness; this shoots whatever page the nits are about.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DESIGN_LOOP_URL = new URL("./frontend-design-loop.mjs", import.meta.url);

function execAgentBrowser(env, args) {
  return new Promise((resolveExec) => {
    const child = spawn("agent-browser", ["--session", "frontend-design-loop", ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolveExec({ code: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolveExec({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function captureProduct(options = {}) {
  const impl = options.impl ?? await import(DESIGN_LOOP_URL);
  if (typeof impl.captureShots === "function") {
    try {
      return await impl.captureShots(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/fixture is not running|needs a url/.test(message)) throw error;
    }
  }
  const env = options.env ?? process.env;
  const url = typeof options.url === "string" ? options.url.trim() : "";
  if (!url) throw new Error("capture needs a url or a running design-loop fixture");
  const label = impl.sanitizeLabel(options.label ?? "current");
  const dir = impl.shotsDir(label, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = options.short ? ["desktop", "phone", "short"] : ["desktop", "phone"];
  const browser = async (args) => {
    const result = await execAgentBrowser(env, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `agent-browser ${args[0]} failed`);
    }
    return result.stdout;
  };
  await browser(["open", url]);
  if (options.reload !== false) await browser(["reload"]);
  const shots = {};
  for (const name of names) {
    const viewport = impl.VIEWPORTS[name];
    const path = join(dir, `${name}.png`);
    await browser(["set", "viewport", String(viewport.width), String(viewport.height)]);
    await browser(["screenshot", path]);
    shots[name] = path;
  }
  return { label, dir, shots, sessionUrl: url };
}
