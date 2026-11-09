import type { Preview } from "./preview";

/**
 * How the run page reads one discovery run: the records that went in, what the
 * model concluded from each, and what each conclusion became in the batch.
 * Pure, so it can be tested without a browser.
 */
export type Run = {
  id?: string;
  status: string;
  startedAt: string;
  updatedAt?: string;
  trigger?: string;
  error?: string;
  failedWhile?: string;
  note?: string;
  systemPrompt?: string;
  input?: unknown;
  output?: unknown;
  stages?: { at: string; status: string }[];
  warnings?: unknown;
};

/** One record the model read, under the ref its answer cites (e0, e1…). */
export type RunRecord = {
  ref: string;
  provider: string;
  account: string;
  subject: string;
  date: string;
  from: string;
  excerpt: string;
  url?: string;
  /** Older runs read only Gmail's preview snippet and at most 600 characters. */
  snippetOnly?: boolean;
};

export type Outcome = "added" | "waiting" | "matched" | "known" | "corrected" | "unsaved" | "dropped";
export const outcomeLabel: Record<Outcome, string> = {
  added: "Added",
  waiting: "Waiting for review",
  matched: "Matched existing",
  known: "Already in graph",
  corrected: "Corrected",
  unsaved: "Not saved",
  dropped: "Dropped by checks",
};

/** One thing the model concluded: a record or a relationship, with the records it cited. */
export type Conclusion = {
  kind: "record" | "relationship";
  type: string;
  name: string;
  note: string;
  confidence?: number;
  certainty?: string;
  evidence: string[];
  outcome: Outcome;
  /** Its row in the preview, when it survived the checks. */
  entryIndex?: number;
};

type OutputEntity = { key: string; name: string; type: string; summary?: string; existingId?: string | null; certainty?: string; confidence?: number; evidence?: string[] };
type OutputRelationship = { from: string; to: string; type: string; reason?: string; confidence?: number; evidence?: string[] };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The records a run read: the preview's structured list, else the model input of an older run. */
export function runRecords(run: Run, preview: Preview | null): RunRecord[] {
  if (preview?.inputs?.length)
    return preview.inputs.map((input) => ({
      ref: input.ref,
      provider: input.provider,
      account: input.account,
      subject: input.subject,
      date: input.date,
      from: input.participants[0] ?? "",
      excerpt: stripParticipants(input.excerpt),
      url: input.url,
    }));
  const evidence = isObject(run.input) && Array.isArray(run.input.evidence) ? run.input.evidence : [];
  return evidence.filter(isObject).filter((e) => typeof e.ref === "string" && e.ref !== "operating-user").map((e) => {
    // Older runs only kept "subject · date · provider · account".
    const [subject = "", date = "", provider = "", ...account] = String(e.title ?? "").split(" · ");
    const excerpt = String(e.excerpt ?? "");
    return { ref: String(e.ref), subject, date, provider, account: account.join(" · "), from: participants(excerpt)[0] ?? "", excerpt: stripParticipants(excerpt), snippetOnly: true };
  });
}
function participants(excerpt: string) {
  const line = excerpt.match(/^Participants as supplied: (.*)$/m)?.[1];
  return line ? line.split(", ") : [];
}
function stripParticipants(excerpt: string) {
  return excerpt.replace(/^Participants as supplied: .*\n?/, "");
}

/** What the model answered, when the run kept it and it has the expected shape. */
export function modelAnswer(run: Run): { entities: OutputEntity[]; relationships: OutputRelationship[] } | null {
  const output = run.output;
  if (!isObject(output) || !Array.isArray(output.entities)) return null;
  return {
    entities: output.entities.filter(isObject) as OutputEntity[],
    relationships: (Array.isArray(output.relationships) ? output.relationships.filter(isObject) : []) as OutputRelationship[],
  };
}

function outcome(entry: Preview["entries"][number] | undefined, preview: Preview | null, matchedExisting: boolean): Outcome {
  if (!entry) return "dropped";
  if (entry.matchedId) return "corrected";
  if (entry.existing) return matchedExisting ? "matched" : "known";
  if (!preview?.receipt) return "unsaved";
  return entry.id && preview.receipt.waiting?.includes(entry.id) ? "waiting" : "added";
}

/**
 * Every conclusion in the model's answer, matched to the preview entry it
 * became. Answers the checks removed have no entry and are marked dropped.
 * Runs without a recorded answer fall back to the preview's entries.
 */
export function conclusions(run: Run, preview: Preview | null): Conclusion[] {
  const entries = preview?.entries ?? [];
  const answer = modelAnswer(run);
  if (!answer)
    return entries.map((entry, index) => ({
      kind: entry.kind === "Proposed relationship" ? "relationship" : "record",
      type: entry.kind,
      name: entry.matchedTitle ?? entry.title,
      note: "",
      evidence: [],
      outcome: outcome(entry, preview, false),
      entryIndex: index,
    }));
  const used = new Set<number>();
  const find = (title: string, kind: string, key: string) => {
    const linked = entries.findIndex(e => e.kind === kind && e.modelKeys?.includes(key));
    if (linked >= 0) { used.add(linked); return linked; }
    // Older previews have no exact answer links. Keep their historical title-based fallback.
    const index = entries.findIndex((e, i) => !e.modelKeys && !used.has(i) && e.title === title && e.kind === kind);
    if (index >= 0) used.add(index);
    return index >= 0 ? index : undefined;
  };
  const names = new Map(answer.entities.map((e) => [e.key, e.name]));
  const result: Conclusion[] = answer.entities.map((entity) => {
    const index = find(entity.name, entity.type, entity.key);
    return {
      kind: "record", type: entity.type, name: index === undefined ? entity.name : (entries[index].matchedTitle ?? entity.name),
      note: entity.summary ?? "", confidence: entity.confidence, certainty: entity.certainty, evidence: entity.evidence ?? [],
      outcome: outcome(index === undefined ? undefined : entries[index], preview, !!entity.existingId), entryIndex: index,
    };
  });
  for (const relation of answer.relationships) {
    const name = `${names.get(relation.from) ?? relation.from} → ${relation.type} → ${names.get(relation.to) ?? relation.to}`;
    const index = find(name, "Proposed relationship", JSON.stringify([relation.from, relation.type, relation.to]));
    result.push({
      kind: "relationship", type: relation.type, name, note: relation.reason ?? "", confidence: relation.confidence,
      evidence: relation.evidence ?? [], outcome: outcome(index === undefined ? undefined : entries[index], preview, false), entryIndex: index,
    });
  }
  // Entries the answer cannot account for (a different answer was kept) still show.
  entries.forEach((entry, index) => {
    if (used.has(index) || result.some((c) => c.entryIndex === index)) return;
    result.push({ kind: entry.kind === "Proposed relationship" ? "relationship" : "record", type: entry.kind, name: entry.matchedTitle ?? entry.title, note: "", evidence: [], outcome: outcome(entry, preview, false), entryIndex: index });
  });
  return result;
}

/** Conclusions by the record they cite. One conclusion can cite several records. */
export function byRecord(list: Conclusion[]) {
  const map = new Map<string, Conclusion[]>();
  for (const c of list) for (const ref of c.evidence) map.set(ref, [...(map.get(ref) ?? []), c]);
  return map;
}

/** Where a running run is, in words. */
export const stageLabel: Record<string, string> = {
  preparing: "Getting ready",
  reading: "Reading your sources",
  analyzing: "The agent is reading",
  validating: "Checking the agent’s answer",
  saving: "Saving to your knowledge graph",
  complete: "Done",
  failed: "Failed",
};

/** Each step with how long it took, up to the next one. */
export function stepTimes(stages: { at: string; status: string }[] = []) {
  // Analyzing is recorded twice: once with the prompt, once with the input.
  const steps = stages.filter((s, i) => i === 0 || s.status !== stages[i - 1].status);
  return steps.map((step, i) => {
    const next = steps[i + 1];
    const ms = next ? Date.parse(next.at) - Date.parse(step.at) : undefined;
    return { ...step, label: stageLabel[step.status] ?? step.status, ms: ms !== undefined && Number.isFinite(ms) ? ms : undefined };
  });
}

export function duration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const PROVIDER_NAMES: Record<string, string> = { gmail: "Gmail", "google-calendar": "Calendar", github: "GitHub", slack: "Slack" };
export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;
