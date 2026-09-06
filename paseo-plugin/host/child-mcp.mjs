#!/usr/bin/env node
import { startJsonRpcStdio } from "./jsonrpc-stdio.mjs";
import { DONE, TICKET_READ, TICKET_WRITE } from "./tools.mjs";
import { ZVEC_GREP_RG, ZVEC_GREP_SEARCH } from "./zg-tools.mjs";
import { callHost } from "./runtime.mjs";

const role = process.env.ARCHITECT_ROLE ?? "teacher";
const jobId = process.env.ARCHITECT_JOB_ID;
const workspace = process.env.ARCHITECT_WORKSPACE ?? process.cwd();
const hostUrl = process.env.ARCHITECT_HOST;

const ROLE_TOOLS = {
  teacher: [TICKET_READ, TICKET_WRITE, DONE, ZVEC_GREP_SEARCH, ZVEC_GREP_RG],
  implementer: [DONE],
};

function asMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} },
  };
}

startJsonRpcStdio({
  async handler(message) {
    const { method, params } = message;
    if (method === "initialize") {
      return {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        serverInfo: { name: "architect-child", version: "0.0.0" },
        capabilities: { tools: {} },
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return undefined;
    }
    if (method === "tools/list") {
      return { tools: (ROLE_TOOLS[role] ?? [DONE]).map(asMcpTool) };
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!(ROLE_TOOLS[role] ?? []).some(tool => tool.name === name)) throw new Error(`${role} cannot execute ${name}`);
      const body = await callHost("/tool", {
        name,
        arguments: args,
        context: { cwd: workspace, jobId, role },
      }, { hostUrl });
      const text = typeof body.result === "string" ? body.result : JSON.stringify(body.result, null, 2);
      return { content: [{ type: "text", text }] };
    }
    if (method === "ping") return {};
    throw new Error(`unsupported method: ${method}`);
  },
});
