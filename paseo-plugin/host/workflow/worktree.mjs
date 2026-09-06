import { execFile as execFileCb } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

function isRealCwd(cwd) {
  return typeof cwd === "string" && cwd.trim().length > 0;
}

const execFile = promisify(execFileCb);

export function implementerBranchName(kind, jobId) {
  return `architect/${kind}/${String(jobId).slice(0, 8)}`;
}

export async function createImplementerWorktree({
  cwd,
  branch,
  paseo = null,
  execFileFn = execFile,
  home = homedir(),
} = {}) {
  if (!isRealCwd(cwd)) throw new Error("delegate: source cwd missing");
  if (!branch) throw new Error("delegate: worktree branch missing");
  if (paseo?.workspaces?.create) {
    const handle = await paseo.workspaces.create({
      title: `implementer ${branch}`,
      source: {
        kind: "worktree",
        cwd,
        action: "branch-off",
        branchName: branch,
      },
    });
    try {
      await handle.refresh?.();
    } catch {
      /* directory may already be present */
    }
    const directory = handle.directory ?? handle.cwd ?? null;
    if (!isRealCwd(directory)) throw new Error("delegate: worktree cwd did not appear");
    return { cwd: directory, workspaceId: handle.id ?? null };
  }
  // A deterministic path lets recovery identify the worktree without creating another one.
  const paseoHome = process.env.PASEO_HOME || join(home, ".paseo");
  const dest = join(paseoHome, "worktrees", "architect", branch.replaceAll("/", "-"));
  await mkdir(dirname(dest), { recursive: true });
  await execFileFn("git", ["worktree", "add", "-b", branch, dest], { cwd, encoding: "utf8" });
  return { cwd: dest, workspaceId: null };
}
