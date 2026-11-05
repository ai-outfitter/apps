import { z } from "zod";
import { slug } from "./schema";

const opaqueId = z.string().min(1).max(128);
/** Gateway-attested workload identity. Providers own claim names and verification;
 * the platform compares only approved values and never accepts client assertions. */
export const workloadIdentity = z.object({
  issuer: z.string().url().max(1024),
  subject: z.string().min(1).max(2048),
  claims: z.record(z.string().min(1).max(128), z.string().max(2048)),
}).strict();
export const workloadPolicy = z.object({
  issuer: z.string().url().max(1024),
  claims: z.record(z.string().min(1).max(128), z.string().min(1).max(2048))
    .refine(value => Object.keys(value).length > 0, "At least one pinned workload claim is required"),
}).strict();
export const dispatchReceipt = z.object({ externalId: z.string().min(1).max(2048), identityPolicy: workloadPolicy }).strict();
export type DispatchReceipt = z.infer<typeof dispatchReceipt>;
/** Latest authenticated A2A observation; independent of the scheduler's lease state. */
export const residentTaskState = z.enum(["submitted", "working", "input-required", "auth-required", "completed", "failed", "canceled", "rejected"]);
export const residentTaskStatus = z.object({ state: residentTaskState, observedAt: z.number().int().nonnegative() }).strict();
export type ResidentTaskStatus = z.infer<typeof residentTaskStatus>;

export const nodeClaim = z.object({ runId: z.string().uuid(), nodeId: slug, attemptId: z.string().uuid() }).strict();
export const nodeCompletion = z.object({ leaseId: opaqueId, outputs: z.record(z.string().min(1).max(64), z.unknown()) }).strict();
export const nodeToolInvocation = z.object({ leaseId: opaqueId, invocationId: z.string().uuid(), capabilityId: opaqueId, arguments: z.json() }).strict();
export type WorkloadIdentity = z.infer<typeof workloadIdentity>;
export type WorkloadPolicy = z.infer<typeof workloadPolicy>;
const capabilityBase = {
  id: opaqueId, name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  description: z.string().max(8192), inputSchema: z.record(z.string(), z.unknown()).refine(schema => {
    if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > 32768) return false;
    try { z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]); return true; } catch { return false; }
  }, "Capability input schema must compile locally and fit 32 KiB"),
};
export const nodeExecutionContext = z.object({
  profile: z.object({ id: opaqueId, digest: z.string().regex(/^[a-f0-9]{64}$/), systemPrompt: z.string().min(1).max(65536) }).strict(),
  model: z.string().min(1).max(256),
  capabilities: z.array(z.union([
    z.object({ ...capabilityBase, execution: z.literal("broker").default("broker"), effect: z.literal("checkout").optional() }).strict(),
    z.object({ ...capabilityBase, execution: z.literal("workspace"), operation: z.enum(["read", "write", "shell", "test"]) }).strict(),
  ])).max(50),
}).strict().refine(context => new Set(context.capabilities.map(item => item.id)).size === context.capabilities.length &&
  new Set(context.capabilities.map(item => item.name)).size === context.capabilities.length, "Capability IDs and names must be unique")
  .refine(context => new TextEncoder().encode(JSON.stringify(context)).byteLength <= 256 * 1024, "Execution context exceeds 256 KiB");
export type NodeExecutionContext = z.infer<typeof nodeExecutionContext>;

export type NodeLease = {
  leaseId: string; expiresAt: number; runId: string; nodeId: string; attemptId: string;
  definitionHash: string; instructions: string; inputs: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>; context: NodeExecutionContext;
};

/** No substring, case folding, wildcard or caller-selected policy matching. */
export function matchesWorkload(policy: WorkloadPolicy, identity: Pick<WorkloadIdentity, "issuer" | "claims">) {
  return policy.issuer === identity.issuer && Object.entries(policy.claims)
    .every(([name, value]) => Object.hasOwn(identity.claims, name) && identity.claims[name] === value);
}

/** Stable representation for immutable callback evidence and job identity. */
export function canonicalEvidence(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvidence(item)}`).join(",")}}`;
}
