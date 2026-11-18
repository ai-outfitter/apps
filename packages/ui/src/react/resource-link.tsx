import type { ReactNode } from "react";

export type ResourceLinkData = { uri?: unknown; name?: unknown } | null;

/** Render the persisted MCP user-facing link as a simple, muted transcript link. */
export function ResourceLink({ data }: { data: ResourceLinkData }): ReactNode {
  return data && typeof data.uri === "string" && typeof data.name === "string"
    ? <p className="agent-resource-link"><a href={data.uri} target="_blank" rel="noopener noreferrer">{data.name}</a></p>
    : null;
}
