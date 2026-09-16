#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureTicket, ticketPath } from "../workflow/ticket.mjs";

// Orca IDE names its CLI 'orca-ide' on Linux to avoid colliding with GNOME's
// screen reader ('/usr/bin/orca'). On macOS and other platforms, it is 'orca'.
function resolveOrcaCli() {
  const binaryName = process.platform === "linux" ? "orca-ide" : "orca";
  const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
  if (process.env.HOME) {
    pathDirs.push(join(process.env.HOME, ".local", "bin"));
  }
  for (const dir of pathDirs) {
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stdout.write("{}\n");
      return;
    }
    const data = JSON.parse(raw);
    const conversationId = data.conversationId;
    if (!conversationId) {
      process.stdout.write("{}\n");
      return;
    }

    const workspacePaths = data.workspacePaths;
    const cwd = (Array.isArray(workspacePaths) && workspacePaths.length > 0 && workspacePaths[0])
      ? workspacePaths[0]
      : (process.env.PWD || process.cwd());

    const concretePath = ticketPath(cwd, conversationId);
    const isNew = !existsSync(concretePath);

    // Ensure ticket exists on disk
    await ensureTicket(cwd, { sessionId: conversationId });

    // Inject the concrete ticket path on the first invocation or if newly created
    if (data.invocationNum === 1 || isNew) {
      try {
        const orcaBin = resolveOrcaCli();
        if (orcaBin) {
          const proc = spawn(orcaBin, ["file", "open", concretePath], {
            detached: true,
            stdio: "ignore",
          });
          proc.on("error", () => {});
          proc.unref();
        }
      } catch {
        // Suppress errors so it never blocks or crashes if Orca is unavailable or fails
      }

      const result = {
        injectSteps: [
          {
            ephemeralMessage: `The ticket for this session is \`.architect/tickets/${conversationId}.md\`.`,
          },
        ],
      };
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }

    process.stdout.write("{}\n");
  } catch (err) {
    process.stdout.write("{}\n");
  }
}

await main();
