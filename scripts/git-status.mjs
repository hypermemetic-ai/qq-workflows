#!/usr/bin/env node
// Run from the checkout being inspected. Fetch updates only its upstream ref.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--cached")) {
  console.error("Usage: node /path/to/scripts/git-status.mjs [--cached]");
  process.exit(1);
}
const git = (args, options = {}) => spawnSync("git", args, {
  encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...options,
});
function required(args) {
  const result = git(args);
  if (result.status !== 0) {
    console.error(result.error?.message || result.stderr.trim());
    process.exit(1);
  }
  return result.stdout.trim();
}

required(["rev-parse", "--show-toplevel"]);
const branch = git(["symbolic-ref", "--quiet", "HEAD"]).stdout.trim();
const [remote, source, upstream] = branch
  ? required(["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)", branch]).split("\t")
  : [];
let exitCode = 0;
if (!upstream) {
  console.log("Remote: no upstream; ahead/behind unavailable.");
} else if (remote === ".") {
  console.log("Upstream: local branch; no remote check needed.");
} else if (args.includes("--cached")) {
  console.log("Remote freshness: UNKNOWN (cached mode); ahead/behind below uses cached refs.");
} else if (!upstream.startsWith("refs/remotes/")) {
  console.log("Remote freshness: UNKNOWN (upstream is not a remote-tracking ref).");
  exitCode = 2;
} else {
  const fetched = git(["-c", "credential.interactive=false", "-c", "gc.auto=0", "fetch",
    "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-prune",
    "--", remote, `+${source}:${upstream}`], { timeout: 15_000 });
  if (fetched.status === 0) {
    console.log(`Remote checked: ${remote} at ${new Date().toISOString()}.`);
  } else {
    console.log("Remote freshness: UNKNOWN (fetch failed or timed out); ahead/behind below uses cached refs.");
    console.error(fetched.error?.message || fetched.stderr.trim());
    exitCode = 2;
  }
}
const status = required(["--no-optional-locks", "-c", "advice.statusHints=false", "status", "--untracked-files=normal"]);
console.log(status);
process.exitCode = exitCode;
