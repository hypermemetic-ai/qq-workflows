export function createAdapter() {
  return {
    async *stream(options) {
      const delay = Number(process.env.FAKE_GROK_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((accept) => setTimeout(accept, delay));
      if (options.model !== "grok-4.6" || options.provider !== "xai-auth") throw new Error("wrong route");
      yield { type: "reasoning-delta", index: 0, text: "hidden" };
      const text = process.env.FAKE_GROK_TEXT ?? "review complete";
      yield { type: "text-delta", index: 1, text };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}
