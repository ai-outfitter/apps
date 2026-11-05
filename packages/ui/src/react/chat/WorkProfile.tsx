import { useCallback, useContext, useEffect, useId, useState } from "react";
import type { z } from "zod";
import type { WorkProfile as Profile, workProfileStatus } from "@ai-outfitter/app-sdk/platform-records";
import { ChatComponentContext, usePlatformURL } from "./context";
import { SuggestedApps } from "./SuggestedApps";
import { TurnOnRoutine } from "./TurnOnRoutine";
import { suggestionTask } from "./turn-on-routine";

type Suggestion = Profile["suggestedWorkflows"][number];
type Output = z.infer<typeof workProfileStatus>;

/** Starts or reuses the member's email profile scan, and reports its progress. */
const PROFILE_PATH = "/api/design-partners/profile";
/** Automatic checks while the profile is still being produced, a few seconds apart. */
const PROFILE_CHECKS = 20;
const CHECK_MS = 3000;

/** The profile's suggested routines, each with its own Turn on. */
export function SuggestedRoutines({ suggestions }: { suggestions: Suggestion[] }) {
  return (
    <ul className="work-profile-routines">
      {suggestions.map((suggestion) => (
        <li key={suggestion.title}>
          <strong>{suggestion.title}</strong>
          <span>{suggestion.trigger}</span>
          <p>{suggestion.description}</p>
          <small>{suggestion.whyUseful}</small>
          {suggestion.steps.length ? (
            <details>
              <summary>How it could work</summary>
              <ol>
                {suggestion.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </details>
          ) : null}
          <TurnOnRoutine task={suggestionTask(suggestion)} />
        </li>
      ))}
    </ul>
  );
}


/** Who the member appears to be, their likely role and writing style, then the routines to turn on and apps worth building. */
export function WorkProfile({ profile }: { profile: Profile }) {
  const { whoTheyAre, suspectedRole, writingStyle } = profile;
  return (
    <>
      <p>{whoTheyAre.summary}</p>
      <dl className="work-profile-facts">
        {whoTheyAre.organization ? (
          <div>
            <dt>Organization</dt>
            <dd>{whoTheyAre.organization}</dd>
          </div>
        ) : null}
        <div>
          <dt>Likely role</dt>
          <dd>
            {suspectedRole.title || "Still getting to know your role"}{" "}
            <small>({suspectedRole.confidence} confidence, inferred)</small>
          </dd>
        </div>
        <div>
          <dt>Writing style</dt>
          <dd>
            {writingStyle.traits.length ? writingStyle.traits.join(" · ") : writingStyle.summary}{" "}
            <small>({writingStyle.confidence} confidence, inferred)</small>
          </dd>
        </div>
      </dl>
      {profile.suggestedWorkflows.length ? (
        <>
          <h4>Routines to turn on</h4>
          <SuggestedRoutines suggestions={profile.suggestedWorkflows} />
        </>
      ) : null}
      {profile.suggestedApps.length ? (
        <>
          <h4>
            Apps we could build for you <span className="alpha-tag">Alpha</span>
          </h4>
          <SuggestedApps apps={profile.suggestedApps.map((app, index) => ({ index, app }))} />
        </>
      ) : null}
    </>
  );
}

type View = { status: "running" | "complete" | "failed"; profile: Profile | null; error: string | null } | null;

/** The card's current output: the stored one until a check finds the profile or a failure. */
function asOutput(view: View): Output {
  if (view?.status === "complete" && view.profile) return { status: "ready", profile: view.profile };
  if (view?.status === "failed") return { status: "failed", error: view.error || "We couldn’t finish your profile." };
  return { status: "pending" };
}

/** Starts (`start`) or checks the scan; a failed request becomes a failure to show. */
async function fetchProgress(start: boolean, retry: boolean, platformURL: (path: string) => string): Promise<Output> {
  try {
    const response = await fetch(platformURL(PROFILE_PATH), start
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry }) }
      : { cache: "no-store" });
    if (!response.ok) throw new Error("We couldn’t check your profile. Try again.");
    return asOutput((await response.json()) as View);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Try again." };
  }
}

/**
 * Checks the scan while it runs, a few seconds apart, and on request: a
 * failed scan is started again, anything else is checked again.
 */
function useProfileProgress(initial: Output, enabled: boolean, platformURL: (path: string) => string) {
  const [output, setOutput] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState(0);
  const run = useCallback(async (start: boolean, retry = false) => {
    setChecking(true);
    setOutput(await fetchProgress(start, retry, platformURL));
    setChecking(false);
    setChecks((n) => n + 1);
  }, [platformURL]);
  const waiting = enabled && output.status === "pending" && checks < PROFILE_CHECKS;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void run(false), CHECK_MS);
    return () => clearInterval(timer);
  }, [waiting, run]);
  return { output, checking, refresh: () => void run(true, output.status === "failed") };
}

/**
 * The work_profile card: a first picture of the member's work, inferred from
 * their email. While the profile is still being produced it says so and can
 * be checked again; a static preview makes no request.
 */
export function WorkProfileCard(initial: Output) {
  const context = useContext(ChatComponentContext);
  const headingId = useId();
  const preview = context?.signedIn === false && context.previewFixture === true;
  const { output, checking, refresh } = useProfileProgress(initial, !preview, usePlatformURL());
  return (
    <section className="chat-component work-profile" aria-labelledby={headingId} aria-busy={output.status === "pending"}>
      <h3 id={headingId}>{output.status === "ready" ? "A first picture of your work" : "Getting to know your work"}</h3>
      {output.status === "ready" ? <WorkProfile profile={output.profile} /> : (
        <>
          <p role={output.status === "failed" ? "alert" : "status"}>
            {output.status === "failed" ? output.error : "Your profile is still being built from a sample of your email. It takes a minute."}
          </p>
          <button type="button" className="work-profile-refresh" disabled={checking || preview} aria-busy={checking} onClick={refresh}>
            {output.status === "failed" ? "Try again" : "Check again"}
          </button>
        </>
      )}
    </section>
  );
}
