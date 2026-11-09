import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { scheduleInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import { previewDiscovery, readableConnection, timezone } from "./discovery";
import type { Database } from "./items";

// The daily discovery run. It is on by default: the first time a member opens
// Settings or Sources with a readable Gmail (else Calendar) connection and no
// saved schedule, `defaultSchedule` turns it on for that connection. A member
// can turn it off or move it to another of their direct connections; the app saves the installation's schedule for
// forerunner-discovery, naming that connection, and the platform dispatches the
// `schedule` phase here each morning. The run reads the connection, proposes
// changes and saves them as one Wiki change batch: confident proposals commit,
// the rest wait on the Wiki's Changes page until the member's end of day.

export const discoveryWorkflow = "forerunner-discovery";

export type ScheduleStatus = {
  enabled: boolean;
  connectionId: string | null;
  timezone: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOutcome: string | null;
};

const off: ScheduleStatus = { enabled: false, connectionId: null, timezone: null, nextRunAt: null, lastRunAt: null, lastOutcome: null };

/** The daily run as Settings shows it. Editors only. */
export async function scheduleStatus(host: WorkflowHost<"interactive">, who: AppIdentity): Promise<ScheduleStatus> {
  requireEditor(who);
  const schedule = (await host.call("schedules", {})).find((item) => item.workflowId === discoveryWorkflow);
  return schedule
    ? {
        enabled: schedule.enabled, connectionId: schedule.connectionId, timezone: schedule.timezone,
        nextRunAt: schedule.enabled ? schedule.nextRunAt : null, lastRunAt: schedule.lastRunAt, lastOutcome: schedule.lastOutcome,
      }
    : off;
}

export const scheduleChange = z.strictObject({
  enabled: z.boolean(),
  /** The direct connection to read, as listed by sources: `connection:<id>`. */
  source: z.string().regex(/^connection:[^:]{1,200}$/).optional(),
  timezone: timezone.default("UTC"),
});

/** Turns the daily run on or off. It runs as the member who turned it on. */
export async function changeSchedule(host: WorkflowHost<"interactive">, who: AppIdentity, input: z.infer<typeof scheduleChange>) {
  requireEditor(who);
  if (!input.enabled) {
    const current = (await host.call("schedules", {})).find((item) => item.workflowId === discoveryWorkflow);
    if (current) await host.call("schedule.save", { workflow: discoveryWorkflow, timezone: current.timezone, inputs: current.inputs,
      ...(current.connectionId && current.resource ? { connectionId: current.connectionId, resource: current.resource } : {}), enabled: false });
    return scheduleStatus(host, who);
  }
  if (!input.source) throw new Response("Choose a connected account for the daily run", { status: 400 });
  const id = input.source.slice("connection:".length);
  const connection = (await host.call("snapshot", {})).connections.find((c) => c.id === id);
  if (!connection?.resource || !readableConnection(connection))
    throw new Response("That account is not connected for discovery", { status: 409 });
  await host.call("schedule.save", {
    workflow: discoveryWorkflow, timezone: input.timezone, enabled: true,
    connectionId: connection.id, resource: connection.resource,
    inputs: scheduleInputs(connection),
  });
  return scheduleStatus(host, who);
}

export const scheduleDefault = z.strictObject({ timezone: timezone.default("UTC") });

/**
 * Daily discovery is on by default. With no saved forerunner-discovery
 * schedule at all, this turns it on for the member's readable Gmail
 * connection, else Calendar, in their time zone. Any saved schedule, including
 * one the member turned off, is left as it is, so it never re-enables a run.
 * Personal installations only: an organization's Forerunner reads org sources,
 * not a member's mailbox, so it starts off. Editors only.
 */
export async function defaultSchedule(host: WorkflowHost<"interactive">, who: AppIdentity, input: z.infer<typeof scheduleDefault>) {
  requireEditor(who);
  const saved = (await host.call("schedules", {})).some((item) => item.workflowId === discoveryWorkflow);
  if (saved || who.owner.kind !== "user") return scheduleStatus(host, who);
  const readable = (await host.call("snapshot", {})).connections.filter(readableConnection);
  const connection = readable.find((c) => c.provider === "gmail") ?? readable.find((c) => c.provider === "google-calendar");
  if (!connection?.resource) return off;
  await host.call("schedule.save", {
    workflow: discoveryWorkflow, timezone: input.timezone, enabled: true,
    connectionId: connection.id, resource: connection.resource,
    inputs: scheduleInputs(connection),
  });
  return scheduleStatus(host, who);
}

// Run inputs are named by their workflow slot: forerunner-discovery's analyze step.
const scheduledInputs = z.object({ "analyze.inputs.provider": z.enum(["gmail", "google-calendar", "github", "slack"]), "analyze.inputs.label": z.string().max(300).optional() });
function scheduleInputs(connection: { provider: string; label?: string | null; resource?: string | null }) {
  return { "analyze.inputs.provider": connection.provider, "analyze.inputs.label": (connection.label || connection.resource || "").slice(0, 300) };
}

/** The `schedule` phase: one unattended discovery run of the schedule's connection, as its owner. */
export async function scheduledDiscovery(db: Database, who: AppIdentity, input: PhaseInput, host: WorkflowHost<"schedule">): Promise<PhaseInput> {
  const occurrence = scheduleInput.parse(input);
  const { schedule } = occurrence;
  if (schedule.workflowId !== discoveryWorkflow)
    return { outcome: "declined", reason: `This app does not schedule ${schedule.workflowId}` };
  if (!schedule.connectionId || !schedule.resource) return { outcome: "declined", reason: "No connection on the schedule" };
  const inputs = scheduledInputs.safeParse(schedule.inputs);
  if (!inputs.success) return { outcome: "declined", reason: "The schedule does not name a source discovery reads" };
  const timezone = (await host.call("schedules", {})).find((item) => item.id === schedule.id)?.timezone ?? "UTC";
  const connection = { id: schedule.connectionId, resource: schedule.resource, provider: inputs.data["analyze.inputs.provider"], label: inputs.data["analyze.inputs.label"] || null };
  // The schedule phase can call every operation discovery uses except snapshot,
  // which the known connection replaces.
  const interactive = host as unknown as WorkflowHost<"interactive">;
  const wiki = (await defaultWiki(interactive).catch(() => null))?.installationId;
  // Yesterday's batch closes before today's opens, so its window never overlaps.
  if (wiki) await host.call("actions.call", { installationId: wiki, action: "batch.seal-due", input: {} }).catch(() => undefined);
  try {
    await previewDiscovery(db, who, interactive, { sources: [`connection:${connection.id}`], timezone }, true,
      { runId: occurrence.runId, connection, trigger: "schedule" });
  } catch (error) {
    if (error instanceof Response && error.status < 500)
      return { outcome: "declined", reason: (await error.text()).slice(0, 500) || "Discovery did not run" };
    throw error;
  }
  return { outcome: "started" };
}
