import test from "node:test";
import assert from "node:assert/strict";
import { agentScopes, commitment, day, selectedStone, signal, stones } from "../src/fixtures";

test("Forerunner's day fixture is versioned, synthetic and uses unique stable IDs", () => {
  assert.equal(day.fixture, 1);
  assert.equal(day.synthetic, true);
  assert.equal(day.id, "forerunner-day.launch-week");
  const ids = [
    ...day.signals.map((s) => s.id),
    ...day.commitments.map((c) => c.id),
    ...day.stones.flatMap((s) => [s.id, s.decision.id, ...s.decision.options.map((o) => o.id), ...s.pebbles.map((p) => p.id), ...s.sand.map((item) => item.id), ...s.dialogue.suggestions.map((q) => q.id)]),
  ];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^(signal\.inbox|commitment\.cal|stone|decision|option|pebble|sand|suggestion)\.[a-z0-9.-]+$/);
  assert.deepEqual(stones.map((s) => s.rank), [1, 2, 3]);
  for (const card of day.stones.flatMap((s) => [s, ...s.pebbles, ...s.sand])) {
    assert.match(card.priority, /^P[1-3]$/, `${card.id} has a display priority`);
    assert.match(card.due, /^\d{4}-\d{2}-\d{2}$/, `${card.id} has a due date`);
    assert.ok(!Number.isNaN(Date.parse(card.due)), `${card.id} has a valid due date`);
  }
});

test("every stone links its own inbox signal, calendar commitment, progress and decision", () => {
  for (const s of day.stones) {
    assert.equal(signal(s.signal).stone, s.id);
    assert.equal(commitment(s.commitment).stone, s.id);
    assert.ok(s.progress.done < s.progress.total, `${s.id} is still in progress`);
    assert.ok(s.blocker?.owner, `${s.id} names who owns its blocker`);
    assert.ok(s.decision.options.length >= 2, `${s.id} offers a real choice`);
    assert.ok(s.pebbles.length && s.sand.length, `${s.id} has next actions and small decisions`);
  }
  // Signals and commitments either belong to a stone that cites them, or to none.
  for (const record of [...day.signals, ...day.commitments])
    if (record.stone) assert.ok(day.stones.some((s) => s.signal === record.id || s.commitment === record.id), record.id);
  assert.ok(day.signals.some((s) => !s.stone) && day.commitments.some((c) => !c.stone), "the day includes items no stone needs");
  assert.throws(() => signal("signal.inbox.missing"), /Unknown signal/);
});

test("selection falls back to the top stone and each scope's dialogue only advises", () => {
  assert.equal(selectedStone(null).id, "stone.self-serve-launch");
  assert.equal(selectedStone("stone.unknown").id, "stone.self-serve-launch");
  assert.equal(selectedStone("stone.platform-lead").id, "stone.platform-lead");
  assert.deepEqual(agentScopes.map((s) => s.id), stones.map((s) => s.id));
  for (const scope of agentScopes) {
    assert.ok(scope.dialogue.briefing && scope.dialogue.suggestions.length);
    // Scripted replies never claim an external action happened.
    for (const text of [scope.dialogue.briefing, ...scope.dialogue.suggestions.map((s) => s.reply)])
      assert.doesNotMatch(text, /\b(I(?:'ve| have)? (?:sent|scheduled|emailed|booked|moved|accepted|declined)|(?<!Nothing )has been (?:sent|scheduled))\b/i);
  }
});
