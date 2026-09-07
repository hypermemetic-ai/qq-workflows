#!/usr/bin/env node
import { startJsonRpcStdio } from "./jsonrpc-stdio.mjs";
import { roleTools } from "./workflow/tools.mjs";
import { callHost } from "./host-client.mjs";

const role = process.env.ARCHITECT_ROLE;
const jobId = process.env.ARCHITECT_JOB_ID;
const workspace = process.env.ARCHITECT_WORKSPACE ?? process.cwd();
const hostUrl = process.env.ARCHITECT_HOST;

const tools = role ? roleTools(role) : [];

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
      return { tools: tools.map(asMcpTool) };
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!role) throw new Error("ARCHITECT_ROLE is not set");
      if (!tools.some(tool => tool.name === name)) throw new Error(`${role} cannot execute ${name}`);
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
