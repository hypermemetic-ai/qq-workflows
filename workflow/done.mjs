export function normalizeFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("findings must be an array");
  return findings.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`finding ${index} must be an object`);
    if (typeof item.path !== "string" || typeof item.body !== "string") throw new Error(`finding ${index} requires string path and body`);
    const path = item.path.trim();
    const body = item.body.trim();
    const line = Number(item.line);
    if (!path || !body || (!Number.isInteger(line) || line < 1)) {
      throw new Error(`finding ${index} requires path, line, and body`);
    }
    return { path, line, body };
  });
}

export function routeDone({
  role,
  kind = null,
  reviewRound = 0,
  findings,
  completion,
} = {}) {
  if (role === "teacher") {
    return { action: "wake_architect", wake: "teacher" };
  }
  if (role === "researcher") {
    return { action: "wake_architect", wake: "researcher" };
  }
  if (role === "implementer") {
    if (completion === "report") return { action: "wake_architect", wake: "researcher" };
    if (kind === "bounded") {
      return { action: "commit_pr_merge", reviewer: false };
    }
    if (kind === "open") {
      return { action: "commit_spawn_reviewer" };
    }
    throw new Error("implementer done requires kind bounded or open");
  }
  if (role === "reviewer") {
    if (!Array.isArray(findings)) throw new Error("reviewer done requires findings array");
    const list = normalizeFindings(findings);
    if (list.length === 0) return { action: "pr_merge", findings: list };
    if (reviewRound <= 1) {
      return { action: "spawn_implementer_same_worktree", findings: list, reviewRound: 2 };
    }
    return { action: "wake_architect", wake: "reviewer", findings: list };
  }
  throw new Error(`unknown done role: ${String(role ?? "")}`);
}

export function formatTeacherWake({ parked_question, answer }) {
  return [
    "Teacher returned.",
    `Parked question: ${String(parked_question ?? "").trim()}`,
    `Answer: ${String(answer ?? "").trim()}`,
    "Put the decision in the ticket.",
  ].join("\n");
}

export function formatResearcherWake({ answer } = {}) {
  return String(answer ?? "").trim();
}

export function formatReviewerWake({ findings, packet }) {
  const list = normalizeFindings(findings);
  const findingLines = list.map((item) => `- ${item.path}:${item.line} ${item.body}`);
  const files = Array.isArray(packet?.files) ? packet.files : [];
  const orientation = files.map((file) => {
    const hunks = Array.isArray(file.hunks)
      ? file.hunks.map((hunk) => hunk.header ?? `${file.path}:${hunk.newStart}`).join(", ")
      : "";
    return `- ${file.path}${file.sha ? ` @ ${file.sha}` : ""}${hunks ? ` (${hunks})` : ""}`;
  });
  const sha = packet?.headSha ? ` ${packet.headSha}` : "";
  return [
    "Review still has findings after one correction pass.",
    "Findings:",
    ...(findingLines.length ? findingLines : ["- (none)"]),
    "Change:",
    ...(orientation.length ? orientation : ["- (no packet files)"]),
    `The change has not been landed.${sha ? ` Head:${sha}.` : ""}`,
  ].join("\n");
}
