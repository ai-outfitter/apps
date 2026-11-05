import { useState } from "react";
import { finishRoutineRun, type PlatformURL, type RoutineFinish, samePath } from "../../routines/routine-result";

/** The run a result belongs to, when the member can finish it here, and its finish step. */
export type RoutineCompletion = { runId: string; completed: boolean; step: string };

/**
 * Finishing a run from its result: the first copy or "Mark completed" submits
 * the finish step once. `copied` is undefined when the run cannot be finished here.
 */
export function useRunFinish(completion?: RoutineCompletion, platformURL: PlatformURL = samePath) {
  const [state, setState] = useState<"open" | "saving" | "completed">(completion?.completed ? "completed" : "open");
  const [error, setError] = useState<string | null>(null);
  const finish = async (how: RoutineFinish) => {
    if (!completion || state !== "open") return;
    setState("saving");
    setError(null);
    try {
      await finishRoutineRun(completion.runId, how, completion.step, platformURL);
      setState("completed");
    } catch (failure) {
      setState("open");
      // A copy still worked when finishing did not; only the button reports why.
      if (how === "marked") setError(failure instanceof Error ? failure.message : "Could not mark it completed");
    }
  };
  return { state, error, finish, copied: completion ? () => void finish("copied") : undefined };
}
