#!/usr/bin/env node
/**
 * Acceptance 3: the scripted provider asks for `read_image` on a tiny local
 * fixture; the FOLLOWING real outbound provider request must carry that image
 * as either a Files reference (backed by a mock upload whose stored bytes
 * decode) or, when the Files endpoint fails, as inline base64 that decodes to
 * the same bytes. The receipt records digests only, never a credential.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { encodePng } from "../mock/png.mjs";
import { cleanOutput, evidenceDir, parseLines, runWorker, tempDir } from "./harness.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function runImageCase(filesMode) {
  const workdir = tempDir(`t3-${filesMode}`);
  const png = encodePng(3, 2, (x, y) => [x * 90, y * 120, 200]);
  const fixture = join(workdir, "fixture.png");
  writeFileSync(fixture, png);
  const mock = await startMockProvider({
    scenario: {
      filesMode,
      turns: [
        { blocks: [{ type: "tool_use", name: "bash", input: { command: "pwd; ls -l fixture.png" } }], stopReason: "tool_use" },
        { blocks: [{ type: "tool_use", name: "read_image", input: { file_path: fixture } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: `FINAL: image inspected (${filesMode})` }], stopReason: "end_turn" },
      ],
    },
  });
  const result = await runWorker(["--seat", "implementer", "--cwd", workdir, "--prompt", "inspect the fixture image", "--base-url", mock.url]);
  const requests = mock.messageRequests;
  const uploads = mock.journal.filter(entry => entry.kind === "files-upload");
  const receipt = mock.receipt();
  await mock.close();
  assert.equal(result.code, 0, `worker must succeed: ${result.stderr}`);
  assert.equal(cleanOutput(parseLines(result.stdout)), `FINAL: image inspected (${filesMode})`);
  return { receipt, requests, uploads, png, fixture };
}

// --- Files reference path ---------------------------------------------------
const fileCase = await runImageCase("ok");
const withImage = fileCase.requests.find(request => request.hasImage);
assert.ok(withImage !== undefined, "the post-read_image request must carry an image block");
assert.equal(withImage.model, "deepseek-flash");
assert.equal(withImage.effort, "max");
const wireImage = withImage.images[0];
assert.equal(wireImage.source, "file", "the default representation is a Files reference");
assert.equal(fileCase.uploads.length, 1, "exactly one mock upload must back the reference");
const upload = fileCase.uploads[0];
assert.equal(upload.outcome, "ok");
assert.equal(upload.sha256, sha256(fileCase.png), "uploaded bytes must be the fixture bytes");
assert.equal(upload.decodable, true, "uploaded bytes must decode as a real PNG");
assert.equal(upload.width, 3);
assert.equal(upload.height, 2);
assert.equal(upload.mediaType, "image/png");
assert.equal(wireImage.fileId, upload.fileId, "the wire reference must name the uploaded file");
// The receipt proves content arrived as bytes, not as a filename or printed base64.
const envelope = withImage.toolResults.map(entry => entry.text).join("\n");
assert.ok(!/^[A-Za-z0-9+/=]{40,}$/u.test(envelope), "no raw base64 blob may be the only image evidence");

// --- Inline base64 fallback path -------------------------------------------
const inlineCase = await runImageCase("error");
const inlineRequest = inlineCase.requests.find(request => request.hasImage);
assert.ok(inlineRequest !== undefined, "the fallback request must still carry the image");
assert.equal(inlineRequest.effort, "max");
assert.equal(inlineRequest.model, "deepseek-flash");
const inlineImage = inlineRequest.images[0];
assert.equal(inlineImage.source, "base64", "a failing Files API must fall back to inline bytes");
assert.equal(inlineCase.uploads.length, 1, "the failed upload attempt is recorded");
assert.equal(inlineCase.uploads[0].outcome, "error");
assert.equal(inlineImage.dataSha256, sha256(inlineCase.png), "inline base64 must decode to the fixture bytes");
assert.equal(inlineImage.decodable, true);
assert.equal(inlineImage.width, 3);
assert.equal(inlineImage.height, 2);
assert.equal(inlineImage.mediaType, "image/png");

for (const request of [...fileCase.requests, ...inlineCase.requests]) {
  assert.equal(request.apiKeyIsDummy, true, "only the dummy credential may be presented");
}
// Nothing may reach any endpoint other than this test's mock.
for (const journal of [...fileCase.receipt.requests, ...inlineCase.receipt.requests]) {
  assert.ok(journal.kind !== "unexpected-request", "no request may hit an unknown endpoint");
}
for (const kind of new Set([...fileCase.receipt.requests, ...inlineCase.receipt.requests].map(entry => entry.kind))) {
  assert.match(kind, /^(messages|messages-title|files-upload|files-list)$/u, `unexpected journal entry kind '${kind}'`);
}
for (const entry of [...fileCase.receipt.requests, ...inlineCase.receipt.requests]) {
  assert.ok(!("apiKey" in entry), "receipts must never carry a credential value");
}

const receiptPath = join(evidenceDir(), "read-image-receipts.json");
writeFileSync(receiptPath, `${JSON.stringify({
  recordedAt: new Date().toISOString(),
  fixtureSha256: sha256(fileCase.png),
  filesReferencePath: { requests: fileCase.receipt.requests, uploads: fileCase.receipt.uploads },
  inlineFallbackPath: { requests: inlineCase.receipt.requests, uploads: inlineCase.receipt.uploads },
}, null, 2)}\n`);
console.log("ok t3-read-image");
console.log(JSON.stringify({ receiptPath, reference: wireImage, inline: inlineImage, upload }, null, 2));
