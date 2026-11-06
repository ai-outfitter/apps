import { z } from "zod";
import { cronIssue } from "./cron";

// Workflow model v2 (#106): actors, steps and the references between them. A
// step's typed outputs are its completion evidence. This module validates
// definitions and fixtures; it runs nothing. Keys are only ever added, each with
// a default that preserves the meaning of every stored definition.

/** JSON Schema written inline. File references are inlined before parsing. */
const JsonSchema = z.record(z.string(), z.unknown());
export const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const slotName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);

/** A slot or record field name; references, match keys and fields share it. */
const FIELD = "[A-Za-z][A-Za-z0-9-]*";
const PATH = `(?:\\.${FIELD})*`;
const REFERENCE = new RegExp(
  `^([a-z][a-z0-9-]*)\\.(inputs|outputs)\\.(${FIELD})(${PATH})$`,
);
/** `<step>.inputs.<slot>` or `<step>.outputs.<slot>`, optionally `.<field>`. */
export const Reference = z
  .string()
  .regex(
    REFERENCE,
    "must be <step>.inputs.<slot> or <step>.outputs.<slot>[.<field>]",
  );

const WHEN = new RegExp(
  `^(?<path>${REFERENCE.source.slice(1, -1)}) (?:(?<op>==|!=) (?<literal>\\S+)|(?<test>empty|nonEmpty))$`,
);
/** A `when` as its reference, operator and literal. */
export function parseWhen(when: string) {
  const { path, op, literal, test } = WHEN.exec(when)?.groups ?? {};
  return {
    path,
    op: (op ?? test) as "==" | "!=" | "empty" | "nonEmpty",
    literal,
  };
}
/** One comparison on one reference. */
const When = z
  .string()
  .regex(
    WHEN,
    "must be `<reference> == <value>`, `<reference> != <value>`, `<reference> empty` or `<reference> nonEmpty`",
  );

const Category = z.enum([
  "mail",
  "calendar",
  "git-forge",
  "chat",
  "ats",
  "hris",
  "payments",
  "database",
  "vault",
  "web",
  "health",
]);
const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item).min(1)]);

const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }).strict(),
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("resident"), binding: Reference.optional() }).strict(),
  z.object({ kind: z.literal("external"), binding: Reference }).strict(),
]);

const EventMatchValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Trigger = z.discriminatedUnion("on", [
  z.object({ on: z.literal("event"), type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/).max(128), input: z.string().min(1).max(128),
    /** Exact equality against fields in the verified event payload. */
    match: z.record(z.string().regex(new RegExp(`^${FIELD}${PATH}$`)), EventMatchValue).optional(),
  }).strict(),
  z.object({ on: z.literal("manual") }).strict(),
  z
    .object({
      on: z.literal("schedule"),
      cron: z
        .string()
        .regex(/^\S+( \S+){4}$/, "must be a five-field cron")
        .superRefine((cron, ctx) => {
          const issue = cronIssue(cron);
          if (issue) ctx.addIssue({ code: "custom", message: issue });
        }),
    })
    .strict(),
]);

/** A path to another slot, or an unbound run input with its schema. */
const Input = z.union([
  Reference,
  z.object({ schema: JsonSchema, default: z.unknown().optional() }).strict(),
]);

/** Something the actor returns, or something a connector reports. */
const Output = z.union([
  z.object({ schema: JsonSchema }).strict(),
  z
    .object({
      connector: oneOrMany(Category),
      record: oneOrMany(
        z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
      ),
      /** Record field path → reference; every pair must be equal. */
      match: z
        .record(z.string().regex(new RegExp(`^${FIELD}${PATH}$`)), Reference)
        .optional(),
      schema: JsonSchema.optional(),
    })
    .strict(),
]);

/**
 * Limits for the model answers an app asks for on its own step
 * (`inference.generate` naming the step). Each one omitted is the platform's
 * default. The timeout stays within the 14 minutes the host gives a phase.
 */
export const StepInference = z
  .object({
    maxOutputTokens: z.number().int().min(1).max(32000).optional(),
    timeoutMs: z.number().int().min(1000).max(840_000).optional(),
    reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
  })
  .strict();
export type StepInference = z.infer<typeof StepInference>;

const Step = z
  .object({
    id: slug,
    /** A trusted event input and server-written execution receipt. */
    source: z.literal("event").optional(),
    actor: slotName.optional(),
    when: When.optional(),
    uses: z.array(Category).optional(),
    inputs: z.record(slotName, Input).optional(),
    instructions: z.string().min(1).max(16000).optional(),
    /** Shorthand for `outputs: {response: {schema}}`. */
    form: z.object({ schema: JsonSchema }).strict().optional(),
    outputs: z.record(slotName, Output).optional(),
    inference: StepInference.optional(),
  })
  .strict();

type Step = z.infer<typeof Step>;
type Definition = {
  actors: Record<string, z.infer<typeof Actor>>;
  steps: Step[];
  outputs?: Record<string, string | Record<string, string>>;
  display?: { result: string; title?: string; finish?: string };
  $defs?: Record<string, Record<string, unknown>>;
};
type Issue = { path: (string | number)[]; message: string };
export type Slot = { schema?: Record<string, unknown>; bound?: string };
/** `gates` names the step a reference must precede; `match` and outputs gate none. */
type Ref = { path: string; at: (string | number)[]; gates?: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

/** The exact self-contained schema shared by server validation and runners. */
export function withWorkflowDefs(schema: Record<string, unknown>, defs: Definition["$defs"]) {
  const local = schema.$defs as Definition["$defs"];
  return { ...schema, ...(defs || local ? { $defs: { ...defs, ...local } } : {}) };
}

const compiled = new WeakMap<object, z.ZodType>();
/**
 * Slot schemas compile once against the workflow's `$defs`; the same shape
 * validates rows. A schema's own `$defs` add to the workflow's.
 */
export function compileSlotSchema(
  schema: Record<string, unknown>,
  defs: Definition["$defs"],
) {
  let shape = compiled.get(schema);
  if (!shape) {
    shape = z.fromJSONSchema(withWorkflowDefs(schema, defs) as Parameters<typeof z.fromJSONSchema>[0]);
    compiled.set(schema, shape);
  }
  return shape;
}

const slotIndexes = new WeakMap<Definition, Map<string, Slot>>();
/** Every slot by `<step>.<inputs|outputs>.<slot>`, with `form` as `outputs.response`. */
export function slotIndex(wf: Definition) {
  const cached = slotIndexes.get(wf);
  if (cached) return cached;
  const slots = new Map<string, Slot>();
  for (const step of wf.steps) {
    for (const [name, input] of Object.entries(step.inputs ?? {}))
      slots.set(
        `${step.id}.inputs.${name}`,
        typeof input === "string" ? { bound: input } : { schema: input.schema },
      );
    for (const [name, output] of Object.entries(step.outputs ?? {}))
      slots.set(`${step.id}.outputs.${name}`, { schema: output.schema });
    if (step.form)
      slots.set(`${step.id}.outputs.response`, { schema: step.form.schema });
  }
  slotIndexes.set(wf, slots);
  return slots;
}

/** A reference's step, its `<step>.<io>.<slot>` key and any field path. */
export function split(path: string) {
  const [, step, io, slot, fields] = REFERENCE.exec(path) ?? [];
  return {
    step,
    slot: `${step}.${io}.${slot}`,
    fields: fields ? fields.slice(1).split(".") : [],
  };
}

type Lookup = {
  /** Some branch lists `properties`, so an unlisted field is absent. */
  declares?: boolean;
  schema?: unknown;
  /** `$defs` in scope at `schema`; a schema's own `$defs` add to the workflow's. */
  defs: Definition["$defs"];
};
/** Finds a field across `$ref`, `oneOf`/`anyOf`/`allOf` and sibling `properties`. */
function lookupField(
  schema: unknown,
  field: string,
  outer: Definition["$defs"],
): Lookup {
  if (!isObject(schema)) return { defs: outer };
  const node = schema;
  const defs = node.$defs
    ? { ...outer, ...(node.$defs as Definition["$defs"]) }
    : outer;
  const found: Lookup[] = [];
  if (typeof node.$ref === "string") {
    const name = /^#\/\$defs\/(.+)$/.exec(node.$ref)?.[1];
    found.push(lookupField(name && defs?.[name], field, defs));
  }
  for (const key of ["oneOf", "anyOf", "allOf"])
    for (const branch of Array.isArray(node[key]) ? node[key] : [])
      found.push(lookupField(branch, field, defs));
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties)
    found.push({ declares: true, schema: properties[field], defs });
  return (
    found.find((item) => item.schema !== undefined) ?? {
      declares: found.some((item) => item.declares),
      defs,
    }
  );
}

/** Resolves a reference to its slot schema; bound inputs inherit their source's. */
function referencedSchema(
  path: string,
  slots: Map<string, Slot>,
  defs: Definition["$defs"],
  seen = new Set<string>(),
): Lookup | { error: string } {
  const { slot, fields } = split(path);
  const found = slots.get(slot);
  if (!found) return { error: `${slot} does not exist` };
  let resolved: Lookup = { schema: found.schema, defs };
  if (found.bound) {
    if (seen.has(slot)) return { error: `${slot} is bound in a cycle` };
    seen.add(slot);
    const source = referencedSchema(found.bound, slots, defs, seen);
    if ("error" in source) return { defs };
    resolved = source;
  }
  for (const field of fields) {
    resolved = lookupField(resolved.schema, field, resolved.defs);
    if (resolved.schema !== undefined) continue;
    if (resolved.declares)
      return { error: `${field} is not a field of ${slot}` };
    break; // unconstrained: deeper fields cannot be checked
  }
  return resolved;
}

function stepReferences(step: Step, index: number): Ref[] {
  const refs: Ref[] = [];
  for (const [name, input] of Object.entries(step.inputs ?? {}))
    if (typeof input === "string")
      refs.push({
        path: input,
        at: ["steps", index, "inputs", name],
        gates: step.id,
      });
  const when = parseWhen(step.when ?? "").path;
  if (when)
    refs.push({ path: when, at: ["steps", index, "when"], gates: step.id });
  for (const [name, output] of Object.entries(step.outputs ?? {}))
    for (const [field, path] of Object.entries(
      ("match" in output && output.match) || {},
    ))
      refs.push({
        path,
        at: ["steps", index, "outputs", name, "match", field],
      });
  return refs;
}

function references(wf: Definition): Ref[] {
  const refs = wf.steps.flatMap(stepReferences);
  if (wf.display) {
    refs.push({ path: wf.display.result, at: ["display", "result"] });
    if (wf.display.title) refs.push({ path: wf.display.title, at: ["display", "title"] });
  }
  for (const [name, value] of Object.entries(wf.outputs ?? {}))
    if (typeof value === "string")
      refs.push({ path: value, at: ["outputs", name] });
    else
      for (const [field, path] of Object.entries(value))
        refs.push({ path, at: ["outputs", name, field] });
  return refs;
}

function findCycle(steps: string[], edges: Map<string, Set<string>>) {
  const state = new Map<string, "open" | "closed">();
  const trail: string[] = [];
  const visit = (step: string): string[] | undefined => {
    if (state.get(step) === "closed") return;
    if (state.get(step) === "open")
      return [...trail.slice(trail.indexOf(step)), step];
    state.set(step, "open");
    trail.push(step);
    for (const next of edges.get(step) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    trail.pop();
    state.set(step, "closed");
  };
  for (const step of steps) {
    const cycle = visit(step);
    if (cycle) return cycle;
  }
}

function eventSourceInputsValid(step: Step) {
  const event = step.inputs?.event;
  return Object.values(step.inputs ?? {}).every((input) => typeof input === "object") &&
    typeof event === "object" &&
    !Object.hasOwn(event, "default");
}

function eventSourceOutputValid(step: Step) {
  const started = step.outputs?.started;
  return Object.keys(step.outputs ?? {}).length === 1 &&
    Boolean(started && "schema" in started && started.schema?.type === "object" && !("connector" in started));
}

function eventSourceValid(step: Step) {
  return !step.actor && !step.instructions && !step.form && !step.uses?.length && !step.when &&
    eventSourceInputsValid(step) && eventSourceOutputValid(step);
}

/** Exactly one kind: event source, actor step, or connector-observed step. */
function stepKindIssues(
  step: Step,
  at: (string | number)[],
  actors: Definition["actors"],
): Issue[] {
  const outputs = Object.values(step.outputs ?? {});
  if (step.source === "event") {
    return eventSourceValid(step)
      ? []
      : [{ path: at, message: "an event source needs unbound inputs.event and server-written object outputs.started, without an actor or connector" }];
  }
  if (!step.actor)
    return step.instructions ||
      step.form ||
      !outputs.length ||
      outputs.some((output) => !("connector" in output))
      ? [
          {
            path: at,
            message: "a step without an actor must have only connector outputs",
          },
        ]
      : [];
  const actor = actors[step.actor];
  if (!actor)
    return [
      { path: [...at, "actor"], message: `actor ${step.actor} does not exist` },
    ];
  if (Boolean(step.instructions) === Boolean(step.form))
    return [
      {
        path: at,
        message:
          "a step with an actor must have exactly one of instructions or form",
      },
    ];
  if (step.form)
    return actor.kind === "human"
      ? []
      : [
          {
            path: [...at, "form"],
            message: `${actor.kind} actor ${step.actor} cannot fill a form`,
          },
        ];
  if (actor.kind === "human")
    return [
      {
        path: [...at, "instructions"],
        message: `human actor ${step.actor} needs a form, not instructions`,
      },
    ];
  return outputs.length
    ? []
    : [
        {
          path: [...at, "outputs"],
          message: "an agent step must declare its outputs",
        },
      ];
}

function checkStepKinds(wf: Definition, issues: Issue[]) {
  const ids = new Set<string>();
  wf.steps.forEach((step, index) => {
    const at = ["steps", index];
    if (ids.has(step.id))
      issues.push({
        path: [...at, "id"],
        message: `duplicate step ${step.id}`,
      });
    ids.add(step.id);
    if (step.form && step.outputs?.response)
      issues.push({
        path: [...at, "outputs", "response"],
        message: "form already defines outputs.response",
      });
    issues.push(...stepKindIssues(step, at, wf.actors));
    if (step.inference && (step.actor || step.source))
      issues.push({
        path: [...at, "inference"],
        message: "inference settings are for a step the app fills, without an actor or source",
      });
  });
}

/** Every declared slot schema with its location and, for inputs, its default. */
function declaredSchemas(
  step: Step,
  index: number,
): {
  schema?: Record<string, unknown>;
  at: (string | number)[];
  default?: unknown;
}[] {
  const at = ["steps", index];
  return [
    ...Object.entries(step.inputs ?? {}).flatMap(([name, input]) =>
      typeof input === "string"
        ? []
        : [
            {
              schema: input.schema,
              at: [...at, "inputs", name],
              default: input.default,
            },
          ],
    ),
    ...Object.entries(step.outputs ?? {}).map(([name, output]) => ({
      schema: output.schema,
      at: [...at, "outputs", name],
    })),
    { schema: step.form?.schema, at: [...at, "form"] },
  ];
}

function checkSlotSchemas(wf: Definition, issues: Issue[]) {
  for (const slot of wf.steps.flatMap(declaredSchemas)) {
    if (!slot.schema) continue;
    let shape: z.ZodType;
    try {
      shape = compileSlotSchema(slot.schema, wf.$defs);
    } catch (error) {
      issues.push({
        path: [...slot.at, "schema"],
        message: `schema does not compile: ${(error as Error).message}`,
      });
      continue;
    }
    const result =
      slot.default === undefined ? undefined : shape.safeParse(slot.default);
    if (result && !result.success)
      issues.push({
        path: [...slot.at, "default"],
        message: z.prettifyError(result.error),
      });
  }
}

/** The run input that names the principal filling a human role: the input named after it. */
export function principalInput(wf: Definition, actor: string) {
  for (const step of wf.steps) {
    const input = step.inputs?.[actor];
    if (input && typeof input !== "string") return `${step.id}.inputs.${actor}`;
  }
}

/** A principal schema is an object requiring `kind` (member or team) and `id`. */
function principalShaped(schema: unknown, defs: Definition["$defs"]): boolean {
  const node = schema as Record<string, unknown> | undefined;
  const name =
    typeof node?.$ref === "string"
      ? /^#\/\$defs\/(.+)$/.exec(node.$ref)?.[1]
      : undefined;
  if (name) return principalShaped(defs?.[name], defs);
  const required = node?.required;
  const properties = node?.properties as Record<string, unknown> | undefined;
  return (
    Array.isArray(required) &&
    required.includes("kind") &&
    required.includes("id") &&
    Boolean(properties?.kind && properties?.id)
  );
}

function checkHumanRoles(wf: Definition, issues: Issue[]) {
  for (const [name, actor] of Object.entries(wf.actors)) {
    if (actor.kind !== "human") continue;
    const input = principalInput(wf, name);
    const [step, , slot] = input?.split(".") ?? [];
    const schema = input
      ? (
          wf.steps.find((item) => item.id === step)?.inputs?.[slot] as
            { schema?: unknown } | undefined
        )?.schema
      : undefined;
    if (!input)
      issues.push({
        path: ["actors", name],
        message: `human role ${name} needs a run input named ${name} for the principal who fills it`,
      });
    else if (!principalShaped(schema, wf.$defs))
      issues.push({
        path: ["actors", name],
        message: `${input} must be a principal: an object requiring kind and id`,
      });
  }
}

/** Executor references name opaque approved bindings, never a transport or credential. */
function checkExecutorBindings(wf: Definition, issues: Issue[]) {
  const slots = slotIndex(wf);
  for (const [name, actor] of Object.entries(wf.actors)) {
    if (!("binding" in actor) || !actor.binding) continue;
    const parsed = split(actor.binding);
    const slot = slots.get(parsed.slot);
    const input = wf.steps.find(step => step.id === parsed.step)?.inputs?.[parsed.slot.split(".")[2]];
    if ((typeof input === "object" && Object.hasOwn(input, "default")) || parsed.fields.length || !parsed.slot.includes(".inputs.") || !slot || slot.bound || slot.schema?.type !== "string")
      issues.push({ path: ["actors", name, "binding"], message: "binding must reference a direct string run input" });
  }
}

/** `display.finish` names a step a human fills. */
function checkDisplay(wf: Definition, issues: Issue[]) {
  const finish = wf.display?.finish;
  if (!finish) return;
  const step = wf.steps.find((item) => item.id === finish);
  if (!step?.actor || wf.actors[step.actor]?.kind !== "human")
    issues.push({ path: ["display", "finish"], message: "display.finish must name a step a human actor fills" });
}

function workflowIssues(wf: Definition): Issue[] {
  const issues: Issue[] = [];
  checkStepKinds(wf, issues);
  checkDisplay(wf, issues);
  checkHumanRoles(wf, issues);
  checkExecutorBindings(wf, issues);
  checkSlotSchemas(wf, issues);
  const slots = slotIndex(wf);
  const edges = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  for (const ref of references(wf)) {
    const resolved = referencedSchema(ref.path, slots, wf.$defs);
    if ("error" in resolved)
      issues.push({ path: ref.at, message: resolved.error });
    // `match` references accept an output; they never gate a step's start.
    const to = ref.gates;
    if (!to) continue;
    const { step: from, slot } = split(ref.path);
    // A step may read its own inputs, e.g. in `when`; that is not an edge.
    if (!slots.has(slot) || (from === to && slot.includes(".inputs.")))
      continue;
    edges.set(from, (edges.get(from) ?? new Set()).add(to));
    incoming.add(to);
  }
  const cycle = findCycle(
    wf.steps.map((step) => step.id),
    edges,
  );
  if (cycle)
    issues.push({ path: ["steps"], message: `cycle: ${cycle.join(" → ")}` });
  wf.steps.forEach((step, index) => {
    if (!incoming.has(step.id)) return;
    for (const [name, input] of Object.entries(step.inputs ?? {}))
      if (typeof input !== "string")
        issues.push({
          path: ["steps", index, "inputs", name],
          message: "unbound input on a non-entry step",
        });
  });
  return issues;
}

/**
 * How a run page presents a run, read by any run page and never by the engine:
 * the primary output it leads with, the value it is titled with, and the human
 * step that finishes the run once its result is used.
 */
const Display = z
  .object({
    /** The run's primary output, shown first. */
    result: Reference,
    /** A string reference (usually a run input field) the run page is titled with. */
    title: Reference.optional(),
    /** A human step that completes the run once its member has used the result. */
    finish: slug.optional(),
  })
  .strict();

export const Workflow = z
  .object({
    version: z.literal("beta"),
    id: slug,
    summary: z.string().min(1).max(500),
    /** Opt in to generic app task dispatch using existing workflow slots. */
    task: z.object({ schema: JsonSchema, input: z.string().regex(/^[a-z][a-z0-9-]*\.inputs\.[A-Za-z][A-Za-z0-9]*$/), output: z.string().regex(/^[a-z][a-z0-9-]*\.outputs\.[A-Za-z][A-Za-z0-9]*$/) }).strict().optional(),
    /** Provenance only; a fork is a copy. */
    forkedFrom: slug.nullable().optional(),
    actors: z.record(slotName, Actor),
    triggers: z.array(Trigger).optional(),
    steps: z.array(Step).min(1),
    outputs: z
      .record(slotName, z.union([Reference, z.record(slotName, Reference)]))
      .optional(),
    display: Display.optional(),
    /**
     * `owner`: its runs and schedules are visible to the member who started
     * them only, even on an organization host where runs are otherwise shared.
     */
    visibility: z.literal("owner").optional(),
    $defs: z.record(z.string(), JsonSchema).optional(),
  })
  .strict()
  .superRefine((wf, ctx) => {
    if (wf.task) {
      const input = slotIndex(wf).get(wf.task.input);
      const output = slotIndex(wf).get(wf.task.output);
      if (!input || input.bound || !input.schema || !output || !output.schema || output.bound)
        ctx.addIssue({ code: "custom", path: ["task"], message: "Task input/output must name unbound schema slots" });
      const step = wf.steps.find(item => wf.task?.output.startsWith(`${item.id}.outputs.`));
      if (step?.actor || !step?.outputs || !("connector" in (step.outputs[wf.task.output.split(".")[2]] ?? {})))
        ctx.addIssue({ code: "custom", path: ["task"], message: "Task output must be an app-collected connector output" });
    }
    const eventTypes = new Set<string>();
    const eventSources = new Set(wf.steps.filter((step) => step.source === "event").map((step) => step.id));
    const mappedSources = new Set<string>();
    wf.triggers?.forEach((trigger, index) => {
      if (trigger.on !== "event") return;
      const slot = slotIndex(wf).get(trigger.input);
      if (!trigger.input.includes(".inputs.") || !slot || !("schema" in slot))
        ctx.addIssue({ code: "custom", path: ["triggers", index, "input"], message: "Event payload must fill an unbound run input" });
      if (eventTypes.has(trigger.type))
        ctx.addIssue({ code: "custom", path: ["triggers", index, "type"], message: "An event type has one input mapping" });
      eventTypes.add(trigger.type);
      const sourceId = trigger.input.split(".")[0];
      if (eventSources.has(sourceId)) {
        if (trigger.input !== `${sourceId}.inputs.event`)
          ctx.addIssue({ code: "custom", path: ["triggers", index, "input"], message: "Event source trigger must map to inputs.event" });
        mappedSources.add(sourceId);
      }
    });
    for (const sourceId of eventSources)
      if (!mappedSources.has(sourceId))
        ctx.addIssue({ code: "custom", path: ["steps", wf.steps.findIndex((step) => step.id === sourceId), "source"], message: "Event source needs an event trigger mapped to inputs.event" });
    for (const issue of workflowIssues(wf))
      ctx.addIssue({ code: "custom", ...issue });
  });
export type Workflow = z.infer<typeof Workflow>;

/** Derived; `schemas/workflow.schema.json` is this value. */
export const workflowJsonSchema = () => z.toJSONSchema(Workflow);

/**
 * Inlines `schema: <relative path>` file references in a raw definition, the
 * stored form. `read` resolves a path relative to the definition's directory.
 */
export function inlineSchemaFiles(
  raw: unknown,
  read: (path: string) => Record<string, unknown>,
) {
  // Raw YAML: shapes are checked by Workflow.parse afterwards.
  const definition = structuredClone(raw);
  const inline = (slot: unknown) => {
    if (isObject(slot) && typeof slot.schema === "string")
      slot.schema = read(slot.schema);
  };
  const steps = isObject(definition) ? definition.steps : undefined;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!isObject(step)) continue;
    for (const slot of [
      ...Object.values(isObject(step.inputs) ? step.inputs : {}),
      ...Object.values(isObject(step.outputs) ? step.outputs : {}),
      step.form,
    ])
      inline(slot);
  }
  return definition;
}
