import { Vector3 } from "three";
import { installedOperations } from "../../src/lib/installed-operations";
import { Answer, fixtureAssembly, fixtures, type FixtureId } from "./fixtures";

export function grade(id: FixtureId, raw: unknown) {
  try {
    const answer = Answer.parse(raw);
    const { assembly, path } = fixtureAssembly(id, answer);
    const [playback] = installedOperations(assembly);
    const reference = fixtures[id].reference;
    const checks = fixtures[id].checks.map(({ label, part, time, point, expected }) => {
      const matrix = playback.pose(time).get(playback.path + "/" + path(part));
      if (!matrix) throw Error("Missing installed part " + part);
      const actual = new Vector3(...point).applyMatrix4(matrix);
      return { label, timeSeconds: time, expectedMm: expected, actualMm: actual.toArray(),
        toleranceMm: 0.001, passed: actual.distanceTo(new Vector3(...expected)) <= 0.001 };
    });
    const nativeDriveChain = answer.tracks.length === reference.tracks.length
      && reference.tracks.every(({ part }) => answer.tracks.some((candidate) => candidate.part === part))
      && answer.couplings.length === reference.couplings.length
      && reference.couplings.every((link) => answer.couplings.some((candidate) =>
        candidate.driver === link.driver && candidate.follower === link.follower
        && Math.abs(candidate.ratio - link.ratio) < 1e-6));
    const nativeHandoffs = answer.handoffs.length === reference.handoffs.length
      && reference.handoffs.every((event, i) => {
        const candidate = answer.handoffs[i];
        return event.prop === candidate.prop && event.carrier === candidate.carrier && event.time === candidate.time;
      });
    // A whole turn can resemble no turn at a sampled pose. Check the unwrapped source angle
    // at every reference or candidate breakpoint, plus the independent witness positions above.
    const referenceKeys = reference.tracks[0].keys;
    const candidateKeys = answer.tracks.find((entry) => entry.part === reference.tracks[0].part)?.keys ?? [];
    const times = [...new Set([...referenceKeys, ...candidateKeys].map(({ time }) => time))].sort((a, b) => a - b);
    function angle(keys: typeof referenceKeys, time: number) {
      const next = keys.findIndex((key) => key.time > time);
      if (next === -1) return keys.at(-1)?.value ?? 0;
      if (next === 0) return keys[0].value;
      const start = keys[next - 1], end = keys[next];
      return start.value + (end.value - start.value) * (time - start.time) / (end.time - start.time);
    }
    const driver = times.map((timeSeconds) => {
      const expectedDeg = angle(referenceKeys, timeSeconds);
      const actualDeg = angle(candidateKeys, timeSeconds);
      return { timeSeconds, expectedDeg, actualDeg, passed: Math.abs(expectedDeg - actualDeg) <= 0.001 };
    });
    return { passed: nativeDriveChain && nativeHandoffs && checks.every((entry) => entry.passed)
      && driver.every((entry) => entry.passed), nativeDriveChain, nativeHandoffs, driver, checks };
  } catch (error) {
    return { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
