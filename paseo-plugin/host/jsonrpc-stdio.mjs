import { createInterface } from "node:readline";

export function startJsonRpcStdio({ stdin = process.stdin, stdout = process.stdout, handler }) {
  const rl = createInterface({ input: stdin });
  const write = (message) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      try { await handler(message, { notify: true, write }); }
      catch (error) { console.error('ACP notification failed', error); }
      return;
    }
    try {
      const result = await handler(message, { notify: false, write });
      if (result !== undefined) write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error?.code ?? -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
  return {
    write,
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
  };
}
