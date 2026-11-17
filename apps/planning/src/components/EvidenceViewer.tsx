import { useEffect, useState } from "react";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import type { EvidenceView } from "@ai-outfitter/app-sdk/visual-evidence";
import "../evidence.css";

type Media = EvidenceView["steps"][number]["media"][number];
function MediaItem({ media }: { media: Media }) {
  const [allowed, setAllowed] = useState(
    media.href.startsWith("/") && !media.href.startsWith("//"),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const url = new URL(media.href, location.origin);
    setAllowed(
      url.origin === location.origin ||
        url.hostname === "software-foundry.outfitter.ai-outfitter.com",
    );
  }, [media.href]);
  return (
    <figure className="evidence-media">
      {!allowed ? (
        <button type="button" onClick={() => setAllowed(true)}>
          Load media from {new URL(media.href, "https://local.invalid").host}
        </button>
      ) : failed ? (
        <p role="status">
          This capture is unavailable. Its description and source are retained.
        </p>
      ) : media.kind === "video" ? (
        <video
          controls
          preload="none"
          playsInline
          src={media.href}
          onError={() => setFailed(true)}
          aria-label={media.caption}
        />
      ) : (
        <a href={media.href} target="_blank" rel="noreferrer">
          <img
            src={media.href}
            alt={media.caption}
            loading="lazy"
            ref={(image) => {
              if (image?.complete && image.naturalWidth === 0) setFailed(true);
            }}
            onError={() => setFailed(true)}
          />
        </a>
      )}
      <figcaption>
        {media.caption}{" "}
        <a
          href={media.downloadHref ?? media.href}
          download={media.downloadHref ? undefined : true}
        >
          {media.kind === "video" ? "Download video" : "Open full-size image"}
        </a>
      </figcaption>
    </figure>
  );
}
export default function EvidenceViewer({
  bundle,
  comparisons = [],
  projectRevision,
  evidenceHref,
}: {
  bundle: EvidenceView;
  comparisons?: EvidenceView[];
  projectRevision?: number;
  evidenceHref?: string;
}) {
  const [index, setIndex] = useState(0);
  const [gallery, setGallery] = useState(false);
  const [compare, setCompare] = useState(false);
  const step = bundle.steps[index];
  const before = comparisons.find(
    (candidate) =>
      candidate.id === step?.before?.bundle.id &&
      candidate.revision === step.before.bundle.revision,
  );
  const previous = before?.steps.find((s) => s.id === step?.before?.stepId);
  useEffect(() => {
    const page = agentPage("planning");
    if (bundle.project)
      page.set({
        focus: {
          kind: "planning-project",
          id: bundle.project.id,
          label: bundle.title,
          revision: projectRevision ?? bundle.project.revision,
        },
      });
    page.describe({
      title: bundle.title,
      summary: step?.description || bundle.summary,
      state: {
        bundleId: bundle.id,
        bundleRevision: bundle.revision,
        productRevision: bundle.productRevision ?? null,
        stepId: step?.id ?? null,
        media:
          step?.media.map((m) => ({
            id: m.id,
            href: m.href,
            sha256: m.sha256 ?? null,
          })) ?? [],
      },
    });
  }, [bundle, step, projectRevision]);
  const discuss = () => {
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-agent-sidebar-toggle][aria-controls="planning-agent"]',
    );
    if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
    document
      .querySelector<HTMLTextAreaElement>("#planning-agent textarea")
      ?.focus();
  };
  return (
    <section className="evidence-review" aria-label="Visual evidence">
      <header>
        <p className="evidence-eyebrow">
          {bundle.source?.environment ?? "Environment unknown"}
          {bundle.source?.seeded ? " · Seeded data" : ""}
          {bundle.source?.dirty ? " · Modified working tree" : ""}
        </p>
        <h2>{bundle.title}</h2>
        <p>{bundle.summary}</p>
        <p className="muted">
          {bundle.capturedAt
            ? `Captured ${bundle.capturedAt}`
            : "Capture date not recorded"}
          {bundle.source?.commit
            ? ` · ${bundle.source.commit.slice(0, 12)}`
            : ""}
        </p>
      </header>
      {!bundle.steps.some((s) => s.media.length) && (
        <p role="status">No visual evidence captured.</p>
      )}
      {!!bundle.steps.length && (
        <>
          <nav className="evidence-toolbar" aria-label="Evidence views">
            <button
              type="button"
              aria-pressed={!gallery}
              onClick={() => setGallery(false)}
            >
              Walkthrough
            </button>
            <button
              type="button"
              aria-pressed={gallery}
              onClick={() => setGallery(true)}
            >
              Gallery
            </button>
            {step?.before && (
              <button
                type="button"
                aria-pressed={compare}
                onClick={() => setCompare(!compare)}
              >
                Before / after
              </button>
            )}
            <button type="button" onClick={discuss}>
              Discuss this step
            </button>
          </nav>
          {gallery ? (
            <div className="evidence-gallery">
              {bundle.steps.map((s, i) => (
                <article key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setIndex(i);
                      setGallery(false);
                    }}
                  >
                    {i + 1}. {s.title}
                  </button>
                  {s.media.map((m) => (
                    <MediaItem key={m.id + m.href} media={m} />
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <div className="evidence-walkthrough">
              <nav aria-label="Walkthrough steps">
                <ol>
                  {bundle.steps.map((s, i) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={i === index ? "step" : undefined}
                        onClick={() => setIndex(i)}
                      >
                        {s.title}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
              <article>
                <p className="evidence-eyebrow">
                  Step {index + 1} of {bundle.steps.length}
                </p>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <div className={compare ? "evidence-comparison" : ""}>
                  {compare && (
                    <section>
                      <h4>Before</h4>
                      {previous ? (
                        <>
                          <p>
                            {before?.title} · record revision {before?.revision}
                          </p>
                          {previous.media.map((m) => (
                            <MediaItem key={m.id + m.href} media={m} />
                          ))}
                        </>
                      ) : (
                        <p>
                          The exact earlier capture is not available here.{" "}
                          {step.before && evidenceHref && (
                            <a
                              href={`${evidenceHref}?bundle=${step.before.bundle.id}`}
                            >
                              Open earlier bundle
                            </a>
                          )}
                        </p>
                      )}
                    </section>
                  )}
                  <section>
                    {compare && (
                      <h4>After · record revision {bundle.revision}</h4>
                    )}
                    {step.media.length ? (
                      step.media.map((m) => (
                        <MediaItem key={m.id + m.href} media={m} />
                      ))
                    ) : (
                      <p>No media captured for this step.</p>
                    )}
                  </section>
                </div>
                <div className="evidence-toolbar">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => setIndex(index - 1)}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={index === bundle.steps.length - 1}
                    onClick={() => setIndex(index + 1)}
                  >
                    Next
                  </button>
                </div>
              </article>
            </div>
          )}
        </>
      )}
      <details>
        <summary>Capture details and limitations</summary>
        <ul>
          {bundle.limitations.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        {bundle.productRevision && (
          <p>
            Product revision {bundle.productRevision.id} · record revision{" "}
            {bundle.productRevision.revision}
          </p>
        )}
        {bundle.source && (
          <p>
            Source commit: <code>{bundle.source.commit}</code>
            {bundle.source.release && ` · Release ${bundle.source.release}`}
            {bundle.source.build && ` · Build ${bundle.source.build}`}
          </p>
        )}
        <p>
          Evidence records observed behavior. It does not itself approve a
          release.
        </p>
      </details>
    </section>
  );
}
