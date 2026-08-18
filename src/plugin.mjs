// qq-workflows: one repository, one plugin. Cordis entry point.
//
// Loading this plugin is how a DSH host gets named workflows. Loading qq
// does not imply workflows. The first workflow is architect.

import { createNotebookStore, defaultNotebookDir } from "./notebook.mjs";
import { createClerk } from "./clerk.mjs";
import { DEFAULT_H, createFolder } from "./fold.mjs";
import { resolveScribeBinding } from "./scribe.mjs";
import { buildArchitectTools } from "./tools.mjs";
import { createArchitect, isArchitectSession } from "./architect.mjs";

export const name = "qq-workflows";
// Same load gate as qq-relay. Tools stay optional: register when the host
// tools service appears, via nested ctx.inject rather than a hard inject.
export const inject = ["agents", "sessions"];
export const provide = "qq-workflows";

export function apply(ctx, config = {}) {
  const store = createNotebookStore(defaultNotebookDir(process.env, config), {
    now: config.now,
  });
  const binding = resolveScribeBinding(config, process.env);
  const llm = ctx.get("llm", false);
  const tokenMeter = ctx.get("tokenMeter", false);
  const sessionQuery = ctx.get("sessionQuery", false);
  const agents = ctx.get("agents");
  const clerk = createClerk({
    store,
    llm,
    binding,
    run: config.runScribe,
  });
  const folder = createFolder({
    store,
    tokenMeter,
    h: config.h ?? DEFAULT_H,
    q: config.q,
    now: config.now,
  });
  const architect = createArchitect({
    ctx,
    store,
    clerk,
    folder,
    agents,
  });
  const service = Object.freeze({
    store,
    clerk,
    folder,
    architect,
    scribe: binding,
  });
  ctx.provide("qq-workflows", service);

  const registerTools = (toolCtx) => {
    const tools = toolCtx.get("tools", false);
    if (!tools || typeof tools.register !== "function") return;
    toolCtx.effect(
      () => {
        const disposers = buildArchitectTools({
          store,
          sessionQuery,
          invoke: (args) => architect.invoke(args),
        }).map((tool) => tools.register(tool));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      "qq-workflows: tools",
    );
  };
  // Wait for the host tools service without making it a hard plugin inject.
  // A one-shot get at apply time races the tools fiber and drops registration.
  if (typeof ctx.inject === "function") ctx.inject(["tools"], registerTools);
  else registerTools(ctx);

  ctx.on("agent/created", ({ agent }) => {
    if (isArchitectSession(agent)) architect.attach(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    architect.detach(agent);
  });

  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        if (isArchitectSession(agent)) architect.attach(agent);
      } catch {
        // One live agent must not unload the plugin (or its tools).
      }
    }
  }
}
