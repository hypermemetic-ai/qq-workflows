import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveReport, readReport, reportPath } from '../workflow/reports.mjs';

const root = mkdtempSync(join(tmpdir(), 'qq-report-reference-'));
try {
  writeFileSync(join(root, 'outside.txt'), 'not a registered report');
  const report = saveReport(root, { jobId: 'job-reference', role: 'runner', text: 'durable findings' });
  assert.equal(readReport(root, report.reportId).text, 'durable findings');
  for (const forged of ['../outside', '../../outside', '/tmp/outside', 'nested/report', 'a\\b', 'bad\0reference']) {
    assert.throws(() => reportPath(root, forged), /invalid report reference/);
    assert.equal(readReport(root, forged).ok, false, 'forged path cannot retrieve unrelated text');
  }
  console.log('PASS durable report references remain confined to the report store');
} finally { rmSync(root, { recursive: true, force: true }); }
