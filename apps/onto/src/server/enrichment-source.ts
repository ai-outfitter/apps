import { repositoryEnrichmentOutput } from "@ai-outfitter/app-sdk/repository-enrichment";

export function isRepositoryEvidence(value: unknown) {
  return typeof value === "object" && value !== null && "provider" in value
    && repositoryEnrichmentOutput.shape.provider.safeParse(value.provider).success;
}

export function isEnrichmentSource(source: { kind?: unknown; ref?: unknown } | null | undefined) {
  return source?.kind === "agent-task" && typeof source.ref === "string" && source.ref.startsWith("enrichment/");
}
