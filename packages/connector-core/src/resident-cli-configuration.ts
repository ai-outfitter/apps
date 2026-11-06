import { z } from "zod";
import { connectorManifestSchema } from "./manifest";

export const residentCliConfigurationManifestSchema = connectorManifestSchema
  .unwrap()
  .safeExtend({
    contractVersion: z.literal("resident.cli-config.v1"),
    operations: z
      .tuple([z.literal("server.configure"), z.literal("status.inspect")])
      .readonly(),
    authentication: z
      .object({
        type: z.literal("resident-cli"),
        ownership: z.literal("organization"),
      })
      .strict()
      .readonly(),
  })
  .readonly();

export type ResidentCliConfigurationDescriptor = z.infer<
  typeof residentCliConfigurationManifestSchema
>;
