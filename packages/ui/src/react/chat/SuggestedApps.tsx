import { useCallback, useContext, useEffect, useState } from "react";
import { type AppToBuild, AUDIENCE, operationsText } from "./app-suggestions";
import { BUILD_CHECKS, BUILDS_PATH, CHECK_MS } from "./app-build-checks";
import { ChatComponentContext, usePlatformURL } from "./context";

// A work profile's suggested apps, each with its Build this (or Approve and
// build): in the work profile card, on the home brief and on /apps. The agent
// suggests them from the member's mail; the member only approves the build.

type Build = { state: "idle" | "building" } | { state: "built"; url: string } | { state: "failed"; message: string };
type BuildStatus = { name: string } & ({ status: "building" | "failed" } | { status: "built"; url: string });

const FAILED = "We couldn’t build this app. Try again.";

const buildOf = (status: BuildStatus | undefined): Build =>
  !status ? { state: "idle" }
  : status.status === "built" ? { state: "built", url: status.url }
  : status.status === "failed" ? { state: "failed", message: FAILED }
  : { state: "building" };

/** A static preview (a fixture transcript, or a page told so) makes no request. */
function usePreview(preview?: boolean) {
  const context = useContext(ChatComponentContext);
  return preview ?? (context?.signedIn === false && context.previewFixture === true);
}

/**
 * Builds the suggestion at `index` (platform admins while in alpha); anyone else is told it's still coming.
 * A data app (`workflow`) builds as a workflow, and the page checks on it until the app is
 * served at `/apps/<id>/`; one that reads the member's data asks them to approve that first.
 */
function BuildThis({ index, name, workflow, approval, preview, unavailable, onBuildChange }: { index: number; name: string; workflow: boolean; approval?: string; preview: boolean; unavailable?: string; onBuildChange?: () => void }) {
  const [build, setBuild] = useState<Build>({ state: "idle" });
  const [checks, setChecks] = useState(0);
  const platformURL = usePlatformURL();
  const check = useCallback(async () => {
    const response = await fetch(platformURL(BUILDS_PATH), { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const next = buildOf(((await response.json()) as BuildStatus[]).find((status) => status.name === name));
    setBuild((current) => (next.state === "idle" ? current : next));
  }, [name, platformURL]);
  useEffect(() => {
    if (workflow && !preview) void check().catch(() => undefined);
  }, [workflow, preview, check]);
  useEffect(() => {
    if (!workflow || build.state !== "building" || checks >= BUILD_CHECKS) return;
    const timer = setTimeout(() => {
      setChecks((count) => count + 1);
      void check().catch(() => undefined);
    }, CHECK_MS);
    return () => clearTimeout(timer);
  }, [workflow, build.state, check, checks]);
  const start = async () => {
    setBuild({ state: "building" });
    setChecks(0);
    try {
      const response = await fetch(platformURL(BUILDS_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, name, ...(approval ? { approve: true } : {}) }),
      });
      if (!response.ok) throw new Error((await response.text()) || FAILED);
      // 202: the build runs as a workflow; the checks above follow it.
      onBuildChange?.();
      if (response.status === 202) return;
      const built = (await response.json()) as { url: string };
      setBuild({ state: "built", url: built.url });
    } catch (error) {
      setBuild({ state: "failed", message: error instanceof Error ? error.message : FAILED });
    }
  };
  return (
    <>
      {unavailable ? <small>{unavailable}</small> : null}
      {approval && build.state !== "built" ? <small>Building this lets the app {approval}.</small> : null}
      <button type="button" className="work-profile-refresh" disabled={Boolean(unavailable) || preview || build.state === "building" || build.state === "built"} aria-busy={build.state === "building"} onClick={() => void start()}>
        {build.state === "building" ? "Building…" : approval ? "Approve and build" : "Build this"}
      </button>
      {build.state === "built" ? (
        <p className="work-profile-app-later" role="status">
          Built. <a href={build.url.startsWith("/") ? platformURL(build.url) : build.url}>Open the first version</a>
        </p>
      ) : build.state === "failed" ? (
        <p className="work-profile-app-later" role="status">{build.message}</p>
      ) : null}
    </>
  );
}

/**
 * The profile's suggested apps, each with its place on the profile (Build this
 * names it by both): its goal, who it's for, how success is counted and what
 * it uses. `compact` keeps the goal and the build control.
 */
export function SuggestedApps({ apps, compact = false, preview, unavailable, onBuildChange }: { apps: AppToBuild[]; compact?: boolean; preview?: boolean; unavailable?: string; onBuildChange?: () => void }) {
  const staticPreview = usePreview(preview);
  return (
    <ul className="work-profile-routines work-profile-apps">
      {apps.map(({ index, app }) => (
        <li key={app.name}>
          <strong>{app.name}</strong>
          <p>{app.goal}</p>
          {compact ? null : (
            <>
              <dl className="work-profile-facts">
                <div>
                  <dt>For</dt>
                  <dd>
                    {AUDIENCE[app.audience]}: {app.persona.name}. <small>{app.persona.need}</small>
                  </dd>
                </div>
                <div>
                  <dt>Success looks like</dt>
                  <dd>
                    <ul>
                      {app.successMetrics.map((metric) => (
                        <li key={metric.name}>
                          {metric.name}: <strong>{metric.target}</strong>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>
              <small>{app.whyUseful}</small>
              {app.operations?.length ? <small>Uses: {operationsText(app.operations)}</small> : null}
            </>
          )}
          <BuildThis index={index} name={app.name} workflow={Boolean(app.record || app.operations?.length)}
            unavailable={unavailable} onBuildChange={onBuildChange} approval={app.operations?.length ? operationsText(app.operations) : undefined} preview={staticPreview} />
        </li>
      ))}
    </ul>
  );
}
