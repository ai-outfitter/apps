import { effortLevels, type Effort } from "@ai-outfitter/app-sdk/chat-input";
export default function ThinkingEffort({
  enabled,
  disabled,
  effort,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  effort: Effort;
  onChange: (effort: Effort) => void;
}) {
  return (
    <>
      {" "}
      {enabled ? (
        <details className="effort-menu">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: <summary> is natively interactive. */}
          <summary
            aria-label="Thinking effort"
            title={`Thinking effort: ${effort}`}
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="19"
              height="19"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="9" cy="6" r="2" fill="var(--surface)" />
              <circle cx="15" cy="12" r="2" fill="var(--surface)" />
              <circle cx="9" cy="18" r="2" fill="var(--surface)" />
            </svg>
          </summary>
          <fieldset disabled={disabled}>
            <legend>Thinking effort</legend>
            {effortLevels.map((level) => (
              <label key={level}>
                <input
                  type="radio"
                  name="thinking-effort"
                  value={level}
                  checked={effort === level}
                  onChange={(event) => {
                    onChange(level);
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                  }}
                />
                <span>
                  {level === "low" ? "Low" : level === "high" ? "High" : "Max"}
                  <small>
                    {level === "low"
                      ? "Faster answers"
                      : level === "high"
                        ? "More reasoning"
                        : "Deepest reasoning"}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        </details>
      ) : null}
    </>
  );
}
