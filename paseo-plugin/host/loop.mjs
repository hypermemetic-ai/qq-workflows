import { assembleArchitectRequest, rememberPair, requestPairs, contextWindow } from "./fold.mjs";
import { ARCHITECT_SYSTEM_PROMPT } from "./workflow/prompts.mjs";
import { architectTools } from "./workflow/tools.mjs";
import { completeArchitect } from "./providers/model.mjs";
import { ticketRead } from "./workflow/ticket.mjs";

export async function runArchitectTurn({
  cwd,
  operatorText,
  messageId,
  onContextWindow,
  pairs = [],
  executeTool,
  complete = completeArchitect,
  onDelta,
  onTool,
  tools = architectTools(),
  systemPrompt = ARCHITECT_SYSTEM_PROMPT,
  reasoning,
  signal,
  checkpoint,
  state,
  saveState = async () => {},
  reconcileTool = async () => null,
} = {}) {
  const ticket = await ticketRead(cwd);
  let input = assembleArchitectRequest({
    systemPrompt,
    ticketText: ticket.text,
    pairs,
    operatorText,
  }).input;
  if (state?.pendingTool) {
    const saved = await reconcileTool(state.pendingTool);
    if (!saved?.known) throw new Error(`Interrupted tool ${state.pendingTool.name} has an unknown outcome; inspection is required before resuming`);
    state = { ...state, pendingTool: null, nextTool: state.nextTool + 1, outputs: [...(state.outputs ?? []), { type: 'function_call_output', call_id: state.pendingTool.id, output: stringifyTool(saved.value) }] };
    await saveState(state);
  }
  const exchangeStart = state?.exchangeStart ?? input.length - (operatorText != null ? 1 : 0);
  if (state?.input) input = state.input;
  const selectedContext = state?.contextWindow ?? (state?.contextMessageIds
    ? { userMessageIds: state.contextMessageIds }
    : contextWindow(requestPairs(pairs, operatorText), messageId));
  const persistState = saveState;
  saveState = value => persistState({ ...value, exchangeStart, contextWindow: selectedContext });
  await onContextWindow?.(selectedContext);
  const instructions = systemPrompt;
  const assistantParts = state?.assistantParts ?? [];
  let retained = state?.result;
  let nextTool = state?.nextTool ?? 0;
  let retainedOutputs = state?.outputs ?? [];
  while (true) {
    signal?.throwIfAborted();
    const result = retained ?? await complete({ instructions, input, tools, onDelta, reasoning, signal, checkpoint });
    signal?.throwIfAborted();
    await checkpoint?.("response", result);
    if (!retained && result.text) assistantParts.push(result.text);
    await saveState({ input, assistantParts, result, nextTool, outputs: retainedOutputs });
    if (!result.toolCalls?.length) {
      input = [...input, ...responseItems(result)];
      break;
    }
    const callItems = responseItems(result);
    const outputItems = retainedOutputs;
    for (const [index, call] of result.toolCalls.entries()) {
      if (index < nextTool) continue;
      signal?.throwIfAborted();
      if (!tools.some(tool => tool.name === call.name)) throw new Error(`Architect cannot execute ${call.name}`);
      await onTool?.({ ...call, status: "pending" });
      let output;
      try {
        await saveState({ input, assistantParts, result, nextTool: index, outputs: outputItems, pendingTool: call });
        await checkpoint?.("tool_pending", call);
        output = await executeTool(call.name, call.arguments ?? {}, { signal, callId: call.id });
        await checkpoint?.("tool_result", { ...call, output });
      } catch (error) {
        signal?.throwIfAborted();
        output = `tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
      await onTool?.({ ...call, status: "completed", output });
      outputItems.push({
        type: "function_call_output",
        call_id: call.id,
        output: stringifyTool(output),
      });
      await saveState({ input, assistantParts, result, nextTool: index + 1, outputs: outputItems });
    }
    input = [...input, ...callItems, ...outputItems];
    retained = null; nextTool = 0; retainedOutputs = [];
    await saveState({ input, assistantParts });
  }
  const architectText = assistantParts.join("");
  return {
    architectText,
    pairs: rememberPair(pairs, operatorText, architectText, messageId, input.slice(exchangeStart)),
    ticket: (await ticketRead(cwd)).text,
  };
}

export function functionCallItems(result) {
  const fromRaw = (result?.functionCalls ?? result?.raw?.output ?? []).filter(
    (item) => item?.type === "function_call" || item?.type === "tool_call",
  );
  if (fromRaw.length) return fromRaw;
  return (result?.toolCalls ?? []).map((call) => ({
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: typeof call.arguments === "string"
      ? call.arguments
      : JSON.stringify(call.arguments ?? {}),
  }));
}

function stringifyTool(output) {
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2);
}

// Replay the complete response, including opaque reasoning and intermediate prose.
export function responseItems(result) {
  if (result?.raw?.output?.length) return result.raw.output;
  return [
    ...(result.text ? [{ role: "assistant", content: result.text }] : []),
    ...functionCallItems(result),
  ];
}
