import { z } from "zod";

const provider = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
const context = z.string().regex(/^(?:authorize|webhook|(?:admit|execute):[\s\S]{1,128})$/);
const slots = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/), z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/));
const bindingsSchema = z.record(provider, z.record(context, slots));
const request = z.object({ kind: z.enum(["admit", "authorize", "execute", "webhook"]), provider,
  operation: z.string().optional(), credentials: z.record(z.string(), z.string()) });

/** Operator-owned binding references, never input from an app or browser. Only
 * this provider and operation's declared slots reach the connector adapter. */
export function brokerCredentials(configuration: unknown, lookup: (name: string) => unknown) {
  return (body: unknown): unknown => {
    const call = request.safeParse(body);
    if (!call.success || (["admit", "execute"].includes(call.data.kind) && typeof call.data.operation !== "string")) return body; // Broker owns validation, including describe.
    try {
      const bindings = bindingsSchema.parse(typeof configuration === "string" ? JSON.parse(configuration) : configuration ?? {});
      const key = ["admit", "execute"].includes(call.data.kind) ? `${call.data.kind}:${call.data.operation}` : call.data.kind;
      const contexts = Object.hasOwn(bindings, call.data.provider) ? bindings[call.data.provider] : {};
      const selected = Object.hasOwn(contexts, key) ? contexts[key] : {};
      const credentials = Object.fromEntries(Object.entries(selected).map(([slot, binding]) => {
        const value = lookup(binding);
        if (typeof value !== "string" || !value || value.length > 65536) throw new Error("Unavailable binding");
        return [slot, value];
      }));
      // An admission's access token may be supplied by the authenticated control
      // plane. It cannot replace operator-owned application credential slots.
      return { ...body as Record<string, unknown>, credentials: { ...call.data.credentials, ...credentials } };
    } catch {
      // Do not serialize parsing errors: configuration and environment values
      // are server-only even when an operator misconfigures this mapping.
      throw new Response("Connector credentials unavailable", { status: 503 });
    }
  };
}
