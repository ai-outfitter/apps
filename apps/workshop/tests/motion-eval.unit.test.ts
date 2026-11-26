import assert from "node:assert/strict";
import test from "node:test";
import { fixtures, type FixtureId } from "../agent-evals/motion/fixtures";
import { grade } from "../agent-evals/motion/grade";

for (const id of Object.keys(fixtures) as FixtureId[]) {
  test(id + " reference", () => {
    const result = grade(id, fixtures[id].reference);
    console.log(JSON.stringify({ id, subject: "reference", ...result }));
    assert.equal(result.passed, true);
  });
}

test("negative controls reject plausible playback with missing mechanism evidence", () => {
  const wheel = structuredClone(fixtures["spinning-wheel"].reference);
  wheel.tracks[0].keys = [{ time: 0, value: 0 }, { time: 2, value: 0 }];
  const gears = structuredClone(fixtures["gear-pair"].reference);
  gears.couplings[0].ratio = 0.5;
  const slideOnly = structuredClone(fixtures["transfer-rig"].reference);
  slideOnly.tracks = [{ part: "carriage", keys: [{ time: 0, value: 0 }, { time: 1, value: 0 },
    { time: 3, value: 30 }, { time: 4, value: 0 }] }];
  slideOnly.couplings = [];
  const noRelease = structuredClone(fixtures["transfer-rig"].reference);
  noRelease.handoffs.pop();
  const loopsBetweenSamples = structuredClone(fixtures["spinning-wheel"].reference);
  loopsBetweenSamples.tracks[0].keys.splice(1, 0, { time: 0.25, value: 405 });
  for (const [id, subject, answer, failedLabel] of [
    ["spinning-wheel", "motionless-wheel", wheel, "Quarter-turn witness"],
    ["gear-pair", "wrong-direction", gears, "Follower turns opposite"],
    ["transfer-rig", "slide-without-drive", slideOnly, "Shaft witness turns"],
    ["transfer-rig", "missing-release", noRelease, "Payload remains at drop after carriage returns"],
  ] as const) {
    const result = grade(id, answer);
    console.log(JSON.stringify({ id, subject, ...result }));
    assert.equal(result.passed, false);
    assert.equal(result.checks?.find(({ label }) => label === failedLabel)?.passed, false);
  }
  const injectedSpin = grade("spinning-wheel", loopsBetweenSamples);
  console.log(JSON.stringify({ id: "spinning-wheel", subject: "spin-between-samples", ...injectedSpin }));
  assert.equal(injectedSpin.passed, false);
  assert.equal(injectedSpin.driver?.find(({ timeSeconds }) => timeSeconds === 0.25)?.passed, false);
});

test("reject independent tracks even when every rendered gear pose matches", () => {
  const answer = structuredClone(fixtures["gear-pair"].reference);
  answer.couplings = [];
  answer.tracks.push({ part: "gear", keys: [{ time: 0, value: 0 }, { time: 2, value: -180 }] });
  const result = grade("gear-pair", answer);
  console.log(JSON.stringify({ id: "gear-pair", subject: "uncoupled-matching-poses", ...result }));
  assert.equal(result.passed, false);
  assert.equal(result.nativeDriveChain, false);
  assert.ok(result.checks?.length && result.checks.every(({ passed }) => passed));
});
