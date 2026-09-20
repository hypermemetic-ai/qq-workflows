import type { PluginServerContext } from "@getpaseo/plugin/server";
import { architectCreateRequest, architectSessionOpenRequest } from "./server/architect";

export default function contribute(server: PluginServerContext) {
  // Scoped to the Architect provider: other providers' agents are returned
  // unchanged, so direct native Codex/pi sessions keep their ordinary behaviour.
  server.before("agent.create", ({ request }) => architectCreateRequest(request as never) as never);
  server.before("agent.session_open", ({ request }) => architectSessionOpenRequest(request as never) as never);
  return () => {};
}
