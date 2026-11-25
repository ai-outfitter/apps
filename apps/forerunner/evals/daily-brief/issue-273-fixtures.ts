// Shared synthetic inputs for the scheduler/collection replay and brief eval.
export const timezone = "America/Chicago";
export const oceanMorning = {
  briefAt: "2026-11-25T11:00:00.000Z",
  discoveryAt: "2026-11-25T13:00:00.000Z",
  discoveries: ["mail-discovery", "calendar-discovery", "planning-discovery", "follow-up-discovery"],
  start: "2026-11-24T06:00:00.000Z",
  end: "2026-11-25T06:00:00.000Z",
  date: "2026-11-25",
  yesterday: "2026-11-24",
  baselineProducerSchedule: null,
} as const;

export const ontoBatches = (["committed", "committed", "committed", "committed", "open", "open", "rejected", "rejected", "rejected"] as const).map((state, i) => ({
  id: `batch-${i + 1}`, title: `Synthetic proposal ${String.fromCharCode(65 + i)}`,
  state, updatedAt: Date.parse(oceanMorning.start) + 60_000 * (i + 1),
}));
export const ontoRevisions = ontoBatches.slice(0, 4).map((batch, i) => ({
  batchId: batch.id, recordId: `record-${i + 1}`, kind: "graph-node" as const, revision: 1,
  createdAt: Date.parse(oceanMorning.start) + (i < 2 ? (i + 1) * 60_000 : -(i + 1) * 60_000),
}));

export const authoredWiki = [
  { id: "doc-authored", slug: "review-notes", revision: 3, title: "Reviewed field notes", store: "document", scope: "personal", createdAt: oceanMorning.start },
  { id: "legacy-authored", slug: "handoff", revision: 2, title: "Documented the handoff", store: "legacy", scope: "fixture-team", createdAt: "2026-11-25T05:59:59.999Z" },
  { id: "generated-update", slug: "app-daily-fixture", revision: 1, title: "Generated update sentinel", store: "document", scope: "personal", createdAt: oceanMorning.start, provenance: "app.daily-update" },
  { id: "generated-brief", slug: "forerunner-brief-fixture", revision: 1, title: "Generated brief sentinel", store: "document", scope: "personal", createdAt: oceanMorning.start, provenance: "forerunner.daily-brief" },
  { id: "private-doc", slug: "private-doc", revision: 1, title: "Foreign scope sentinel", store: "legacy", scope: "other-team", createdAt: oceanMorning.start },
  { id: "old-doc", slug: "old-doc", revision: 1, title: "Before window sentinel", store: "legacy", scope: "personal", createdAt: "2026-11-24T05:59:59.999Z" },
  { id: "next-doc", slug: "next-doc", revision: 1, title: "At end sentinel", store: "document", scope: "personal", createdAt: oceanMorning.end },
] as const;

export const chicagoFallback = {
  briefAt: "2026-11-02T11:00:00.000Z", date: "2026-11-02", yesterday: "2026-11-01",
  start: "2026-11-01T05:00:00.000Z", end: "2026-11-02T06:00:00.000Z",
  completions: [
    { id: "too-early", title: "DST before window sentinel", at: "2026-11-01T04:59:59.999Z" },
    { id: "start", title: "Opened the reporting day", at: "2026-11-01T05:00:00.000Z" },
    { id: "first-hour", title: "Checked the first handoff", at: "2026-11-01T06:30:00.000Z" },
    { id: "second-hour", title: "Checked the second handoff", at: "2026-11-01T07:30:00.000Z" },
    { id: "too-late", title: "DST end sentinel", at: "2026-11-02T06:00:00.000Z" },
  ],
} as const;

export const ownPriority = { id: "own-priority", title: "Send the field handoff", dueDate: oceanMorning.date };
export const otherPriority = { id: "other-priority", title: "Foreign owner sentinel", dueDate: oceanMorning.date };
export const futureSuggestion = "Future discovery sentinel";

export const issue273Cases = [
  { id: "nov25-ocean-replay", stages: ["morning", "ready"] },
  { id: "nov25-authored-late-discovery", stages: ["morning", "ready"] },
  { id: "nov25-partial-recovery", stages: ["partial", "recovered", "retry", "historical"] },
  { id: "nov25-empty-confirmed", stages: ["morning"] },
  { id: "nov25-empty-unavailable", stages: ["morning"] },
  { id: "nov25-auth-isolation", stages: ["foreign", "morning"] },
  { id: "nov01-chicago-dst", stages: ["morning"] },
] as const;
