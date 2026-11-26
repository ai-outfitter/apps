import { readText } from "@ai-outfitter/connector-core/http";
import type {
  RepositoryMetadata,
  RepositoryPage,
  RepositoryReadConnector,
  RepositoryRef,
  RepositoryWorkItem,
} from "@ai-outfitter/connector-core/repository-read";
import { z } from "zod";
import { FORGEJO_DESCRIPTOR } from "./descriptor";

export type ForgejoTransport = (request: Request) => Promise<Response>;
export const forgejoTransport: ForgejoTransport = (request) => fetch(request);
export const MAX_FORGEJO_PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 512 * 1024;
const segment = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..");
export const forgejoRepositorySchema = z
  .object({ owner: segment, repo: segment })
  .strict();

const actorSchema = z
  .object({ id: z.number().int().nonnegative(), login: segment })
  .loose();
const repositorySchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: segment,
    full_name: z.string().min(3).max(201),
    description: z.string().max(10_000).nullish(),
    default_branch: z.string().max(255).nullish(),
    private: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .loose();
const workItemSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(10_000),
    state: z.enum(["open", "closed"]),
    created_at: z.iso.datetime().nullish(),
    updated_at: z.iso.datetime().nullish(),
  })
  .loose();

export class ForgejoProviderError extends Error {
  constructor(readonly kind: "credential" | "not_found" | "provider") {
    super("Forgejo read failed. Verify the connection and try again.");
  }
}

const loopbackHost = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);

/** An HTTPS Forgejo origin on a public name. `loopback` also admits an HTTP or
 * HTTPS origin on this machine (127.0.0.1, localhost, [::1]): only for an
 * origin the operator listed, such as a sealed app box's own Forgejo. */
export function normalizeForgejoOrigin(value: string, loopback = false) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Response("Enter an HTTPS Forgejo origin", { status: 400 });
  }
  const local = loopback && loopbackHost(url.hostname) && ["http:", "https:"].includes(url.protocol);
  if (
    (url.protocol !== "https:" && !local) ||
    url.origin !== value.trim() ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!local &&
      (url.hostname === "localhost" ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
        url.hostname.startsWith("[")))
  )
    throw new Response("Enter an HTTPS Forgejo origin without a path", {
      status: 400,
    });
  return url.origin;
}

/** The origin, when the operator lists it (FORGEJO_ALLOWED_ORIGINS, comma
 * separated). Listed origins are HTTPS on a public name, or one on this machine
 * that the operator names exactly (a sealed app box's own Forgejo). */
export function approvedForgejoOrigin(origin: string, allowedOrigins: string | undefined) {
  const listed = (allowedOrigins || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = normalizeForgejoOrigin(origin, listed.includes(origin.trim()));
  const allowed = new Set(
    listed.flatMap((value) => {
      try {
        return [normalizeForgejoOrigin(value, true)];
      } catch {
        return [];
      }
    }),
  );
  if (!allowed.has(normalized))
    throw new Response("Forgejo origin is not approved by the operator", {
      status: 403,
    });
  return normalized;
}

function safeRef(input: RepositoryRef) {
  return forgejoRepositorySchema.parse({
    owner: input.owner,
    repo: input.repo,
  });
}

export class ForgejoReadConnector implements RepositoryReadConnector {
  readonly descriptor = FORGEJO_DESCRIPTOR;
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly transport: ForgejoTransport = forgejoTransport,
    /** The origin is an operator-listed one on this machine (see normalizeForgejoOrigin). */
    loopback = false,
  ) {
    this.origin = normalizeForgejoOrigin(origin, loopback);
    if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token))
      throw new Response("Invalid Forgejo token", { status: 400 });
  }

  private async call(path: string, params?: URLSearchParams) {
    const url = new URL(`/api/v1${path}`, this.origin);
    if (params) url.search = params.toString();
    let response: Response;
    try {
      response = await this.transport(
        new Request(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `token ${this.token}`,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        }),
      );
    } catch (error) {
      if (error instanceof Response) throw error;
      throw new ForgejoProviderError("provider");
    }
    if (response.status >= 300 && response.status < 400)
      throw new ForgejoProviderError("provider");
    if (response.status === 401 || response.status === 403)
      throw new ForgejoProviderError("credential");
    if (response.status === 404) throw new ForgejoProviderError("not_found");
    if (!response.ok) throw new ForgejoProviderError("provider");
    try {
      return JSON.parse(
        await readText(response, MAX_RESPONSE_BYTES),
      ) as unknown;
    } catch {
      throw new ForgejoProviderError("provider");
    }
  }

  async authenticatedActor() {
    const parsed = actorSchema.safeParse(await this.call("/user"));
    if (!parsed.success) throw new ForgejoProviderError("provider");
    return { id: parsed.data.id, login: parsed.data.login };
  }

  async verifyRepository(input: RepositoryRef): Promise<RepositoryMetadata> {
    const ref = safeRef(input);
    const parsed = repositorySchema.safeParse(
      await this.call(
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
      ),
    );
    if (!parsed.success) throw new ForgejoProviderError("provider");
    const expected = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (parsed.data.full_name.toLowerCase() !== expected)
      throw new ForgejoProviderError("provider");
    return {
      id: parsed.data.id,
      owner: ref.owner,
      repo: ref.repo,
      fullName: parsed.data.full_name,
      description: parsed.data.description ?? "",
      defaultBranch: parsed.data.default_branch ?? "",
      private: parsed.data.private,
      archived: parsed.data.archived,
      url: `${this.origin}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
    };
  }

  readIssues(input: RepositoryRef & PageInput) {
    return this.readWorkItems("issues", input);
  }

  readPullRequests(input: RepositoryRef & PageInput) {
    return this.readWorkItems("pulls", input);
  }

  private async readWorkItems(
    resource: "issues" | "pulls",
    input: RepositoryRef & PageInput,
  ): Promise<RepositoryPage<RepositoryWorkItem>> {
    const ref = safeRef(input);
    const page = boundedPage(input.page, 1, 1000);
    const limit = boundedPage(input.limit, 25, MAX_FORGEJO_PAGE_SIZE);
    const state = input.state ?? "open";
    const params = new URLSearchParams({
      state,
      page: String(page),
      limit: String(limit),
    });
    if (resource === "issues") params.set("type", "issues");
    const raw = await this.call(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${resource}`,
      params,
    );
    const parsed = z
      .array(z.union([workItemSchema, z.null()]))
      .max(limit)
      .safeParse(raw);
    if (!parsed.success) throw new ForgejoProviderError("provider");
    const noun = resource === "issues" ? "issues" : "pulls";
    const items = parsed.data.flatMap((item) =>
      item
        ? [
            {
              number: item.number,
              title: item.title,
              state: item.state,
              url: `${this.origin}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${noun}/${item.number}`,
              createdAt: item.created_at ?? null,
              updatedAt: item.updated_at ?? null,
            },
          ]
        : [],
    );
    return {
      items,
      page,
      limit,
      coverage:
        parsed.data.length === limit
          ? { outcome: "partial", reason: "page_limit" }
          : { outcome: "complete" },
    };
  }
}

type PageInput = {
  state?: "open" | "closed" | "all";
  page?: number;
  limit?: number;
};
function boundedPage(value: number | undefined, fallback: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Response("Invalid Forgejo page", { status: 400 });
  return result;
}
