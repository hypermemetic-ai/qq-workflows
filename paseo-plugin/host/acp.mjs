#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { startJsonRpcStdio } from "./jsonrpc-stdio.mjs";
import { runArchitectTurn } from "./loop.mjs";
import { contextWindow } from "./fold.mjs";
import { ARCHITECT_SYSTEM_PROMPT } from "./workflow/prompts.mjs";
import { architectTools } from "./workflow/tools.mjs";
import { callHost } from "./host-client.mjs";
import { indexWorkspace } from "./search/zg.mjs";
import { ARCHITECT_MODEL_ID, astraThoughtConfig } from "./config.mjs";
import { ARCHITECT_REASONING } from "./providers/model.mjs";
import { bumpGeneration, createTurnState, enqueueTurn, wakeIsStale } from "./turns.mjs";

import { createStore } from "./store.mjs";
import { supervisedArchitect } from "./providers/architect-provider.mjs";
const store = createStore();
const sessions = new Map();
const persist = (id, session) => store.put("session", id, { cwd: session.cwd, pairs: session.pairs, thinking: session.thinking });

const rpc = startJsonRpcStdio({
  async handler(message, { write }) {
    const { method, params, id } = message;
    if (method === "initialize") {
      return {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        agentInfo: { name: "architect", title: "Architect", version: "0.0.0" },
      };
    }
    if (method === "session/new" || method === "session/load") {
      const saved = method === "session/load" ? store.get("session", params.sessionId) : null;
      if (method === "session/load" && !saved) throw new Error("unknown session");
      const sessionId = saved ? params.sessionId : randomUUID();
      const cwd = saved?.cwd ?? params?.cwd ?? process.cwd();
      const session = {
        cwd,
        pairs: saved?.pairs ?? [],
        pending: null,
        alive: true,
        thinking: ARCHITECT_REASONING,
        ...createTurnState(),
      };
      sessions.set(sessionId, session);
      persist(sessionId, session);
      if (saved) sendContextWindow(write, sessionId, contextWindow(session.pairs));
      indexWorkspace(cwd, { wait: false }).catch((error) => {
        console.error("zg index", error);
      });
      session.wakeLoop = pumpWakes(sessionId, session, write);
      return {
        sessionId,
        models: {
          currentModelId: ARCHITECT_MODEL_ID,
          availableModels: [{ modelId: ARCHITECT_MODEL_ID, name: "GPT-6 Astra" }],
        },
        configOptions: [astraThoughtConfig(session.thinking)],
      };
    }
    if (method === "session/set_config_option") {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error("unknown session");
      if (params.configId === "thought_level" && typeof params.value === "string") {
        if (params.value !== "high") throw new Error("Architect uses Astra high");
        session.thinking = "high";
      }
      return { configOptions: [astraThoughtConfig(session.thinking)] };
    }
    if (method === "session/prompt") {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error("unknown session");
      const operatorText = promptText(params);
      const generation = bumpGeneration(session);
      session.pending?.abort();
      const controller = new AbortController();
      session.pending = controller;
      const result = await enqueueTurn(session, async () => {
        if (wakeIsStale(session, generation)) {
          throw new Error("architect prompt superseded");
        }
        controller.signal.throwIfAborted();
        return runSessionTurn({
          signal: controller.signal,
          session,
          sessionId: params.sessionId,
          operatorText,
          messageId: params.messageId ?? randomUUID(),
          write,
        });
      });
      session.pairs = result.pairs;
      persist(params.sessionId, session);
      sendContextWindow(write, params.sessionId, contextWindow(session.pairs));
      if (id !== undefined) {
        write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      }
      return undefined;
    }
    if (method === "session/cancel") {
      const session = sessions.get(params.sessionId);
      session?.pending?.abort();
      return undefined;
    }
    if (method === "shutdown" || method === "exit") {
      for (const session of sessions.values()) { session.alive = false; session.pending?.abort(); session.wakeController?.abort(); }
      return {};
    }
    throw new Error(`unsupported method: ${method}`);
  },
});

async function pumpWakes(sessionId, session, write) {
  while (session.alive) {
    try {
      session.wakeController = new AbortController();
      const peek = await callHost("/wakes", { agentId: sessionId, wait: true, take: false }, { signal: session.wakeController.signal });
      const pending = peek.wakes ?? [];
      if (!pending.length) continue;
      const generation = session.generation;
      await enqueueTurn(session, async () => {
        if (wakeIsStale(session, generation)) return;
        const body = await callHost("/wakes", { agentId: sessionId, take: true });
        const texts = body.wakes ?? [];
        for (let i = 0; i < texts.length; i += 1) {
          if (wakeIsStale(session, generation)) {
            await callHost("/wakes", { agentId: sessionId, requeue: texts.slice(i) });
            return;
          }
          const wake = texts[i];
          if (!store.get("wake_turn", wake.id)?.complete) {
            session.pending = new AbortController();
            await runWakeTurn({ session, sessionId, text: wake.text, write, wakeId: wake.id });
            store.put("wake_turn", wake.id, { complete: true });
          }
          await callHost("/wakes", { agentId: sessionId, ack: [wake.id] });
        }
      });
    } catch (error) {
      console.error("architect wakes", error);
      await sleep(1000);
    }
  }
}

async function runWakeTurn({ session, sessionId, text, write, wakeId }) {
  const messageId = `wake:${wakeId}`;
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    },
  });
  const result = await runSessionTurn({
    session,
    sessionId,
    operatorText: text,
    messageId,
    write,
    wakeId,
  });
  session.pairs = result.pairs;
  persist(sessionId, session);
  sendContextWindow(write, sessionId, contextWindow(session.pairs));
  return result;
}

async function runSessionTurn({ session, sessionId, operatorText, messageId, write, signal = session.pending?.signal, wakeId }) {
  const turnKey = `${sessionId}:${wakeId ?? randomUUID()}`;
  try { return await runArchitectTurn({
    messageId,
    onContextWindow: ids => sendContextWindow(write, sessionId, ids),
    state: store.get("turn", turnKey),
    complete: request => supervisedArchitect(request, { store, turnKey }),
    saveState: state => store.put("turn", turnKey, state),
    reconcileTool: call => callHost('/tool-result', { requestId: `${turnKey}:${call.id}` }, { signal }),
    cwd: session.cwd,
    signal,
    checkpoint: (kind, value) => store.put("checkpoint", `${sessionId}:${kind}`, { value, wakeId }),
    operatorText,
    pairs: session.pairs,
    executeTool: (name, args, { callId }) => callHost("/tool", {
      name,
      arguments: args,
      context: {
        requestId: `${turnKey}:${callId}`,
        cwd: session.cwd,
        agentId: sessionId,
        paseoAgentId: process.env.PASEO_AGENT_ID,
      },
    }, { signal }).then((body) => body.result),
    onDelta: async (text) => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
    },
    onTool: async (call) => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: call.status === "pending" ? "tool_call" : "tool_call_update",
            toolCallId: call.id,
            title: call.name,
            status: call.status === "pending" ? "pending" : "completed",
            rawInput: call.arguments ?? {},
            content: call.output == null ? undefined : [{ type: "content", content: { type: "text", text: String(typeof call.output === "string" ? call.output : JSON.stringify(call.output)) } }],
          },
        },
      });
    },
    tools: architectTools(),
    systemPrompt: ARCHITECT_SYSTEM_PROMPT,
    reasoning: session.thinking ?? ARCHITECT_REASONING,
  }); } catch (error) {
    sendContextWindow(write, sessionId, contextWindow(session.pairs));
    throw error;
  }
}

function sendContextWindow(write, sessionId, selection) {
  write({ jsonrpc: "2.0", method: "_paseo/context_window", params: { sessionId, ...selection } });
}

function promptText(params) {
  const prompt = params?.prompt ?? params?.content ?? [];
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return String(prompt ?? "");
  return prompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text ?? "";
      if (typeof block?.text === "string") return block.text;
      return "";
    })
    .join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void rpc;
