const HUNK = /^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@(.*)$/;

export function parseDiffHunks(diffText) {
  const files = [];
  let current = null;
  for (const raw of String(diffText ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = { path: pathFromGitDiff(raw), hunks: [] };
      files.push(current);
      continue;
    }
    if (raw.startsWith("+++ b/")) {
      const path = raw.slice(6);
      if (current && path !== "/dev/null") current.path = path;
      continue;
    }
    const match = HUNK.exec(raw);
    if (!match || !current) continue;
    current.hunks.push({
      header: raw,
      oldStart: Number(match[1]),
      oldCount: match[2] == null ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] == null ? 1 : Number(match[4]),
      context: match[5].trim(),
    });
  }
  return files.filter((file) => file.path);
}

export function buildPacket({ baseSha, headSha, files }) {
  return {
    baseSha: baseSha ?? null,
    headSha: headSha ?? null,
    files: (files ?? []).map((file) => ({
      path: file.path,
      sha: file.sha ?? null,
      hunks: (file.hunks ?? []).map((hunk) => ({
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
      })),
    })),
  };
}

export function renderPacket(packet) {
  const files = packet?.files ?? [];
  const lines = [
    `base: ${packet?.baseSha ?? "unknown"}`,
    `head: ${packet?.headSha ?? "unknown"}`,
    "files:",
  ];
  for (const file of files) {
    lines.push(`- ${file.path}${file.sha ? ` ${file.sha}` : ""}`);
    for (const hunk of file.hunks ?? []) {
      lines.push(`  ${hunk.header}`);
    }
  }
  if (files.length === 0) lines.push("- (none)");
  return lines.join("\n");
}

function pathFromGitDiff(line) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return match ? match[2] : "";
}
