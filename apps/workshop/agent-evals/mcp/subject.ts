import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentRunOptions } from "@vercel/agent-eval";

type Args = Record<string, any>;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const names = {
  read: "WorkshopAssembly",
  save: "UpdateWorkshopAssembly",
  upload: "UploadWorkshopAssemblyFile",
  verify: "VerifyWorkshopAssemblyFile",
};

export async function exercise(
  fixture: string,
  files: string[],
  options: AgentRunOptions,
) {
  const {
    MCP_URL: url,
    MCP_ACCESS_TOKEN: token,
    WORKSHOP_EVAL_SCOPE: scope,
  } = process.env;
  if (!url || !token || !scope)
    throw Error(
      "Set MCP_URL, MCP_ACCESS_TOKEN and WORKSHOP_EVAL_SCOPE for an installation where disposable projects may be created",
    );
  const client = await createMCPClient({
    transport: {
      type: "http",
      url,
      headers: { Authorization: "Bearer " + token },
    },
  });
  const trace: Args[] = [];
  const tickets = new Set<string>();
  const originals = new Map(
    files.map((name) => [name, readFileSync(join(fixture, name))]),
  );
  const field = (document: string) =>
    document[0].toLowerCase() + document.slice(1);
  const call = async (name: string, args: Args) => {
    const r = await client.callTool({ name, arguments: args });
    const block =
      Array.isArray(r.content) && r.content.find((b) => b.type === "text");
    if (!block) throw Error("MCP returned no text response");
    try {
      return JSON.parse(block.text);
    } catch {
      return { error: block.text };
    }
  };
  const control = async (name: string, document: string, variables: Args) => {
    const r = await call(name, {
      scope,
      app: "workshop",
      document,
      variables,
      ...(name === "graph_query" && { includeIdentifiers: true }),
    });
    if (!r.data?.[field(document)])
      throw Error(
        "Fixture " + document + " failed: " + JSON.stringify(r).slice(0, 300),
      );
    return r.data[field(document)];
  };
  try {
    const title = "Probe spacer eval " + randomUUID().slice(0, 8);
    const project = await control("graph_mutate", "CreateWorkshopProject", {
      input: { example: "cube", name: title },
    });
    const projectId: string = project.id;
    const read = () => control("graph_query", names.read, { projectId });
    const save = (expectedRevision: number, assembly: unknown) =>
      control("graph_mutate", names.save, {
        projectId,
        expectedRevision,
        assembly,
      });
    const part = (name: string, number: string, kind: string) => ({
      id: randomUUID(),
      name,
      number,
      kind,
      revision: "A",
    });
    const root = part("Field instrument", "FI", "assembly"),
      spacer = part("Probe spacer", "PS", "printed"),
      clamp = part("Cable clamp", "CC", "cots");
    const seed = {
      rootId: root.id,
      items: [
        {
          ...root,
          uses: [spacer, clamp].map((i) => ({
            id: randomUUID(),
            itemId: i.id,
            quantity: 1,
          })),
        },
        spacer,
        clamp,
      ],
    };
    await control("graph_mutate", names.save, {
      projectId,
      expectedRevision: project.revision,
      assembly: seed,
    });
    const baseline = await read();
    let edit: Promise<number> | undefined;
    const tools: ToolSet = {};
    const definitions = await client.listTools();
    for (const d of definitions.tools.filter((d) =>
      ["graph_documents", "graph_query", "graph_mutate"].includes(d.name),
    )) {
      tools[d.name] = tool({
        description: d.description,
        inputSchema: jsonSchema<Args>(d.inputSchema),
        execute: async (args) => {
          const { document, variables = {} } = args;
          if (
            (args.scope && args.scope !== scope) ||
            (args.app && args.app !== "workshop")
          )
            return { error: "Use the assigned eval installation." };
          if (d.name !== "graph_documents") {
            if (document === "WorkshopProjects" && d.name === "graph_query")
              args = { ...args, variables: { ...variables, ids: [projectId] } };
            else if (document === "Viewer" && d.name === "graph_query")
              return call(d.name, args);
            else if (
              (variables.projectId ?? variables.input?.projectId) !==
                projectId ||
              (d.name === "graph_mutate" &&
                ![names.upload, names.save].includes(document))
            )
              return {
                error: "Only the assigned eval project may be accessed.",
              };
          }
          // The second writer commits immediately before the first attempted upload.
          if (d.name === "graph_mutate" && document === names.upload) {
            edit ??= (async () => {
              const other = await read();
              other.assembly.items
                .find((i: Args) => i.id === root.id)
                .uses.find((u: Args) => u.itemId === clamp.id).quantity = 3;
              return (await save(other.revision, other.assembly)).revision;
            })();
            await edit;
          }
          const result = await call(d.name, { ...args, scope });
          const value = result.data?.[document && field(document)];
          const discovery = result.apps?.workshop;
          trace.push({
            tool: d.name,
            document,
            discovered: discovery && [
              ...Object.keys(discovery.queries ?? {}),
              ...Object.keys(discovery.mutations ?? {}),
            ],
            revision: value?.revision,
            status: value?.status,
            errors: result.errors?.map((e: Args) => e.extensions?.status),
            expectedRevision: variables.input?.expectedRevision,
            itemId: variables.input?.itemId,
            fileName: variables.input?.fileName,
            ...(document === names.verify &&
              value && { verifiedFile: value.file }),
          });
          if (value?.status === "awaiting_upload")
            tickets.add(value.upload.url);
          return result;
        },
      });
    }
    // File tools operate only on the supplied originals and an upload URL issued this run.
    tools.inspect_file = tool({
      description: "Inspect a local file's text, byte length and SHA-256.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const b = originals.get(name);
        if (b) trace.push({ tool: "inspect_file", fileName: name });
        return b
          ? { bytes: b.length, sha256: digest(b), text: b.toString("utf8") }
          : { error: "Unknown file" };
      },
    });
    tools.http_put = tool({
      description:
        "PUT a local file unchanged to a URL with the supplied HTTP headers.",
      inputSchema: z.object({
        name: z.string(),
        url: z.string(),
        headers: z.record(z.string(), z.string()),
      }),
      execute: async ({ name, url, headers }) => {
        const b = originals.get(name);
        if (!b || !tickets.has(url)) return { error: "Unknown file or ticket" };
        const res = await fetch(url, {
          method: "PUT",
          body: new Uint8Array(b),
          headers,
          redirect: "error",
          signal: options.signal,
        });
        trace.push({
          tool: "http_put",
          fileName: name,
          httpStatus: res.status,
        });
        return { status: res.status };
      },
    });
    let answer = "",
      model = String(options.model);
    try {
      const result = await generateText({
        model: openai.responses(model),
        tools,
        stopWhen: stepCountIs(32),
        abortSignal: options.signal,
        maxRetries: 0,
        system:
          "Use the connected MCP and file tools to carry out the user's request. Work only on the named project.",
        prompt:
          options.prompt +
          "\nOrganization: " +
          scope +
          "\nProject: " +
          title +
          "\nLocal files: " +
          files.join(", "),
      });
      answer = result.text;
      model = result.response.modelId;
    } catch (error) {
      answer = "Agent run failed: " + (error as Error).name;
    }
    // Only the controller can supply these independent before/after reads to the grader.
    const final = await read();
    return {
      projectId,
      model,
      answer,
      spacerId: spacer.id,
      clampId: clamp.id,
      baseline,
      editedRevision: await edit,
      final,
      trace,
    };
  } finally {
    await client.close();
  }
}
