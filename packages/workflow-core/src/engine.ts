import { z } from "zod";
import {
  compileSlotSchema,
  parseWhen,
  Reference,
  slotIndex,
  slug,
  split,
  type Workflow,
} from "./schema";

// Readiness over a run's rows (#106). One function derives every step's status
// from the run inputs and output rows; live runs and fixtures use it alike.

const STEP_STATUSES = [
  "waiting",
  "ready",
  "running",
  "done",
  "failed",
  "blocked",
  "not-applicable",
] as const;
const RUN_STATUSES = ["running", "complete", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

/** An output row. Complete rows are immutable and validate against their slot. */
type SlotRow = { value: unknown; complete: boolean };
/** Run inputs by `<step>.inputs.<slot>`; output rows by `<step>.outputs.<slot>`. */
export type RunState = {
  inputs: Record<string, unknown>;
  rows: Record<string, SlotRow>;
};
type Step = Workflow["steps"][number];
type EventTrigger = Extract<NonNullable<Workflow["triggers"]>[number], { on: "event" }>;

/** Filter a verified event by provider-neutral payload fields before starting a run. */
export function eventTriggerMatches(trigger: EventTrigger, payload: unknown) {
  return Object.entries(trigger.match ?? {}).every(([path, expected]) => {
    let value: unknown = payload;
    for (const field of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, field)) return false;
      value = (value as Record<string, unknown>)[field];
    }
    return value === expected;
  });
}

/** Exact structural equality, for `match` and `when`. */
function equal(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) =>
        equal(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return a === b;
}

function fieldAt(value: unknown, fields: string[]) {
  for (const field of fields)
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[field]
        : undefined;
  return value;
}

/** Every `match` field path in a record equals its referenced value; absent never matches. */
function recordMatches(
  match: Record<string, string> | undefined,
  record: unknown,
  valueAt: (path: string) => unknown,
) {
  return Object.entries(match ?? {}).every(([field, ref]) => {
    const actual = fieldAt(record, field.split("."));
    return actual !== undefined && equal(actual, valueAt(ref));
  });
}

/** A slot's own value: a run input or its default, or a complete output row. */
function storedValue(wf: Workflow, state: RunState, slot: string) {
  if (slot.includes(".inputs."))
    return slot in state.inputs ? state.inputs[slot] : defaultFor(wf, slot);
  return state.rows[slot]?.complete ? state.rows[slot].value : undefined;
}

/** Resolves a reference against run inputs and complete rows; bound inputs follow their source. */
function resolver(wf: Workflow, state: RunState) {
  const slots = slotIndex(wf);
  const valueAt = (path: string, seen = new Set<string>()): unknown => {
    const { slot, fields } = split(path);
    const bound = slots.get(slot)?.bound;
    return fieldAt(
      bound && !seen.has(slot)
        ? valueAt(bound, seen.add(slot))
        : storedValue(wf, state, slot),
      fields,
    );
  };
  return valueAt;
}

/** A reference's value in a run: a run input or its default, or a complete output row; bound inputs follow their source. */
export function valueAt(wf: Workflow, state: RunState, reference: string) {
  return resolver(wf, state)(reference);
}

function defaultFor(wf: Workflow, slot: string) {
  const { step, fields } = split(slot);
  const input = wf.steps.find((item) => item.id === step)?.inputs?.[
    slot.split(".")[2]
  ];
  return fields.length || typeof input !== "object" ? undefined : input.default;
}

const empty = (value: unknown) =>
  value === null ||
  value === "" ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === "object" && value !== null && !Object.keys(value).length);

function literal(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One comparison on one path; an absent value makes it false. */
export function whenHolds(when: string, valueAt: (path: string) => unknown) {
  const { path, op, literal: text } = parseWhen(when);
  const value = valueAt(path);
  if (value === undefined) return false;
  if (op === "empty") return empty(value);
  if (op === "nonEmpty") return !empty(value);
  const same = equal(value, literal(text));
  return op === "==" ? same : !same;
}

/** Steps whose slots this step reads before it can start; its own inputs excluded. */
function sources(step: Step) {
  const paths = [
    ...Object.values(step.inputs ?? {}).filter(
      (input) => typeof input === "string",
    ),
    ...(step.when ? [parseWhen(step.when).path] : []),
  ];
  return new Set(
    paths.map((path) => split(path).step).filter((id) => id !== step.id),
  );
}

/** Every declared output of a step: `form` is `outputs.response`. */
export function stepOutputs(step: Step) {
  return {
    ...step.outputs,
    ...(step.form ? { response: { schema: step.form.schema } } : {}),
  } as Record<
    string,
    { schema?: Record<string, unknown>; match?: Record<string, string> }
  >;
}

/** A step's unbound run inputs that are neither supplied nor defaulted. */
function missingInputs(inputs: RunState["inputs"], step: Step) {
  return Object.entries(step.inputs ?? {}).flatMap(([name, input]) => {
    const slot = `${step.id}.inputs.${name}`;
    return typeof input !== "string" &&
      !(slot in inputs) &&
      input.default === undefined
      ? [slot]
      : [];
  });
}

/** Every run input a workflow needs before it can finish. */
export function missingRunInputs(wf: Workflow, inputs: RunState["inputs"]) {
  return wf.steps.flatMap((step) => missingInputs(inputs, step));
}

/** A step's inputs by name, resolved from run inputs and complete rows. */
export function inputValues(wf: Workflow, state: RunState, step: Step) {
  const valueAt = resolver(wf, state);
  return Object.fromEntries(
    Object.keys(step.inputs ?? {}).map((name) => [
      name,
      valueAt(`${step.id}.inputs.${name}`),
    ]),
  );
}

/** Whether a record satisfies its output's `match` against the run's current values. */
export function outputMatches(
  wf: Workflow,
  state: RunState,
  slot: string,
  record: unknown,
) {
  const step = wf.steps.find((item) => item.id === slot.split(".")[0]);
  const output = step && stepOutputs(step)[slot.split(".")[2]];
  return recordMatches(output?.match, record, resolver(wf, state));
}

function ownStatus(
  step: Step,
  state: RunState,
  valueAt: (path: string) => unknown,
): StepStatus {
  const outputs = Object.entries(stepOutputs(step));
  const rows = outputs.map(([name, output]) => ({
    row: state.rows[`${step.id}.outputs.${name}`],
    match: output.match,
  }));
  if (rows.every(({ row }) => !row)) return "ready";
  if (rows.some(({ row }) => row && !row.complete)) return "running";
  // A record that does not match its subject proves nothing; the step waits for one that does.
  const unmatched = rows.some(
    ({ row, match }) => row && !recordMatches(match, row.value, valueAt),
  );
  if (unmatched) return "waiting";
  return rows.every(({ row }) => row) ? "done" : "running";
}

/**
 * Derives each step's status from the run state. A step is not-applicable when its
 * `when` is false or a step it reads is; waiting until what it reads is done and
 * its run inputs exist; then ready, running, waiting on a matching record, or done.
 * The run is complete when every step is done or not-applicable.
 */
export function readiness(wf: Workflow, state: RunState) {
  const valueAt = resolver(wf, state);
  const byId = new Map(wf.steps.map((step) => [step.id, step]));
  const steps: Record<string, StepStatus> = {};
  const status = (id: string): StepStatus => {
    if (steps[id]) return steps[id];
    const step = byId.get(id) as Step;
    const upstream = [...sources(step)].map(status);
    let result: StepStatus;
    if (upstream.includes("not-applicable")) result = "not-applicable";
    else if (upstream.some((item) => item !== "done")) result = "waiting";
    else if (step.when && !whenHolds(step.when, valueAt))
      result = "not-applicable";
    else if (missingInputs(state.inputs, step).length) result = "waiting";
    else result = ownStatus(step, state, valueAt);
    steps[id] = result;
    return result;
  };
  for (const step of wf.steps) status(step.id);
  const all = Object.values(steps);
  const run: RunStatus = all.includes("failed")
    ? "failed"
    : all.every((item) => item === "done" || item === "not-applicable")
      ? "complete"
      : "running";
  return { steps, run };
}

type Issue = { path: (string | number)[]; message: string };

/** Validates a value for an input or output slot against its compiled schema. */
export function slotIssue(wf: Workflow, path: string, value: unknown) {
  const slot = slotIndex(wf).get(path);
  const result = slot?.schema
    ? compileSlotSchema(slot.schema, wf.$defs).safeParse(value)
    : undefined;
  return result && !result.success ? z.prettifyError(result.error) : undefined;
}

/** Whether a key names a run input, an output slot, or neither. */
export function slotKind(wf: Workflow, path: string) {
  const slot = slotIndex(wf).get(path);
  if (!slot || slot.bound) return undefined;
  return path.includes(".inputs.") ? "inputs" : "outputs";
}

const Fixture = z
  .object({
    workflow: slug,
    /** `derived` is sanitized from a real run; it is never live evidence. */
    origin: z.enum(["synthetic", "derived"]),
    inputs: z.record(Reference, z.unknown()),
    records: z.record(Reference, z.unknown()),
    /** Rows saved with `complete: false`; they need not validate yet. */
    incomplete: z.record(Reference, z.unknown()).optional(),
    expect: z.record(z.string(), z.enum([...STEP_STATUSES, ...RUN_STATUSES])),
  })
  .strict();
export type Fixture = z.infer<typeof Fixture>;

function fixtureIssues(fixture: Fixture, wf: Workflow): Issue[] {
  const fill = (section: "inputs" | "records", io: "inputs" | "outputs") =>
    Object.entries(fixture[section]).flatMap(([path, value]) => {
      if (slotKind(wf, path) !== io)
        return [
          {
            path: [section, path],
            message: `${path} is not ${io === "inputs" ? "a run input" : "an output slot"}`,
          },
        ];
      const issue = slotIssue(wf, path, value);
      return issue ? [{ path: [section, path], message: issue }] : [];
    });
  const steps = new Set(wf.steps.map((step) => step.id));
  return [
    ...(fixture.workflow === wf.id
      ? []
      : [
          {
            path: ["workflow"],
            message: `fixture is for ${fixture.workflow}, not ${wf.id}`,
          },
        ]),
    ...fill("inputs", "inputs"),
    ...fill("records", "outputs"),
    ...Object.keys(fixture.incomplete ?? {})
      .filter(
        (path) => slotKind(wf, path) !== "outputs" || path in fixture.records,
      )
      .map((path) => ({
        path: ["incomplete", path],
        message: `${path} is not an unfilled output slot`,
      })),
    ...Object.entries(fixture.expect)
      .filter(([key, status]) =>
        key === "run"
          ? !(RUN_STATUSES as readonly string[]).includes(status)
          : !steps.has(key) ||
            !(STEP_STATUSES as readonly string[]).includes(status),
      )
      .map(([key, status]) => ({
        path: ["expect", key],
        message: `${key}: ${status} is not a valid expectation`,
      })),
  ];
}

/**
 * A fixture is a run: inputs and records validate against their slots, then the
 * production readiness derives statuses and `expect` is asserted against them,
 * never injected as state.
 */
export function loadFixture(raw: unknown, wf: Workflow) {
  const fixture = Fixture.parse(raw);
  const issues = fixtureIssues(fixture, wf);
  const state: RunState = {
    inputs: fixture.inputs,
    rows: {
      ...Object.fromEntries(
        Object.entries(fixture.records).map(([path, value]) => [
          path,
          { value, complete: true },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(fixture.incomplete ?? {}).map(([path, value]) => [
          path,
          { value, complete: false },
        ]),
      ),
    },
  };
  const derived = readiness(wf, state);
  for (const [key, expected] of Object.entries(fixture.expect)) {
    const actual = key === "run" ? derived.run : derived.steps[key];
    if (actual !== expected)
      issues.push({
        path: ["expect", key],
        message: `expected ${expected}, derived ${actual}`,
      });
  }
  if (issues.length)
    throw new z.ZodError(
      issues.map((issue) => ({ code: "custom", input: raw, ...issue })),
    );
  return { fixture, state, readiness: derived };
}
