import { z } from "zod";

/** Provider-neutral GraphQL wire contract; no ontology, client or persistence dependency. */
export const graphGraphqlAction = "graph.graphql";
export const graphGraphqlInput = z.strictObject({
  query: z.string().min(1).max(32768),
  variables: z.record(z.string(), z.json()).optional()
    .refine(variables => !variables || new TextEncoder().encode(JSON.stringify(variables)).length <= 32768, "variables may be at most 32 KiB"),
  operationName: z.string().min(1).max(200).optional(),
  maxBytes: z.number().int().min(8192).max(262144).default(65536),
});
export type GraphGraphqlInput = z.input<typeof graphGraphqlInput>;
export const graphqlError = z.strictObject({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z.record(z.string(), z.json()).optional(),
});
export const graphGraphqlResult = z.strictObject({
  data: z.json().nullable(),
  errors: z.array(graphqlError).optional(),
  /** truncated/truncatedPaths when lists were cut to fit maxBytes; naming warnings. */
  extensions: z.record(z.string(), z.json()).optional(),
});
export type GraphGraphqlResult = z.infer<typeof graphGraphqlResult>;

export type GraphGraphqlError = z.infer<typeof graphqlError>;
