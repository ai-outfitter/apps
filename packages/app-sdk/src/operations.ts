import { z } from "zod";
import { schemaJSON, type FieldSchema } from "./agent-schema";
import { readJSON, respond } from "./server";

/** A validated, authorized app operation. The caller supplies its context;
 * transports never infer domain permissions from schemas or HTTP methods. */
export type AppOperation<Context> = {
  method: "GET" | "POST";
  description: string;
  inputSchema: FieldSchema;
  outputSchema: FieldSchema;
  execute(request: Request, context: Context): Promise<unknown>;
};

export function defineOperation<Context, Input extends z.ZodType, Output extends z.ZodType>(definition: {
  method: "GET" | "POST";
  input: Input;
  output: Output;
  maxBytes?: number;
  description?: string;
  authorize(context: Context, input: z.output<Input>): void | Promise<void>;
  run(context: Context, input: z.output<Input>): unknown | Promise<unknown>;
}): AppOperation<Context> {
  return {
    method: definition.method,
    description: definition.description ?? "",
    inputSchema: schemaJSON(definition.input),
    outputSchema: z.toJSONSchema(definition.output, { io: "output", unrepresentable: "throw" }) as FieldSchema,
    async execute(request, context) {
      const input = definition.method === "GET"
        ? definition.input.parse({})
        : await readJSON(request, definition.input, definition.maxBytes ?? 128 * 1024) as z.output<Input>;
      await definition.authorize(context, input);
      const result = definition.output.safeParse(await definition.run(context, input));
      if (!result.success) throw new Response("Invalid app operation result", { status: 502 });
      return result.data;
    },
  };
}

/** Shared HTTP adapter. Apps can use the same operations from a trusted local
 * adapter via execute(); authentication belongs to the supplied context. */
export function operationAPI<Context>(
  request: Request,
  name: string,
  operations: Record<string, AppOperation<Context>>,
  context: () => Context | Promise<Context>,
) {
  return respond(async () => {
    if (!Object.hasOwn(operations, name)) throw new Response("Operation not found", { status: 404 });
    const operation = operations[name];
    if (request.method !== operation.method) throw new Response("Method not allowed", { status: 405 });
    return operation.execute(request, await context());
  });
}
