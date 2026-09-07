#!/usr/bin/env node
import assert from "node:assert/strict";
import { mapOcrJson, runOcrReview } from "../paseo-plugin/host/workflow/ocr.mjs";

assert.deepEqual(mapOcrJson({ comments: [] }), []);
const skipped = { status: 'skipped', comments: [], message: 'No items selected', manifest: { coverage: { selected: [], failed: [] } } };
assert.throws(() => mapOcrJson(skipped), error => error.failureClass === 'process' && error.reviewEvidence.manifest === skipped.manifest);
assert.throws(() => mapOcrJson({ comments: [], manifest: { terminal_state: 'skipped' } }), /coverage incomplete/);
assert.deepEqual(
  mapOcrJson({
    comments: [{ path: "src/a.ts", start_line: 3, content: "off-by-one" }],
  }),
  [{ path: "src/a.ts", line: 3, body: "off-by-one" }],
);
assert.deepEqual(
  mapOcrJson({
    comments: [{ file_path: "src/a.ts", start_line: 4, content: "null deref" }],
  }),
  [{ path: "src/a.ts", line: 4, body: "null deref" }],
);
assert.throws(() => mapOcrJson({}), /comments array/);
assert.throws(() => mapOcrJson({ summary: "ok" }), /comments array/);

const ran = [];
const findings = await runOcrReview("/repo", {
  from: "abc",
  to: "HEAD",
  env: { OCR_LLM_TOKEN: "tok" },
  execFileFn: async (command, args, opts) => {
    ran.push({ command, args, opts });
    return {
      stdout: JSON.stringify({
        comments: [{ path: "src/a.ts", start_line: 3, content: "off-by-one" }],
      }),
    };
  },
});
assert.deepEqual(findings, [{ path: "src/a.ts", line: 3, body: "off-by-one" }]);
assert.equal(ran[0].command, "ocr");
assert.deepEqual(ran[0].args, [
  "review",
  "--audience", "agent",
  "--format", "json",
  "--effort", "high",
  "--from", "abc",
  "--to", "HEAD",
  "--repo", "/repo",
]);
assert.equal(ran[0].opts.env.OCR_LLM_MODEL, "grok-4.6");
assert.equal(ran[0].opts.env.OCR_LLM_URL, "https://api.x.ai");

const failedReport = { status: 'failed', message: 'One file timed out', summary: { files_reviewed: 2 },
  manifest: { coverage: { failed: [{ path: 'slow.mjs' }] } },
  comments: [{ path: 'a.mjs', start_line: 3, content: 'Concrete finding', thinking: 'private reasoning' }] };
await assert.rejects(runOcrReview('/repo', { from: 'base', env: { OCR_LLM_TOKEN: 'fixture' },
  execFileFn: async () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: JSON.stringify(failedReport) }); },
}), error => {
  assert.equal(error.message, 'exit 1');
  assert.deepEqual(error.reviewEvidence.manifest, failedReport.manifest);
  assert.equal(error.reviewEvidence.findings[0].body, 'Concrete finding');
  assert.ok(!JSON.stringify(error.reviewEvidence).includes('private reasoning'));
  return true;
});
