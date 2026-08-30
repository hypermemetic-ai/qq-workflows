/** Aggregate DSH-native provider usage without double-counting reasoning. */
export function usageFrom(events) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    processed_tokens: 0,
  };
  const requestModels = [];
  const responseModels = [];
  let requestCount = 0;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    const message = event.data?.message;
    const item = event.data?.usage;
    if (!item || typeof item !== "object") continue;
    const uncached = Number.isInteger(item.inputTokens) ? item.inputTokens : 0;
    const cacheRead = Number.isInteger(item.cacheReadTokens) ? item.cacheReadTokens : 0;
    const cacheWrite = Number.isInteger(item.cacheWriteTokens) ? item.cacheWriteTokens : 0;
    const output = Number.isInteger(item.outputTokens) ? item.outputTokens : 0;
    usage.input_tokens += uncached;
    usage.output_tokens += output;
    usage.cache_read_tokens += cacheRead;
    usage.cache_write_tokens += cacheWrite;
    usage.reasoning_tokens += Number.isInteger(item.reasoningTokens) ? item.reasoningTokens : 0;
    requestCount += 1;
    const provider = message?.source?.provider;
    const model = message?.source?.model;
    if (provider !== "xai-auth") throw new Error(`qq Mini QA response used unexpected provider ${String(provider)}`);
    if (typeof model === "string") responseModels.push(model);
  }
  usage.processed_tokens = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens + usage.output_tokens;
  for (let index = 0; index < requestCount; index += 1) requestModels.push("grok-4.6");
  return { usage, requestCount, requestModels, responseModels };
}

export function eventCount(events, predicate) {
  return events.reduce((count, event) => count + (predicate(event) ? 1 : 0), 0);
}

/** Validate secret-free HTTP attempt JSONL emitted by the trusted qq-models wrapper. */
export function providerAttempts(text) {
  const attempts = String(text).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  for (const item of attempts) {
    if (item?.schema !== "qq.grok-provider-attempt/v1") throw new Error("invalid qq provider attempt schema");
    if (item.model !== "grok-4.6") throw new Error(`qq provider attempt used unexpected model ${String(item.model)}`);
    if (typeof item.ok !== "boolean") throw new Error("qq provider attempt omitted status evidence");
    if (item.status !== null && (!Number.isInteger(item.status) || item.status < 100 || item.status > 599)) {
      throw new Error("qq provider attempt has invalid HTTP status");
    }
  }
  return attempts;
}
