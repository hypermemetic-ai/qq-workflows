// Managed execution launcher for the pi Architect.
//
// Implementations run through the repository's existing managed pipeline
// (worktree preparation, implementer, reviewer, retry, landing). The profile
// calls that pipeline as a library in this process — no MCP transport, no MCP
// server process, and no new implementation path — and reports each phase back
// to the durable execution record so a restart stays inspectable.
//
// The pipeline's own completion notification targets a Codex thread by design;
// inside a pi session there is no Codex thread, so it reports "no codex context"
// and the Architect's durable delivery path (idle wake / busy queue) is the one
// that reaches the operator. Delivery is deduped by event ID, so a bounded
// Codex wakeup can never duplicate the pi delivery.

const PHASE_POLL_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export function loadManagedExecutionLauncher({ importModule = (specifier) => import(specifier) } = {}) {
  return async function launchManagedExecution({ kind, cwd, sessionId, onPhase }) {
    const pipeline = await importModule("../bin/mcp-server.mjs");
    if (typeof pipeline.dispatchExecution !== "function") {
      throw new Error("the repository's managed execution pipeline is unavailable (dispatchExecution missing)");
    }
    // The pipeline must be a revision that launches the implementer and reviewer
    // seats through the ONE central worker contract and refuses provider/model
    // overrides. A stale or foreign pipeline module fails closed here rather
    // than silently running the seats through a different harness.
    if (typeof pipeline.assertNoProviderOverrides !== "function" || !Array.isArray(pipeline.WORKER_SEATS)) {
      throw new Error(
        "the installed managed execution pipeline does not use the central worker launch contract (assertNoProviderOverrides/WORKER_SEATS missing); reinstall the integration source instead of substituting another harness",
      );
    }
    const started = await pipeline.dispatchExecution({ kind, cwd, sessionId });
    onPhase?.("implementing", started?.id ?? null);
    for (;;) {
      const view = await pipeline.checkExecution({ id: started.id });
      onPhase?.(view?.phase ?? "running", view?.activeTool?.name ?? null);
      if (view?.status !== "running") {
        return {
          ok: view?.status === "completed",
          status: view?.status ?? "failed",
          phase: view?.phase ?? null,
          result: view?.result ?? null,
          error: view?.error ?? null,
          executionId: started.id,
        };
      }
      await delay(PHASE_POLL_MS);
    }
  };
}
