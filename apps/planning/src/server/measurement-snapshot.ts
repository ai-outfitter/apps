/** Proposed adapter boundary only. Not connected to providers, storage, or report generation. */
export type MeasurementSource = "google-analytics" | "posthog" | "stripe" | "databricks";
export interface MeasurementRequest {
  owner: { kind: "user" | "organization"; id: string };
  projectId: string;
  /** Existing Onto definition identity and immutable revision, not a copied formula. */
  metric: { installationId: string; id: string; revision: number };
  connectionId: string;
  source: MeasurementSource;
  queryRevision: string;
  window: { start: string; end: string; timezone: string };
  audience: "internal-test" | "external-customer";
  purpose: "checkpoint" | "outcome";
}
export type MeasurementSnapshot = MeasurementRequest & {
  capturedAt: string;
  unit: string;
} & (
  | { status: "observed"; value: number; evidenceRefs: string[]; complete: true }
  | { status: "unavailable" | "partial" | "stale"; value: null; reason: string; evidenceRefs: string[]; complete: false }
);
export interface MeasurementAdapter {
  /** Must enforce connection authorization and owner scope before querying a provider. */
  capture(request: MeasurementRequest): Promise<MeasurementSnapshot>;
}
/** Deliberately no provider calls or synthetic values. Each provider needs an authorized adapter. */
export const measurementAdapterStubs: Record<MeasurementSource, { status: "not-implemented" }> = {
  "google-analytics": { status: "not-implemented" },
  posthog: { status: "not-implemented" },
  stripe: { status: "not-implemented" },
  databricks: { status: "not-implemented" },
};
