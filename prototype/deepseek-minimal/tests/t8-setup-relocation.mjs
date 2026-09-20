#!/usr/bin/env node
/**
 * Acceptance 8: runtime-root reproducibility and relocation.
 *
 * The production runtime root is materialized by
 * scripts/setup-runtime.mjs (fresh clone + install + build; see the promotion
 * receipt). This test exercises the same reviewed setup code at a SECOND fresh
 * private destination: profiles, overlay copy, plugin copy, relinked
 * dependencies, and provenance must all be materialized there, and the real
 * pinned harness must boot from the relocated root through the production
 * adapter entrypoint. Re-running setup must be idempotent.
 *
 * Only the multi-GB upstream compile is shared (guarded to the pinned commit
 * and tracked-clean); everything runtime-specific belongs to the destination.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepSeekMinimalRuntimeRoot } from "../../../workflow/worker-config.mjs";
import { setup } from "../scripts/setup-runtime.mjs";
import { resolveRuntime, runtimeLayout, verifyRuntimeProvenance } from "../adapter/runtime.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { cleanOutput, parseLines, PROTOTYPE_ROOT, runWorker, tempDir } from "./harness.mjs";

const PRODUCTION_ROOT = deepSeekMinimalRuntimeRoot();
const PRODUCTION_UPSTREAM = join(PRODUCTION_ROOT, "upstream");
assert.ok(existsSync(PRODUCTION_UPSTREAM), `the production runtime must already be materialized at ${PRODUCTION_ROOT}`);
const productionProvenance = verifyRuntimeProvenance(runtimeLayout({ runtimeRoot: PRODUCTION_ROOT }));

// --- fresh private destination (empty directory, outside any checkout) ------
const relocatedRoot = mkdtempSync(join(tmpdir(), "t8-relocated-runtime-"));
const first = setup({ runtimeRoot: relocatedRoot, upstreamRoot: PRODUCTION_UPSTREAM, skipBuild: true });

assert.equal(first.runtimeRoot, relocatedRoot, "the destination must own the runtime root");
assert.equal(first.dshHome, join(relocatedRoot, "dsh-home"));
assert.equal(first.head, productionProvenance.head, "the relocated runtime must be the same pinned commit");
assert.equal(first.version, productionProvenance.version);
assert.equal(first.lockfileSha256, productionProvenance.lockfileSha256, "same frozen lockfile");
assert.equal(first.globalDshUsed, false);
assert.equal(first.sourceCliVersion, productionProvenance.sourceCliVersion);
assert.ok(first.phases.includes("materialize-runtime-files") && first.phases.includes("link-plugins"));

// Provenance is authoritative from the destination, and the layout resolves there.
const relocated = verifyRuntimeProvenance(runtimeLayout({ runtimeRoot: relocatedRoot }));
assert.equal(relocated.head, productionProvenance.head);
assert.equal(relocated.runtimeRoot, relocatedRoot);

// Overlay copy is byte-identical to the reviewed source.
assert.equal(
  readFileSync(join(relocatedRoot, "profile", "read-image-only.patch.yml"), "utf8"),
  readFileSync(join(PROTOTYPE_ROOT, "profile", "read-image-only.patch.yml"), "utf8"),
  "the relocated overlay must be the reviewed overlay",
);

// The seat-scoped search overlay is copied byte-identically too, and the
// gateway it mounts is materialized with its own MCP protocol links.
assert.equal(
  readFileSync(join(relocatedRoot, "profile", "zvec-grep-gateway.patch.yml"), "utf8"),
  readFileSync(join(PROTOTYPE_ROOT, "profile", "zvec-grep-gateway.patch.yml"), "utf8"),
  "the relocated search overlay must be the reviewed overlay",
);
assert.ok(existsSync(join(relocatedRoot, "gateway", "zvec-grep-gateway.mjs")), "the gateway script must be materialized at the destination");
assert.ok(existsSync(join(relocatedRoot, "gateway", "zvec-grep-search.tool.json")), "the reviewed tool snapshot must travel with the gateway");
const mcpClientModules = join(PRODUCTION_UPSTREAM, "packages", "mcp", "mcp-client", "node_modules");
for (const name of ["@modelcontextprotocol/server", "@modelcontextprotocol/client"]) {
  const link = join(relocatedRoot, "gateway", "node_modules", ...name.split("/"));
  assert.ok(lstatSync(link).isSymbolicLink(), `${name} must be linked into the destination gateway`);
  assert.equal(readlinkSync(link), join(mcpClientModules, ...name.split("/")), `${name} must resolve to the shared pinned upstream`);
}
const mcpBridgeLink = join(relocatedRoot, "dsh-home", "profiles", "sdk-minimal", "node_modules", "@deepseek-ai", "dsh-mcp-client");
assert.ok(lstatSync(mcpBridgeLink).isSymbolicLink(), "the overlay row's MCP bridge must be linked into the destination profile");
assert.equal(readlinkSync(mcpBridgeLink), join(PRODUCTION_UPSTREAM, "packages", "mcp", "mcp-client"));

// Plugin dependencies are re-linked at the destination (not inherited).
const profileLink = join(relocatedRoot, "dsh-home", "profiles", "sdk-minimal", "node_modules", "dsh-tool-read-image-only");
assert.ok(lstatSync(profileLink).isSymbolicLink(), "the profile must link the destination plugin");
assert.equal(readlinkSync(profileLink), join(relocatedRoot, "plugin", "dsh-tool-read-image-only"));
for (const [name, target] of [
  ["@deepseek-ai/dsh-tool-fs", join(PRODUCTION_UPSTREAM, "packages", "fs", "tool-fs")],
  ["@deepseek-ai/cordis", join(PRODUCTION_UPSTREAM, "vendor", "cordis")],
]) {
  const link = join(relocatedRoot, "plugin", "dsh-tool-read-image-only", "node_modules", name);
  assert.ok(lstatSync(link).isSymbolicLink(), `${name} must be linked into the destination plugin`);
  assert.equal(readlinkSync(link), target);
}
assert.ok(
  !existsSync(join(relocatedRoot, "dsh-home", "profiles", "sdk-minimal", "node_modules", "@deepseek-ai", "dsh-tool-fs")),
  "the read/write/edit tool suite must NOT be linked into the harness home",
);

// --- the relocated runtime boots the real harness through the entrypoint ----
const workdir = tempDir("t8-relocated-work");
const mock = await startMockProvider({
  scenario: { turns: [{ blocks: [{ type: "text", text: "FINAL: relocated runtime booted" }], stopReason: "end_turn" }] },
});
const mockUrl = mock.url;
const boot = await runWorker([
  "--seat", "implementer", "--cwd", workdir, "--prompt", "report the runtime",
  "--base-url", mockUrl, "--runtime-root", relocatedRoot,
]);
const request = mock.lastMessageRequest;
const mockRequests = mock.messageRequests;
await mock.close();
assert.equal(boot.code, 0, `the relocated runtime must boot: ${boot.stderr}`);
assert.equal(cleanOutput(parseLines(boot.stdout)), "FINAL: relocated runtime booted");
assert.equal(request.model, "deepseek-flash");
assert.equal(request.apiKeyIsDummy, true, "the mock path must keep its dummy credential");

// The production entrypoint resolves the same relocated root.
const runtime = resolveRuntime({ seat: "implementer", baseUrl: mockUrl, runtimeRoot: relocatedRoot, cwd: workdir });
assert.equal(runtime.provenance.runtimeRoot, relocatedRoot);
assert.equal(runtime.layout.overlay, join(relocatedRoot, "profile", "read-image-only.patch.yml"));
assert.equal(runtime.layout.plugin, join(relocatedRoot, "plugin", "dsh-tool-read-image-only"));
assert.equal(runtime.layout.searchOverlay, join(relocatedRoot, "profile", "zvec-grep-gateway.patch.yml"), "the search overlay must resolve to the destination, never a checkout");
assert.equal(runtime.layout.gateway, join(relocatedRoot, "gateway"), "the gateway must resolve to the destination, never a checkout");
assert.deepEqual(runtime.search, { root: workdir, seat: "implementer" }, "the search gateway must be bound to the seat worktree");
assert.deepEqual(runtime.launch.args.slice(-2), ["--patch", join(relocatedRoot, "profile", "zvec-grep-gateway.patch.yml")], "the relocated seat must receive the search overlay last");
const relocatedSurface = mockRequests.at(0).toolNames;
assert.deepEqual(relocatedSurface, ["bash", "mcp__zvec_grep__zvec_grep_search", "read_image"], "the relocated runtime must expose the search seat surface");
// The runner never gets the overlay: its surface and args stay baseline.
const runnerRuntime = resolveRuntime({ seat: "runner", baseUrl: mockUrl, runtimeRoot: relocatedRoot, cwd: workdir });
assert.equal(runnerRuntime.search, null);
assert.ok(!runnerRuntime.launch.args.includes(join(relocatedRoot, "profile", "zvec-grep-gateway.patch.yml")), "the runner must never receive the search overlay");

// --- idempotency: a second materialization is stable ------------------------
const second = setup({ runtimeRoot: relocatedRoot, upstreamRoot: PRODUCTION_UPSTREAM, skipBuild: true });
assert.equal(second.head, first.head);
assert.equal(second.version, first.version);
assert.equal(second.lockfileSha256, first.lockfileSha256);
assert.equal(verifyRuntimeProvenance(runtimeLayout({ runtimeRoot: relocatedRoot })).head, first.head);

// --- a root that cannot mount the gateway fails closed, loudly --------------
// dsh reports a failed plugin row as a warning, so the adapter must refuse the
// search seat BEFORE the harness starts rather than let it run without search.
{
  const hidden = `${join(relocatedRoot, "gateway")}.hidden`;
  renameSync(join(relocatedRoot, "gateway"), hidden);
  try {
    assert.throws(
      () => resolveRuntime({ seat: "implementer", baseUrl: mockUrl, runtimeRoot: relocatedRoot, cwd: workdir }),
      (error) => /zvec-grep search gateway is not materialized/u.test(error.message)
        && error.message.includes(`runtime root '${relocatedRoot}'`)
        && error.message.includes("missing gateway/zvec-grep-gateway.mjs")
        && /setup-runtime\.mjs against this root/u.test(error.message)
        && error.message.length < 400,
      "a search seat must fail closed with an actionable, bounded diagnostic",
    );
    // The runner is untouched by the missing gateway: its surface is baseline.
    const runnerWithoutGateway = resolveRuntime({ seat: "runner", baseUrl: mockUrl, runtimeRoot: relocatedRoot, cwd: workdir });
    assert.equal(runnerWithoutGateway.search, null);
    const refusedBoot = await runWorker([
      "--seat", "implementer", "--cwd", workdir, "--prompt", "report the runtime",
      "--base-url", mockUrl, "--runtime-root", relocatedRoot,
    ]);
    assert.equal(refusedBoot.code, 2, "the adapter must refuse to start a search seat without the gateway");
    assert.match(refusedBoot.stderr, /zvec-grep search gateway is not materialized/u);
    assert.equal(refusedBoot.stdout, "", "a refused seat must emit no protocol lines");
  } finally {
    renameSync(hidden, join(relocatedRoot, "gateway"));
  }
}

console.log("ok t8-setup-relocation");
console.log(JSON.stringify({ relocatedRoot, sharedUpstream: PRODUCTION_UPSTREAM, provenance: relocated }, null, 2));
