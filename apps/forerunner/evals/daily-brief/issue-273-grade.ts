import type { modelData } from "../../src/server/daily-brief-synthesis";
import type { Check } from "./grade";
import { authoredWiki, chicagoFallback, futureSuggestion, oceanMorning, otherPriority, ownPriority } from "./issue-273-fixtures";
import type { collectOnto } from "./issue-273-onto";

const summaryCounts = /\b2 committed record revisions\b.*\b2 pending and 3 rejected batch updates\b/i;
const emptyCounts = /\b0 committed record revisions\b.*\b0 pending and 0 rejected batch updates\b/i;
const forbiddenWiki = authoredWiki.slice(2).map(row => row.title);
const fourCommits = /\b(?:four|4)\s+(?:committed|commits?|record revisions?)\b|committ?ed?\s+(?:four|4)\b/i;
const unsupportedWikiAuthor = /\b(?:you|the member) (?:authored|wrote|made|reviewed|documented)\b/i;
const unsupportedProposalNames = /\b(?:pending|rejected)\b[^.;]{0,100}\b(?:including|include[ds]?|such as|named) synthetic proposal [ab]\b/i;
const zeroWiki = /\b(?:0|zero|no)\s+(?:authored\s+)?wiki (?:revisions|activity|edits)\b/i;
const check = (name: string, expected: unknown, actual: unknown): Check => ({
  name, pass: JSON.stringify(actual) === JSON.stringify(expected),
  detail: `Expected ${JSON.stringify(expected)}. Observed ${JSON.stringify(actual)}.`,
});

export function gradeOnto(actual: Awaited<ReturnType<typeof collectOnto>>, empty: boolean): Check[] {
  const update = actual.update;
  const generated = actual.writes[0]?.generatedBody ?? "";
  const sourceRows = generated.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const revisions = sourceRows.filter(row => row.activity === "committed revision").map(row => row.id);
  const proposals = sourceRows.filter(row => row.activity === "batch updated; current proposal state").map(row => row.state);
  return [
    check("producer-collected-commit-events", empty ? [] : ["record-1", "record-2"], revisions),
    check("producer-collected-current-proposal-states", empty ? [] : ["open", "open", "rejected", "rejected", "rejected"], proposals),
    check("producer-summary-keeps-counts-separate", true, (empty ? emptyCounts : summaryCounts).test(update.summary ?? "")),
    check("producer-page-receipt", ["onto-daily-document", 1, true], [update.id, update.revision, update.complete]),
  ];
}

type Prompt = ReturnType<typeof modelData>;
type Actual = {
  id: string; stage: string; at: string; phase: any; protocol?: string; cachedResult?: unknown; occurrence: { runId: string };
  trace: { op: string; document?: string; args?: unknown }[];
  prompts: { data: unknown; answer?: unknown }[];
  results: unknown[];
  before: { id: string; revision: number }[];
  writes: { revision: number; generatedBody: string; provenance: any }[];
  update?: Awaited<ReturnType<typeof collectOnto>>["update"];
};

export function gradeIssue273(actual: Actual, dates: typeof oceanMorning | typeof chicagoFallback, dry: boolean): Check[] {
  const { id, stage, trace, prompts, writes, phase } = actual;
  const reservedRetry = actual.protocol === "reserved-run" && stage === "retry";
  const readReservation = trace.some(row => row.op === "workflow.read" && row.args === actual.occurrence.runId);
  const observedResult = actual.results.at(-1) ?? (readReservation ? actual.cachedResult : undefined);
  const collect = observedResult as { date?: string; outcome?: string; status?: string; reason?: string } | undefined;
  const input = prompts[0]?.data as Prompt | undefined;
  const answer = prompts[0]?.answer as { opening?: { text: string; evidence: string[] }; highlights?: { text: string; evidence: string[] }[]; attention?: { text: string; why: string; evidence: string[] }[] } | undefined;
  const rows = input?.evidence ?? [];
  const sourceText = rows.map(row => row.text).join("\n");
  const gaps = input?.notKnown.join("\n") ?? "";
  const discoveryCase = id === "nov25-ocean-replay" || id === "nov25-authored-late-discovery";
  const shouldDefer = discoveryCase && stage === "morning";
  const retained = stage === "retry" || stage === "historical";
  const trulyUnavailable = id === "nov25-empty-unavailable";
  const checks: Check[] = [];
  if (stage === "foreign") return [check("foreign-actor-rejected-before-host-read", [{ http: 403 }, 0, 0], [phase, trace.length, writes.length])];
  checks.push(
    check("phase-outcome", shouldDefer ? "deferred" : "started", phase?.outcome),
    check("occurrence-workflow-start", shouldDefer || reservedRetry ? [] : [actual.occurrence.runId], trace.filter(row => row.op === "workflow.start").map(row => row.args)),
    check("inference-count", shouldDefer || retained || trulyUnavailable ? 0 : 1, prompts.length),
    check("wiki-write-count", shouldDefer || retained || trulyUnavailable ? 0 : 1, writes.length),
  );
  if (shouldDefer) {
    checks.push(
      check("next-dependency-check-is-before-07:00", true, phase?.retryAt > Date.parse(actual.at) && phase?.retryAt < Date.parse(oceanMorning.discoveryAt)),
      check("nothing-from-07:00-leaks-at-05:00", false, sourceText.includes(futureSuggestion)),
    );
    return checks;
  }
  checks.push(check("receipt-date", dates.date, collect?.date));
  if (stage === "ready") {
    const start = trace.findIndex(row => row.op === "workflow.start");
    const reads = trace.slice(0, Math.max(0, start)).filter(row => row.op === "workflow.read" && row.args !== actual.occurrence.runId).map(row => row.args);
    checks.push(check("all-four-discoveries-read-before-brief-start", oceanMorning.discoveries.map(name => name + "-run"), reads));
  }
  if (trulyUnavailable) {
    checks.push(check("no-evidence-is-a-failed-run", ["failed", true], [collect?.status, /no saved evidence/i.test(collect?.reason ?? "")]));
    return checks;
  }
  if (retained) {
    checks.push(check("existing-revision-retained", [reservedRetry ? "saved" : "unchanged", 1], [collect?.outcome, actual.before.length]));
    if (reservedRetry) checks.push(check("terminal-reservation-read-without-a-second-collection", [true, 0], [readReservation, actual.results.length]));
    return checks;
  }
  checks.push(
    check("reporting-day-in-prompt", [dates.date, dates.yesterday], [input?.date, input?.coversCompletedDay]),
    check("same-installation-owner-isolation", [false, true], [sourceText.includes(otherPriority.title), id.startsWith("nov25-empty") || sourceText.includes(ownPriority.title)]),
  );
  const wikiCalls = trace.filter(row => row.document === "WikiRevisionActivity").map(row => row.args as { start: string; end: string });
  checks.push(check("requested-half-open-chicago-window", true, wikiCalls.length > 0 && wikiCalls.every(args => args.start === dates.start && args.end === dates.end)));
  if (actual.protocol === "reserved-run" && (stage === "ready" || stage === "partial" || stage === "recovered")) {
    const names = stage === "partial" ? oceanMorning.discoveries.slice(0, 1) : oceanMorning.discoveries;
    checks.push(check("only-successful-discovery-receipts-in-prompt", names.map(name => `Discovery: ${name} completed this morning: 2 analyzed entries, 0 saved suggestions.`),
      rows.filter(row => row.kind === "discovery" && row.coverage === "complete").map(row => row.text)));
    if (writes.length) checks.push(check("discovery-citations-match-reserved-result-ids", names.map(name => `/apps/forerunner/runs/${name}-run`),
      writes[0].provenance.sources.filter((row: any) => row.kind === "discovery" && row.recordId).map((row: any) => row.href)));
  }
  const expectedWiki = stage === "partial" ? null : id === "nov25-authored-late-discovery" ? 2 : 0;
  const wikiCount = rows.find(row => row.kind === "wiki-activity" && row.coverage === "complete")?.text.match(/^(\d+) /)?.[1] ?? null;
  checks.push(check("wiki-coverage-count-in-prompt", expectedWiki, wikiCount === null ? null : Number(wikiCount)));
  checks.push(check("no-generated-foreign-or-out-of-window-wiki-in-prompt", [], forbiddenWiki.filter(title => sourceText.includes(title))));
  if (id === "nov25-authored-late-discovery") {
    checks.push(check("authored-wiki-evidence-order", authoredWiki.slice(0, 2).map(row => row.title),
      rows.filter(row => row.kind === "wiki-activity" && row.coverage !== "complete").map(row => authoredWiki.find(item => row.text.includes(item.title))?.title)));
    if (dry || writes.length) checks.push(check("authored-wiki-revision-links", [["doc-authored", 3], ["legacy-authored", 2]],
      writes[0]?.provenance.sources.filter((row: any) => row.kind === "wiki-activity" && row.recordId).map((row: any) => [row.recordId, row.revision])));
  }
  if (stage === "partial") {
    checks.push(check("partial-gaps-carry-failed-leaf-running-disabled-and-unread-sources", [true, true, true, true, true], [
      /calendar-discovery.*failed/i.test(gaps), /planning-discovery.*(?:no final|running)/i.test(gaps), /follow-up-discovery.*disabled/i.test(gaps),
      /Onto.*(?:unknown|unavailable)/i.test(gaps), /Wiki.*incomplete/i.test(gaps),
    ]));
    if (dry || writes.length) checks.push(check("partial-receipt-remains-incomplete", "incomplete", collect?.status));
  }
  const shouldHaveOnto = stage !== "partial" && dates !== chicagoFallback;
  if (shouldHaveOnto) {
    const onto = rows.find(row => row.kind === "app-update");
    checks.push(check("onto-counts-present-before-model", true, (id === "nov25-empty-confirmed" ? emptyCounts : summaryCounts).test(onto?.text ?? "")));
    if (dry || writes.length) {
      const source = writes[0]?.provenance.sources.find((row: any) => row.kind === "app-update");
      checks.push(check("onto-revision-citation-matches-producer", true, Boolean(source && actual.update && source.recordId === actual.update.id && source.revision === actual.update.revision && source.href?.endsWith(`${actual.update.slug}?revision=${actual.update.revision}`))));
    }
  }
  if (dates === chicagoFallback) {
    checks.push(check("dst-start-and-both-repeated-hours-in-order", chicagoFallback.completions.slice(1, 4).map(row => row.title),
      rows.filter(row => row.kind === "completion").map(row => row.text.split(" (")[0])));
  }
  if (!dry) {
    const claims = !writes.length || !answer ? []
      : [answer.opening, ...(answer.highlights ?? []), ...(answer.attention ?? [])].filter(item => item !== undefined);
    const text = claims.map(item => item.text).join("\n");
    checks.push(check("live-answer-saves-with-resolvable-citations", true,
      Boolean(writes.length && claims.length && claims.every(item => item.evidence.length && item.evidence.every(ref => rows.some(row => row.ref === ref))))));
    if (claims.length) {
      const knownYears = new Set([dates.date, dates.yesterday].map(date => date.slice(0, 4)));
      const prose = claims.flatMap(item => [item.text, "why" in item && typeof item.why === "string" ? item.why : ""]);
      const unknownYears = [...new Set(prose.flatMap(line => line.match(/\b20\d{2}\b/g) ?? []))].filter(year => !knownYears.has(year));
      checks.push(
        check("model-does-not-claim-four-commits-from-batch-state", false, fourCommits.test(text)),
        check("model-uses-reporting-year", [], unknownYears),
        check("model-does-not-invent-wiki-author", [], claims.filter(item => unsupportedWikiAuthor.test(item.text)
          && item.evidence.some(ref => rows.some(row => row.ref === ref && row.kind === "wiki-activity"))).map(item => item.text)),
        check("model-does-not-assign-commit-batch-names-to-pending-or-rejected", [], prose.filter(line => unsupportedProposalNames.test(line))),
      );
      if (stage === "partial") checks.push(check("model-does-not-claim-zero-when-wiki-unread", false, zeroWiki.test(text)));
      if (id === "nov25-empty-confirmed") checks.push(check("model-cites-checked-zero-wiki-activity", true,
        claims.some(item => zeroWiki.test(item.text) && item.evidence.some(ref => rows.some(row => row.ref === ref && row.kind === "wiki-activity")))));
    }
  }
  return checks;
}
