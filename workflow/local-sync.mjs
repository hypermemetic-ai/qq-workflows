// Bounded projection of a verified remote landing's independent local state.
export function localSyncWarning(landing) {
  if (landing?.method !== "pr" || !landing.localSync || landing.localSync.localCheckout === "synced") return null;
  const sync = landing.localSync;
  const safe = value => String(value ?? "unknown").replace(/[\r\n\0]/g, " ").slice(0, 200);
  return `Remote PR merged (${safe(landing.pr)}, ${safe(landing.mergeSha)}); local ${safe(sync.ref ?? sync.branch)} checkout NOT synchronized (${safe(sync.status)}: ${safe(sync.reason)}). Local HEAD: ${safe(sync.localHead)}; observed remote tip: ${safe(sync.observedRemoteSha)}${Number.isSafeInteger(sync.behind) ? `; behind: ${sync.behind}` : ""}. Inventory/save edits, compare status and HEAD with the observed tip, then reconcile separately; see execution report localSync.recovery.`;
}
