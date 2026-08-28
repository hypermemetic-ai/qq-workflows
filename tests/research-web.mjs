#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchWorkspace, readManifest } from "../src/research-evidence.mjs";
import { createResearchWeb } from "../src/research-web.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-research-web."));
const repo = join(scratch, "repo"); mkdirSync(repo);
const workspace = await createResearchWorkspace({ parentDir: join(scratch, "runs"), repoRoot: repo, question: "q" });
let gets = 0;
const provider = {
  async search(query) {
    assert.equal(query, "alpha beta");
    return { results: [
      { title: "Alpha", url: "https://example.test/a#fragment", description: "first lead" },
      { title: "Alpha duplicate", url: "https://example.test/a", description: "duplicate" },
      { title: "Beta", url: "https://example.test/b", description: "second lead" },
    ] };
  },
  async get(url) {
    gets++;
    return { source: url, contentType: "text/html", status: 200, content: "<html><body><h1>Alpha</h1><p>Authoritative fact.</p><script>hidden()</script></body></html>" };
  },
};
const web = createResearchWeb({ workspace, provider });
const table = await web.search("alpha beta");
assert.match(table, /W001\tAlpha\thttps:\/\/example\.test\/a/);
assert.match(table, /W002\tBeta/);
assert.equal((await readManifest(workspace)).length, 0, "search leads are not evidence");
const first = await web.get("W001");
assert.equal(gets, 1);
assert.match(first.path, /W001\.md$/);
assert.equal((await readManifest(workspace)).length, 1);
const second = await web.get("W001");
assert.equal(gets, 1, "already acquired refs are never fetched again");
assert.equal(second.sha256, first.sha256);
const reconstructed = createResearchWeb({ workspace, provider });
assert.equal((await reconstructed.get("W001")).sha256, first.sha256);
assert.equal(gets, 1);
assert.equal((await web.search("alpha beta")).includes("W001"), true, "refs stay stable");
console.log("research web: ok");
