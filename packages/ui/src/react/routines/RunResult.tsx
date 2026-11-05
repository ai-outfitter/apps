import { type ResultWriters, routineResultOf } from "../../routines/routine-result";
import { usePlatformURL } from "../chat/context";
import Markdown from "../Markdown";
import RoutineResultView, { ResultActions } from "./RoutineResultView";
import { type RoutineCompletion, useRunFinish } from "./use-run-finish";

// A run's declared primary output. A result in the routine result shape reads
// and copies like one; text renders as markdown and anything else as JSON.
// Given the run's finish step, either shape copies and finishes the same way.

function OtherResult({ value, label, completion }: { value: unknown; label: string; completion?: RoutineCompletion }) {
  const run = useRunFinish(completion, usePlatformURL());
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <section className="run-result" aria-label={label}>
      {typeof value === "string" ? <Markdown>{value}</Markdown> : <pre>{text}</pre>}
      <ResultActions text={text} run={run} />
    </section>
  );
}

export default function RunResult({
  value,
  label,
  completion,
  writers,
  returnTo,
}: {
  value: unknown;
  label: string;
  completion?: RoutineCompletion;
  /** The member's Google connections a routine result's drafts and events save with. */
  writers?: ResultWriters;
  /** This page's path, where Google consent returns when a button connects. */
  returnTo?: string;
}) {
  const routine = routineResultOf(value);
  if (routine) return <RoutineResultView result={routine} label={label} completion={completion} writers={writers} returnTo={returnTo} />;
  return <OtherResult value={value} label={label} completion={completion} />;
}
