import { z } from "zod";
import { schemaJSON, type FieldSchema } from "./agent-schema";
import { defineOperation, operationAPI, type AppOperation } from "./operations";
import { type AppActor, type AppIdentity, requestActor, requestIdentity, requestOriginActor } from "./server";

/** App-owned actions: named handlers with input and output schemas. The platform
 * discovers and invokes them for other apps (workflow host); the owning app keeps
 * validation, policy and business logic. See docs/app-actions.md. */
export const actionPath = "/api/internal/actions/v1";
/** An installation publishes actions. */
export const actionCapability = "actions.publish";
/** A `workflow.host` package may invoke other installations' actions. */
export const actionInvokeCapability = "actions.invoke";

export const actionName = z.string().min(3).max(64).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
/** An action a sidebar agent offers as a tool (publishActionTools, actionToolDescriptor) carries this name. */
export const appMcpToolName = z.string().min(3).max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/).refine(name => !name.startsWith("outfitter_") && !name.startsWith("graph_"));

/** The assigned-work convention (docs/app-actions.md#assigned-work-worklist):
 * `work.list` takes `{}` and returns the items the caller's current duties
 * assign. `id` is stable; `revision` changes whenever an item's state or
 * evidence does. Other fields are the app's own. */
export const workListAction = "work.list";
export const workContextAction = "work.context";
export const workContextInput = z.strictObject({
  id: z.string().min(1).max(256),
  revision: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]),
});
export const workContextResult = z.object({
  rendererVersion: z.union([z.literal(1), z.literal(2)]), mediaType: z.literal("text/markdown"),
  markdown: z.string().refine(value => new TextEncoder().encode(value).length <= 48 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(z.object({ ref: z.object({ installationId: z.string(), type: z.string(), id: z.string() }), revision: z.number().int().positive() })),
  complete: z.boolean(),
  omitted: z.array(z.object({ installationId: z.string(), type: z.string(), id: z.string() })),
  unresolved: z.array(z.object({ installationId: z.string(), type: z.string(), id: z.string() })),
  excluded: z.array(z.object({ installationId: z.string(), type: z.string(), id: z.string() })).optional(),
  unmaterialized: z.boolean().optional(),
});
export const workListResult = z.object({
  work: z.array(z.object({
    id: z.string().min(1).max(256),
    revision: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]),
  })).max(1000),
});

export const actionDescriptor = z.strictObject({
  name: actionName,
  description: z.string().max(4000),
  /** Writes default to an editor; an explicit app policy can enforce domain roles. */
  access: z.enum(["read", "write"]),
  /** Whether the current identity may invoke it. Discovery grants nothing. */
  permitted: z.boolean(),
  /** Whether a read-only call may run it: a read action, or a write action with
   * a side-effect-free `read` variant. Absent from older apps (no). */
  readOnly: z.boolean().optional(),
  input: z.record(z.string(), z.json()),
  output: z.record(z.string(), z.json()),
  /** A member of another organization may call it (role `external`). */
  external: z.literal(true).optional(),
});
export type ActionDescriptor = z.infer<typeof actionDescriptor>;

/** What a handler receives: the verified member identity, the immediate caller
 * and the caller that initiated the chain, all from trusted platform headers. */
export type ActionContext = { identity: AppIdentity; actor: AppActor; originActor: AppActor };

export type AppAction<Context extends ActionContext> = {
  description: string;
  access: "read" | "write";
  input: FieldSchema;
  output: FieldSchema;
  /** A read-only call may run it. */
  readOnly: boolean;
  /** The tool name a sidebar agent offers it under. */
  mcpTool?: string;
  /** A member of another organization may call it. */
  external?: true;
  permitted(context: Context): boolean;
  /** `readOnly` runs the action's side-effect-free form, or refuses (403). */
  invoke(context: Context, input: unknown, readOnly?: boolean): Promise<unknown>;
};

export function defineAction<Context extends ActionContext, Input extends z.ZodType, Output extends z.ZodType>(definition: {
  description: string;
  access: "read" | "write";
  input: Input;
  output: Output;
  /** Explicit namespaced tool name for a sidebar agent, e.g. planning_product_list. */
  mcpTool?: string;
  /** Override the default editor gate with the app's domain policy. The handler
   * must still authorize the specific record against fresh state on every call. */
  canInvoke?: (context: Context) => boolean;
  /** A member of another organization (role `external`, with
   * `identity.callerOrganizationId`) may call it; such a caller may call
   * nothing else. The handler decides whom it serves and what they may do. */
  external?: true;
  run: (context: Context, input: z.output<Input>) => unknown | Promise<unknown>;
  /** For a write action: a variant with no side effects that a read-only caller
   * (such as a delegated work scan) runs instead of `run`. It must not change
   * any state; read actions need none. */
  read?: (context: Context, input: z.output<Input>) => unknown | Promise<unknown>;
}): AppAction<Context> {
  const permitted = (context: Context) => context.identity.callerOrganizationId || context.identity.role === "external"
    ? Boolean(definition.external)
    : definition.canInvoke?.(context) ?? (definition.access === "read" || context.identity.canEdit);
  return {
    description: definition.description,
    access: definition.access,
    input: schemaJSON(definition.input),
    output: z.toJSONSchema(definition.output, { io: "output", unrepresentable: "throw" }) as FieldSchema,
    readOnly: definition.access === "read" || Boolean(definition.read),
    ...(definition.mcpTool ? { mcpTool: appMcpToolName.parse(definition.mcpTool) } : {}),
    ...(definition.external ? { external: true as const } : {}),
    permitted,
    async invoke(context, raw, readOnly = false) {
      if (!permitted(context)) throw new Response("App action not allowed", { status: 403 });
      // Checked against this definition as it runs, never a catalog read earlier.
      const handler = !readOnly || definition.access === "read" ? definition.run : definition.read;
      if (!handler) throw new Response("This action changes state; a read-only call cannot run it", { status: 403 });
      const input = definition.input.safeParse(raw);
      if (!input.success) throw new Response(`Invalid action input: ${z.prettifyError(input.error).slice(0, 1000)}`, { status: 400 });
      const result = definition.output.safeParse(await handler(context, input.data));
      if (!result.success) throw new Response("Invalid app action result", { status: 502 });
      return result.data;
    },
  };
}

/** Name each action of a sidebar agent's registry as a tool, once here, never in the
 * sidebar adapter. Collisions fail at construction. */
export function publishActionTools<A extends Record<string, AppAction<ActionContext>>>(app: string, actions: A): { [K in keyof A]: A[K] & { mcpTool: string } } {
  const prefix = app.replaceAll("-", "_");
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(prefix)) throw new Error("Invalid app tool namespace");
  const seen = new Set<string>();
  return Object.fromEntries(Object.entries(actions).map(([name, action]) => {
    actionName.parse(name);
    const mcpTool = appMcpToolName.parse(action.mcpTool ?? `${prefix}_${name.replace(/[.-]/g, "_")}`);
    if (!mcpTool.startsWith(`${prefix}_`) || seen.has(mcpTool)) throw new Error(`Conflicting app tool declaration: ${mcpTool}`);
    seen.add(mcpTool);
    return [name, { ...action, mcpTool }];
  })) as { [K in keyof A]: A[K] & { mcpTool: string } };
}

/** The model-facing descriptor a sidebar agent offers an action under. */
export function actionToolDescriptor(action: Pick<AppAction<never>, "mcpTool" | "description" | "input" | "access">) {
  if (!action.mcpTool) throw new Error("Agent actions must be named with publishActionTools or mcpTool");
  return {
    name: appMcpToolName.parse(action.mcpTool), description: action.description,
    inputSchema: z.record(z.string(), z.json()).parse(action.input),
    ...(action.access === "read" ? { store: false as const } : {}),
  };
}

/** `access: "read"` asks for a call that changes nothing. An app built before
 * this field refuses the unknown key, so such a call fails closed. */
const actionCall = z.strictObject({ action: actionName, input: z.json(), access: z.literal("read").optional() });

/** `list` and `call` on the shared operation dispatcher. */
export function actionOperations<Context extends ActionContext>(actions: Record<string, AppAction<Context>>, options: { maxCallBytes?: number } = {}): Record<string, AppOperation<Context>> {
  const maxCallBytes = options.maxCallBytes ?? 256 * 1024;
  if (!Number.isInteger(maxCallBytes) || maxCallBytes < 1 || maxCallBytes > 4_010_000) throw new Error("Invalid action call size limit");
  for (const name of Object.keys(actions)) actionName.parse(name);
  return {
    list: defineOperation({
      method: "GET", input: z.strictObject({}), output: z.array(actionDescriptor),
      authorize: () => {},
      run: (context: Context) => Object.entries(actions).map(([name, action]) => ({
        name, description: action.description, access: action.access,
        permitted: action.permitted(context), readOnly: action.readOnly, input: action.input, output: action.output,
        ...(action.external ? { external: true as const } : {}),
      })),
    }),
    call: defineOperation({
      method: "POST", input: actionCall, output: z.json(), maxBytes: maxCallBytes,
      authorize: (_context: Context, input) => {
        if (!Object.hasOwn(actions, input.action)) throw new Response("App action not found", { status: 404 });
      },
      run: (context, input) => actions[input.action].invoke(context, input.input, input.access === "read"),
    }),
  };
}

/** Mount at `${actionPath}/[operation]` behind the app's identity middleware.
 * Agent ingress refuses this prefix; only authenticated platform dispatch reaches it.
 * `extra` adds the route's own capabilities (such as its workflow host) to the context. */
export function actionAPI<Extra extends object>(
  request: Request,
  operation: string,
  actions: Record<string, AppAction<ActionContext & Extra>>,
  extra: (identity: AppIdentity) => Extra,
  options: { maxCallBytes?: number } = {},
) {
  return operationAPI(request, operation, actionOperations(actions, options), () => {
    const identity = requestIdentity(request);
    return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...extra(identity) };
  });
}

/** Canonical JSON for revision-bound cross-app subjects; object field order is not evidence. */
export function canonicalActionValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalActionValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => `${JSON.stringify(key)}:${canonicalActionValue(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
