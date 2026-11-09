// Deterministic checks for one digest answer. They catch the failures that matter
// for a daily digest: an answer outside the contract, an invented issue, a summary
// that buries what shipped, and one that skips most of what changed.
import { digestSummarySchema } from "../../src/server/digests";
import type { DigestCase } from "./cases";

export type Check = { name: string; pass: boolean; detail: string };
export type Grade = { pass: boolean; score: number; checks: Check[] };

const stop = new Set(["the", "and", "for", "with", "from", "into", "onto", "that", "this", "our", "add", "a", "an", "of", "to", "in", "on"]);
const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 1 && !stop.has(word));

/** Whether `text` names an issue: all of a short title's words, or most of a long one's. */
export function mentions(text: string, title: string) {
  const have = new Set(words(text));
  const need = words(title);
  if (!need.length) return false;
  const found = need.filter((word) => have.has(word)).length;
  return need.length <= 3 ? found === need.length : found / need.length >= 0.7;
}

/** Phrases the answer puts in quotes, which a reader takes as issue titles. */
const quoted = (text: string) => [...text.matchAll(/["“”']([^"“”']{4,120})["“”']/g)].map((match) => match[1].trim());

export function grade(digest: DigestCase, answer: unknown): Grade {
  const parsed = digestSummarySchema.safeParse(answer);
  if (!parsed.success) return { pass: false, score: 0, checks: [{ name: "contract", pass: false, detail: parsed.error.message.slice(0, 300) }] };
  const { headline, summary } = parsed.data;
  const text = `${headline}\n${summary}`;
  const { changes } = digest;
  const checks: Check[] = [{ name: "contract", pass: true, detail: "headline and summary within bounds" }];

  const invented = quoted(text).filter((phrase) => !digest.knownTitles.some((title) => mentions(phrase, title) || mentions(title, phrase)));
  checks.push({ name: "no-invented-issues", pass: invented.length === 0, detail: invented.length ? `quoted but not in the data: ${invented.join("; ")}` : "every quoted title is in the data" });

  if (changes.counts.shipped > 0) {
    const lead = `${headline}\n${summary.split(/(?<=[.!?])\s/)[0]}`;
    const led = changes.shipped.some((issue) => mentions(lead, issue.title));
    checks.push({ name: "leads-with-shipped", pass: led, detail: led ? "a shipped issue is in the headline or first sentence" : "nothing shipped is named up front" });
  }

  const notable = [...changes.shipped, ...changes.started, ...changes.reopened];
  if (notable.length) {
    const covered = notable.filter((issue) => mentions(text, issue.title)).length;
    // Long lists are summarized, so ask for half of them (at most five).
    const need = Math.min(5, Math.ceil(notable.length / 2));
    checks.push({ name: "covers-changes", pass: covered >= need, detail: `${covered} of ${notable.length} shipped, started or reopened issues named (need ${need})` });
  }

  if (changes.counts.reopened > 0 || changes.counts.removed > 0) {
    const flagged = /reopen|removed|deleted|dropped/i.test(text);
    checks.push({ name: "calls-out-setbacks", pass: flagged, detail: flagged ? "reopened or removed work is mentioned" : "reopened or removed work is not mentioned" });
  }

  const passed = checks.filter((check) => check.pass).length;
  return { pass: passed === checks.length, score: passed / checks.length, checks };
}
