export function createAdapter() {
  return {
    async *stream(options) {
      if (options.model !== "grok-4.6" || options.provider !== "xai-auth") throw new Error("wrong route");
      yield { type: "reasoning-delta", index: 0, text: "hidden" };
      yield { type: "text-delta", index: 1, text: "review " };
      yield { type: "text-delta", index: 1, text: "complete" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 } };
      yield { type: "finish-reason", reason: { kind: "stop" } };
    },
  };
}
