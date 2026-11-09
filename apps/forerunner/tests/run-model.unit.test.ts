import assert from "node:assert/strict";
import { test } from "node:test";
import type { Preview } from "../src/scripts/preview";
import { byRecord, conclusions, runRecords, stepTimes } from "../src/scripts/run-model";

const entry = (title: string, kind: string, id: string, existing = false) => ({ id, title, kind, existing, excerpt: "" });
const preview = {
  id: "p", createdAt: "2026-11-03T18:00:00Z", destination: "personal", wikiSlug: "wiki", systemPrompt: "", sources: [], operations: [],
  entries: [entry("Ada Lovelace", "Person", "a"), entry("Analytical Engine Co", "Organization", "o", true), entry("Ada Lovelace → works_at → Analytical Engine Co", "Proposed relationship", "r")],
  batch: { installationId: "w", batchId: "b", policy: "confidence" },
  receipt: { waiting: ["r"] },
} satisfies Preview;
const run = {
  status: "complete", startedAt: "2026-11-03T18:00:00Z",
  input: { evidence: [
    { ref: "e0", title: "Engine plans · 2026-11-02 · gmail · me@example.test", excerpt: "Participants as supplied: Ada <ada@example.test>\nNotes on the engine." },
    { ref: "e1", title: "Newsletter · 2026-11-01 · gmail · me@example.test", excerpt: "Weekly digest." },
    { ref: "operating-user", title: "Authenticated platform identity", excerpt: "Name: Me" },
  ] },
  output: {
    entities: [
      { key: "ada", name: "Ada Lovelace", type: "Person", summary: "Sent the engine plans.", certainty: "mentioned", confidence: 0.97, evidence: ["e0"], existingId: null },
      { key: "co", name: "Analytical Engine Co", type: "Organization", summary: "Her employer.", existingId: "x", confidence: 0.9, evidence: ["e0"] },
      { key: "bob", name: "bob@example.test", type: "Person", summary: "Mailbox only.", confidence: 0.5, evidence: ["e1"], existingId: null },
    ],
    relationships: [{ from: "ada", to: "co", type: "works_at", reason: "Signs as an employee.", confidence: 0.8, evidence: ["e0"] }],
  },
};

test("older runs recover the records the model read from its input", () => {
  const records = runRecords(run, null);
  assert.deepEqual(records.map((r) => [r.ref, r.subject, r.provider, r.from]), [["e0", "Engine plans", "gmail", "Ada <ada@example.test>"], ["e1", "Newsletter", "gmail", ""]]);
  assert.equal(records[0].excerpt, "Notes on the engine.");
});

test("each conclusion is matched to the change it became, and dropped ones are kept", () => {
  const list = conclusions(run, preview);
  assert.deepEqual(list.map((c) => [c.name, c.outcome]), [
    ["Ada Lovelace", "added"],
    ["Analytical Engine Co", "matched"],
    ["bob@example.test", "dropped"],
    ["Ada Lovelace → works_at → Analytical Engine Co", "waiting"],
  ]);
  assert.equal(byRecord(list).get("e0")?.length, 3);
});

test("runs without a kept answer fall back to the preview's entries", () => {
  const list = conclusions({ status: "complete", startedAt: "" }, preview);
  assert.equal(list.length, 3);
  assert.equal(list[2].outcome, "waiting");
});

test("steps collapse repeats and say how long each took", () => {
  const steps = stepTimes([
    { at: "2026-11-03T18:00:00.000Z", status: "preparing" },
    { at: "2026-11-03T18:00:01.000Z", status: "analyzing" },
    { at: "2026-11-03T18:00:02.000Z", status: "analyzing" },
    { at: "2026-11-03T18:00:31.000Z", status: "complete" },
  ]);
  assert.deepEqual(steps.map((s) => [s.status, s.ms]), [["preparing", 1000], ["analyzing", 30000], ["complete", undefined]]);
});

test("discovery reads an email's own words, not the quoted thread", async () => {
  const { emailText } = await import("../src/server/discovery");
  const body = "Hi Nicholas,\r\nCan you bring sides?\r\n\r\nMaria\r\n\r\nOn Mon, Nov 2, 2026 at 9:00 AM Nicholas <n@example.test> wrote:\r\n> Want to host?\r\n> Thanks";
  assert.equal(emailText(body, "snippet"), "Hi Nicholas,\nCan you bring sides?\n\nMaria");
  assert.equal(emailText("Thanks!\n\n> earlier\n> more", "s"), "Thanks!");
  assert.equal(emailText("Notes\n\nFrom: Bob <b@x.test>\nSent: Monday\nSubject: Re: plans\n\nold", "s"), "Notes");
  assert.equal(emailText(null, "Only the snippet"), "Only the snippet");
});
