import { z } from "zod";

/** Shared metadata for provider implementations. Secrets and runtime grants
 * belong to the authorization service, never to a checked-in manifest. */
export const connectorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    displayName: z.string().min(1),
    implementationVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    contractVersion: z.string().min(1),
    operations: z.array(z.string().min(1)).min(1).readonly(),
    connection: z.object({
      accountsPerOwner: z.enum(["one", "many"]),
      accountSharing: z.enum(["shared", "exclusive"]),
    }).strict().optional(),
    authentication: z
      .discriminatedUnion("type", [
        z
          .object({ type: z.literal("oauth2"), ownership: z.literal("user") })
          .strict(),
        z
          .object({
            type: z.literal("bearer-token"),
            ownership: z.literal("organization"),
          })
          .strict(),
        z
          .object({
            type: z.literal("database-credentials"),
            ownership: z.literal("organization"),
          })
          .strict(),
        z
          .object({
            type: z.literal("resident-cli"),
            ownership: z.literal("organization"),
          })
          .strict(),
        // Data the member imports; the platform stores it (imported.ts).
        z
          .object({ type: z.literal("imported"), ownership: z.literal("user") })
          .strict(),
        z
          .object({
            type: z.literal("access-token"),
            ownership: z.literal("organization"),
          })
          .strict(),
      ])
      .readonly(),
  })
  .strict()
  .refine((value) => value.connection?.accountsPerOwner !== "many" || value.authentication.ownership === "user",
    "Multiple accounts currently require user ownership")
  .readonly();

export type ConnectorDescriptor = z.infer<typeof connectorManifestSchema>;

export interface Connector<
  Descriptor extends ConnectorDescriptor = ConnectorDescriptor,
> {
  readonly descriptor: Descriptor;
}
