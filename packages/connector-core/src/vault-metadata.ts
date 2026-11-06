import { z } from "zod";
import type { Connector } from "./manifest";
import { connectorManifestSchema } from "./manifest";

export const VAULT_METADATA_CONTRACT = "vault-metadata.validate.v1" as const;

export const vaultMetadataManifestSchema = connectorManifestSchema
  .unwrap()
  .safeExtend({
    contractVersion: z.literal(VAULT_METADATA_CONTRACT),
    operations: z.tuple([z.literal("vaults.validate")]).readonly(),
    authentication: z
      .object({
        type: z.literal("bearer-token"),
        ownership: z.literal("organization"),
      })
      .strict()
      .readonly(),
  })
  .readonly();

export type VaultMetadataDescriptor = z.infer<
  typeof vaultMetadataManifestSchema
>;

export interface VaultMetadataValidation {
  readonly vaultCount: number;
}

/** Validation-only capability. It intentionally has no item or secret reads. */
export interface VaultMetadataConnector extends Connector<VaultMetadataDescriptor> {
  validateVaultMetadata(): Promise<VaultMetadataValidation>;
}
