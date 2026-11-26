// Repository authority on a Forgejo organization connection. Forgejo has no
// installation tokens: the connection's bot token is the authority, and the
// repository must grant it the permission the caller asks for. The platform
// approves the connection's origin (src/lib/forgejo-connection.ts) first.
import { z } from "zod";

const nameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .refine((name) => !name.split("/").some((part) => part === "." || part === ".."));

const repositorySchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string(),
    owner: z.object({ id: z.number().int().positive() }).loose(),
    permissions: z.object({ admin: z.boolean(), push: z.boolean(), pull: z.boolean() }).loose(),
  })
  .loose();

/** A Forgejo organization connection's authority: its approved origin and the
 * bot account whose token it stores. */
export type ForgejoAuthority = {
  /** API origin, e.g. https://forgejo.example (no path). */
  origin: string;
  /** The bot account's access token. */
  token: string;
  /** The bot account's id: its comments, statuses and reviews carry it. */
  botUserId: number;
};

/** The Forgejo API base for request paths like `/repos/<owner>/<name>`. */
export const forgejoApiBase = (config: ForgejoAuthority) => `${config.origin}/api/v1`;

/**
 * Verifies the bot can act on the repository with the given permissions and
 * returns the same shape as a GitHub repository installation token.
 */
export async function forgejoRepositoryToken(
  repository: string,
  config: ForgejoAuthority,
  permissions: Record<string, "read" | "write">,
  expectedId?: number,
  transport: (request: Request) => Promise<Response> = (request) => fetch(request),
) {
  const name = nameSchema.parse(repository).toLowerCase();
  const response = await transport(
    new Request(`${forgejoApiBase(config)}/repos/${name}`, {
      headers: { Authorization: `token ${config.token}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Response("Forgejo repository unavailable", { status: response.status === 404 ? 404 : 403 });
  }
  const repo = repositorySchema.safeParse(await response.json());
  const write = Object.values(permissions).includes("write");
  if (!repo.success || repo.data.full_name.toLowerCase() !== name ||
    (expectedId !== undefined && repo.data.id !== expectedId) ||
    !(write ? repo.data.permissions.push : repo.data.permissions.pull))
    throw new Response("Unexpected repository token scope", { status: 403 });
  return {
    token: config.token,
    // The bot token does not expire; callers re-verify per scope.
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    path: `/repos/${name}`,
    name,
    repositoryId: repo.data.id,
    installationId: repo.data.owner.id,
    permissions,
    forge: "forgejo" as const,
    apiBase: forgejoApiBase(config),
    botUserId: config.botUserId,
    executionIdentity: { provider: "forgejo", kind: "bot", installationId: repo.data.owner.id, appId: config.botUserId },
  };
}
