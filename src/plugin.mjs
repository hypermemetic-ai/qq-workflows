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
export const inject = ["agents", "sessions", "tools"];
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

  const tools = ctx.get("tools");
  ctx.effect(
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
