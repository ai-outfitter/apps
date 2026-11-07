import { z } from "zod";
import type { WorkflowHost } from "./workflow-host";
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Unreleased v1: the platform authenticates the producer and caller; a policy
 * provider must independently configure and verify its trusted producer. */
export const documentPolicyBinding = z.strictObject({
  version: z.literal(1),
  producer: z.strictObject({ installationId: id }),
  owner: z.strictObject({ kind: z.enum(["user", "organization"]), id }),
  documentId: id,
  revision: z.number().int().positive(),
  digest,
  action: id,
  provider: id,
  config: id,
});
export const documentPolicyResult = z.strictObject({
  binding: documentPolicyBinding,
  decision: z.enum(["allow", "deny", "require-review", "unavailable"]),
  detail: z.json().optional(),
});
export const documentPolicySubject = z.strictObject({
  version: z.literal(1),
  binding: documentPolicyBinding,
  definition: z.strictObject({ id, version: z.number().int().positive() }),
});
export const documentPolicySubjectResult = z.strictObject({
  subject: documentPolicySubject,
  digest,
});
export const documentLifecycleEvent = z.strictObject({
  id,
  binding: documentPolicyBinding.extend({
    action: z.literal("document.sealed"),
  }),
});
export type DocumentPolicyBinding = z.infer<typeof documentPolicyBinding>;
export type DocumentPolicyResult = z.infer<typeof documentPolicyResult>;
export type DocumentPolicySubject = z.infer<typeof documentPolicySubject>;
export type DocumentLifecycleEvent = z.infer<typeof documentLifecycleEvent>;

/** Stable serialization for policy subject digests; object keys use Unicode order. */
export function canonicalDocumentPolicy(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
export async function documentPolicySubjectDigest(
  subject: DocumentPolicySubject,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalDocumentPolicy(documentPolicySubject.parse(subject)),
    ),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** The provider supplies its configured producer and owner, never values selected
 * solely by the requester. The host authenticates and authorizes the read. */
export async function readDocumentPolicySubject(
  host: Pick<WorkflowHost<"interactive">, "call">,
  trusted: {
    producer: DocumentPolicyBinding["producer"];
    owner: DocumentPolicyBinding["owner"];
    provider: string;
    config: string;
  },
  input: DocumentPolicyBinding,
) {
  const binding = documentPolicyBinding.parse(input);
  if (
    canonicalDocumentPolicy(binding.producer) !==
      canonicalDocumentPolicy(trusted.producer) ||
    canonicalDocumentPolicy(binding.owner) !==
      canonicalDocumentPolicy(trusted.owner) ||
    binding.provider !== trusted.provider ||
    binding.config !== trusted.config
  )
    throw new Error("Untrusted policy binding");
  const checkAccess = async () => {
    const items = await host.call("actions.list", {
      installationId: trusted.producer.installationId,
    });
    const match = items.filter(
      (item) => item.installationId === trusted.producer.installationId,
    );
    if (
      match.length !== 1 ||
      !match[0].actions.some(
        (action) =>
          action.name === "document.policy-subject" &&
          action.access === "read" &&
          action.permitted,
      )
    )
      throw new Error("Policy subject source unavailable");
  };
  await checkAccess();
  const result = documentPolicySubjectResult.parse(
    await host.call("actions.call", {
      installationId: trusted.producer.installationId,
      action: "document.policy-subject",
      input: binding,
      readOnly: true,
    }),
  );
  if (
    canonicalDocumentPolicy(result.subject.binding) !==
      canonicalDocumentPolicy(binding) ||
    (await documentPolicySubjectDigest(result.subject)) !== result.digest
  )
    throw new Error("Invalid policy subject");
  await checkAccess();
  return result;
}
