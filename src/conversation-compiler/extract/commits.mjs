const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
const HASH_RE = /\b([0-9a-f]{7,12})\b/;
const firstLineOf = (text) => (text.split(/\\n|\n/)[0] ?? "").trim();
const cleanMessage = (message) => message.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

export const extractCommits = (blocks) => {
  const commits = [];
  for (let index = 0; index < (blocks?.length ?? 0); index += 1) {
    const block = blocks[index];
    if (block.kind !== "tool_call" || block.name !== "bash") continue;
    const command = typeof block.args.command === "string" ? block.args.command : "";
    if (!/\bgit\s+commit\b/.test(command)) continue;
    const match = command.match(COMMIT_MSG_RE);
    if (!match) continue;
    const message = firstLineOf(cleanMessage(match[1] ?? match[2] ?? match[3] ?? ""));
    if (!message) continue;
    let hash;
    for (let cursor = index + 1; cursor < Math.min(blocks.length, index + 3); cursor += 1) {
      const result = blocks[cursor];
      if (result.kind !== "tool_result") continue;
      const bracket = result.text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
      if (bracket) { hash = bracket[1]; break; }
      const range = result.text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
      if (range) { hash = range[2]; break; }
      const plain = result.text.match(HASH_RE);
      if (plain) { hash = plain[1]; break; }
    }
    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((commit) => `${commit.hash ?? ""}::${commit.message}` === key)) commits.push({ hash, message });
  }
  return commits;
};

export const formatCommits = (commits, limit = 8) => commits.slice(-limit).map((commit) =>
  `${commit.hash ? `${commit.hash}: ` : ""}${commit.message}`);
