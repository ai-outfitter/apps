import { z } from "zod";
import { connectorManifestSchema, type Connector } from "./manifest";

export const repositoryReadManifestSchema = connectorManifestSchema
  .unwrap()
  .safeExtend({
    contractVersion: z.literal("repository.read.v1"),
    operations: z
      .tuple([
        z.literal("repositories.verify"),
        z.literal("issues.read"),
        z.literal("pull-requests.read"),
      ])
      .readonly(),
    authentication: z
      .object({
        type: z.literal("access-token"),
        ownership: z.literal("organization"),
      })
      .strict()
      .readonly(),
  })
  .readonly();

export type RepositoryReadDescriptor = z.infer<
  typeof repositoryReadManifestSchema
>;
export type RepositoryRef = { owner: string; repo: string };
export type RepositoryMetadata = RepositoryRef & {
  id: number;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  url: string;
};
export type RepositoryWorkItem = {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
};
export type RepositoryPage<T> = {
  items: T[];
  page: number;
  limit: number;
  coverage:
    { outcome: "complete" } | { outcome: "partial"; reason: "page_limit" };
};

export interface RepositoryReadConnector extends Connector<RepositoryReadDescriptor> {
  authenticatedActor(): Promise<{ id: number; login: string }>;
  verifyRepository(input: RepositoryRef): Promise<RepositoryMetadata>;
  readIssues(
    input: RepositoryRef & {
      state?: "open" | "closed" | "all";
      page?: number;
      limit?: number;
    },
  ): Promise<RepositoryPage<RepositoryWorkItem>>;
  readPullRequests(
    input: RepositoryRef & {
      state?: "open" | "closed" | "all";
      page?: number;
      limit?: number;
    },
  ): Promise<RepositoryPage<RepositoryWorkItem>>;
}
