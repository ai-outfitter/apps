import { useState } from "react";
import { usePlatformURL } from "./context";
import { firstRunResult, type RoutineTask, startRoutine, type TurnedOnRoutine } from "./turn-on-routine";

// One state machine for every card that turns a task on: starting the routine,
// waiting for its first run, then its result, a failed run, or why it could not
// be turned on.

export type TurnOnState =
  | { phase: "idle" }
  | { phase: "starting" }
  /** The routine is on and its first run is still writing. */
  | { phase: "waiting"; routine: TurnedOnRoutine }
  /** The first run wrote its result, or polling stopped before it did. */
  | { phase: "done"; routine: TurnedOnRoutine }
  | { phase: "failed"; routine: TurnedOnRoutine }
  /** The routine could not be turned on; the card may try again. */
  | { phase: "error"; message: string };

/** The routine is being turned on or its first run is still writing. */
export const turningOn = (state: TurnOnState) => state.phase === "starting" || state.phase === "waiting";

export function useTurnOnRoutine() {
  const [state, setState] = useState<TurnOnState>({ phase: "idle" });
  const platformURL = usePlatformURL();
  /** Turns `task` on and waits for its first run; null when it could not be turned on. */
  const turnOn = async (task: RoutineTask): Promise<TurnedOnRoutine | null> => {
    setState({ phase: "starting" });
    let started: Awaited<ReturnType<typeof startRoutine>>;
    try {
      started = await startRoutine(task, platformURL);
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not turn it on" });
      return null;
    }
    setState({ phase: "waiting", routine: started });
    const routine = await firstRunResult(started, platformURL);
    setState({ phase: routine.status === "failed" ? "failed" : "done", routine });
    return routine;
  };
  /** Shows a static preview's fixture result; nothing is saved or run. */
  const showPreview = (routine: TurnedOnRoutine) => setState({ phase: "done", routine });
  return { state, turnOn, showPreview };
}
