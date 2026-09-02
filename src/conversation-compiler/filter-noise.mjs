const NOISE_TOOLS = new Set([
  "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
  "AskUser", "ExitSpecMode", "GenerateDroid",
]);

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const isNoiseUserBlock = (text) => {
  const trimmed = text.trim();
  if (NOISE_STRINGS.some((string) => trimmed.includes(string))) return true;
  const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
  return stripped.length === 0;
};

const cleanUserText = (text) => text.replace(XML_WRAPPER_RE, "").trim();

export const filterNoise = (blocks) => {
  const output = [];
  for (const block of blocks ?? []) {
    if (block.kind === "tool_call" && NOISE_TOOLS.has(block.name)) continue;
    if (block.kind === "tool_result" && NOISE_TOOLS.has(block.name)) continue;
    if (block.kind === "user") {
      if (isNoiseUserBlock(block.text)) continue;
      const cleaned = cleanUserText(block.text);
      if (!cleaned) continue;
      // DSH adaptation: retain durable event sequence provenance.
      output.push({ ...block, kind: "user", text: cleaned });
      continue;
    }
    output.push(block);
  }
  return output;
};
