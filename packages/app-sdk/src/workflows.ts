import type { RunState, RunStatus, StepStatus } from "@ai-outfitter/workflow-core/engine";
import type { Workflow } from "@ai-outfitter/workflow-core/schema";
export type { Workflow } from "@ai-outfitter/workflow-core/schema";
import type { WorkflowPackage } from "@ai-outfitter/workflow-core/artifact";

/** Generic installed-app workflow API, independent of app or provider vocabulary. */
export type WorkflowCatalog = { packageHash: string; workflows: WorkflowPackage[] };
export type WorkflowNodeAttempt = { taskStatus?: import("@ai-outfitter/workflow-core/execution").ResidentTaskStatus; sessionArtifact?: {id:string;runId:string} | null; nodeId: string; state: "pending" | "dispatching" | "dispatched" | "running" | "complete" | "failed" | "uncertain"; createdAt: number; updatedAt: number; expiresAt: number };
export type ExecutorBinding = { id: string; revision: string; label: string; workflowId: string; actor: string; kind: "external" | "resident"; enabled: boolean; model: string | null; profile: {id:string;digest:string} | null; configuration: {valid:boolean;reason?: "binding_unavailable"} };
export type WorkflowRun = {
  attempts: WorkflowNodeAttempt[];
  id: string; workflow: Workflow; createdBy: string; createdAt: number; updatedAt: number;
  organizationId: string | null; installationId: string | null;
  inputs: RunState["inputs"]; rows: RunState["rows"]; steps: Record<string, StepStatus>; status: RunStatus;
  dispatch?: { status: "accepted" | "finished" | "failed"; error: string | null };
};
export type WorkflowSubscription = {
  id: string; connectionId: string; resource: string; workflowId: string;
  inputs: Record<string, unknown>; enabled: boolean; createdBy: string;
};
export type SaveWorkflowSubscription = Pick<WorkflowSubscription, "connectionId" | "resource" | "workflowId" | "inputs"> & { enabled?: boolean; createOnly?: boolean };

export class WorkflowRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "WorkflowRequestError"; }
}

/** Uses only the current app origin. Server admission remains authoritative;
 * these types describe its wire format, not trusted client-supplied authority. */
export function workflowClient(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, body?: unknown, method = "GET"): Promise<T> {
    const response = await fetcher(path, { method, credentials: "same-origin", headers: { Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new WorkflowRequestError(response.status, (await response.text()).slice(0, 1024) || "Workflow request failed");
    return response.json() as Promise<T>;
  }
  return {
    bindings: () => request<{ items: ExecutorBinding[]; truncated: boolean }>("/api/platform/executor-bindings"),
    catalog: () => request<WorkflowCatalog>("/api/platform/workflows"),
    runs: (workflowId?: string) => request<{ items: WorkflowRun[] }>(`/api/workflow-runs${workflowId ? `?${new URLSearchParams({ workflow: workflowId })}` : ""}`),
    run: (id: string) => request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}`),
    start: (workflow: string, inputs: Record<string, unknown>) => request<WorkflowRun>("/api/workflow-runs", { workflow, inputs }, "POST"),
    step: (id: string, step: string, input: { message: string } | { response: unknown }) => request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}`, input, "POST"),
    subscriptions: () => request<{ items: WorkflowSubscription[] }>("/api/platform/workflow-subscriptions"),
    saveSubscription: (input: SaveWorkflowSubscription) => request<{ id: string }>("/api/platform/workflow-subscriptions", input, "PUT"),
  };
}
