import { useContext } from "react";
import { ROUTINE_FINISH_STEP } from "../../routines/routine-result";
import RoutineResultView from "../routines/RoutineResultView";
import { ChatComponentContext, usePlatformURL } from "./context";
import { previewRoutine, type RoutineTask, routinePath, runPath, type TurnedOnRoutine, turnedOnMessage } from "./turn-on-routine";
import { useTurnOnRoutine } from "./use-turn-on-routine";

/** Why a turned-on routine shows no result yet: still writing, failed, or no longer waited on. */
function firstRunNote(routine: TurnedOnRoutine, waiting: boolean) {
  if (waiting) return "Turned on. The first run is reading your recent mail and calendar…";
  if (routine.status === "failed") return "The first run failed before it wrote a result. The routine stays on for its next run.";
  return "The first run is still working. Open it to see its result.";
}

/**
 * A turned-on routine's first result, with links to the run and all routines.
 * `waiting`: the first run is still writing its result.
 */
export function RoutineResult({
  title,
  routine,
  preview = false,
  waiting = false,
}: {
  title: string;
  routine: TurnedOnRoutine;
  preview?: boolean;
  waiting?: boolean;
}) {
  const platformURL = usePlatformURL();
  const { result } = routine;
  const heading = `${preview ? "Preview choice" : "Turned on"}: ${title}`;
  return (
    <div className="routine-result" role="status" aria-busy={waiting}>
      <p>
        <strong>{heading}</strong>
      </p>
      {result ? (
        <RoutineResultView
          result={result}
          label={heading}
          completion={preview ? undefined : { runId: routine.runId, completed: routine.status === "complete", step: ROUTINE_FINISH_STEP }}
        />
      ) : (
        <p>{firstRunNote(routine, waiting)}</p>
      )}
      {preview ? null : (
        <p>
          <a href={platformURL(runPath(routine.runId))}>See the first run</a> ·{" "}
          <a href={platformURL(routinePath(routine.scheduleId))}>Routine and its runs</a>
        </p>
      )}
    </div>
  );
}

/**
 * One "Turn on" button for a suggested task: saves it as the member's routine
 * and starts it once (`POST /api/routines`), then shows the first result here
 * once the run has written it.
 * In a chat it also sends what was turned on as the member's message; a static
 * preview shows a fixture result and makes no request. A failure says why and
 * leaves the button usable.
 */
export function TurnOnRoutine({ task }: { task: RoutineTask }) {
  const context = useContext(ChatComponentContext);
  const { state, turnOn, showPreview } = useTurnOnRoutine();
  const preview = context?.signedIn === false && context.previewFixture === true;
  const busy = state.phase === "starting";
  const click = async () => {
    if (state.phase !== "idle" && state.phase !== "error") return;
    if (preview) return showPreview(previewRoutine(task.title, task.cadence));
    const routine = await turnOn(task);
    if (routine && context?.signedIn) context.send(turnedOnMessage(task.title, routine));
  };
  if ("routine" in state)
    return <RoutineResult title={task.title} routine={state.routine} preview={preview} waiting={state.phase === "waiting"} />;
  return (
    <div className="turn-on-routine">
      <button
        type="button"
        className="primary"
        disabled={busy || context?.busy}
        aria-busy={busy}
        aria-label={`Turn on ${task.title}`}
        onClick={() => void click()}
      >
        {busy ? "Turning on…" : "Turn on"}
      </button>
      {busy ? <p role="status">Turning on “{task.title}” and running it once…</p> : null}
      {state.phase === "error" ? <p role="alert">Couldn’t turn on “{task.title}”: {state.message}</p> : null}
    </div>
  );
}
