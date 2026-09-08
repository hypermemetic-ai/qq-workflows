#!/usr/bin/env node
import { existsSync } from "node:fs";
import { ensureTicket, ticketPath } from "../workflow/ticket.mjs";

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
