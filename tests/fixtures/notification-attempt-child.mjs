#!/usr/bin/env node
// Crash-window fixture: runs the PRODUCTION completion path (workflow/jobs.mjs
// + workflow/reports.mjs + workflow/notify.mjs `deliverCompletion`) inside a
// real child process, so a test can SIGKILL it between the external transport
// recording its acceptance and the router's callback/journal write.
//
// TRANSPORT SIMULATION — NOT ACTUAL PI. The transport below is a simulated
// external queue: it appends its acceptance to disk and then either hangs (the
// parent delivers a real SIGKILL before the callback returns), waits for a
// release file before returning a weak `queued` result, or returns an explicit
// refusal. The actual Pi transport and native session evidence are covered by
// tests/architect-notify-receipts.mjs and tests/idle-wakeup-recovery.mjs.
//
// Request (JSON file path in argv[2]):
//   { stateDir, jobId, role, sessionKey, setup: "fresh"|"existing", text,
//     mode: "accept-hang"|"accept-wait-release"|"refuse",
//     acceptFile, doneFile, releaseFile }
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createJob, readJob, recordTerminal } from "../../workflow/jobs.mjs";
import { deliverCompletion } from "../../workflow/notify.mjs";
import { saveReport } from "../../workflow/reports.mjs";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { stateDir, jobId, role = "runner", sessionKey, setup = "fresh", text, mode, acceptFile, doneFile, releaseFile } = request;
const workflow = { sessionKey, root: stateDir };
const now = Date.now();

if (setup === "fresh") {
  createJob({ stateDir, id: jobId, role, workflow, cwd: stateDir, now });
  // Report-before-notify, exactly as the production finish path orders it.
  const report = saveReport(stateDir, { jobId, role, text, now });
  recordTerminal(stateDir, jobId, {
    status: "completed",
    summary: text.slice(0, 200),
    reportId: report.reportId,
    reportChars: report.chars,
    now,
  });
}
const job = readJob(stateDir, jobId);
if (!job?.terminal) throw new Error(`no terminal job '${jobId}' to deliver`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const transport = {
  name: "simulated-external-queue",
  async deliver(notification) {
    // The external queue ACCEPTS the message here — before any callback can
    // reach the router's journal write.
    appendFileSync(acceptFile, `${JSON.stringify({ eventId: notification.eventId, jobId: notification.jobId ?? null, at: Date.now() })}\n`);
    if (mode === "accept-hang") {
      // Hold the callback open forever; a heartbeat keeps the event loop alive
      // so the parent can deliver a real SIGKILL into a live process.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (mode === "accept-wait-release") {
      // Return only once the parent says so, so the test can land a receipt
      // while this process's callback is provably still in flight.
      for (;;) {
        try {
          readFileSync(releaseFile, "utf8");
          break;
        } catch {
          await sleep(25);
        }
      }
    }
    return mode === "refuse"
      ? { state: "failed", reason: "simulated external transport refusal" }
      : { state: "queued", reason: "simulated busy queue" };
  },
};

const result = await deliverCompletion({ stateDir, job, transport, text, reportText: text });
// Only ever reached once the transport callback actually returned.
writeFileSync(doneFile, `${JSON.stringify({ ok: result.ok, eventId: result.eventId, state: result.state, reason: result.reason ?? null })}\n`);
