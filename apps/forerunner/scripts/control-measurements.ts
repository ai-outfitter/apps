import definitions from "../seeds/control-measurements-v1.json" with { type: "json" };

export type ControlMeasurement =
  typeof definitions.response | typeof definitions.quarterly;
type Operand = {
  input?: string;
  step?: string;
  value?: string | number | boolean | null;
};
type Step = { name: string; operator: string; arguments: Operand[] };
type ValueType = "number" | "string" | "boolean" | "null";
type Value = { sql: string; type: ValueType };
const identifier = /^[a-z][a-z0-9_]*$/;

function literal(value: Operand["value"]): Value {
  if (value === undefined) throw Error("Missing operand");
  if (value === null) return { sql: "NULL", type: "null" };
  if (typeof value === "string")
    return { sql: `'${value.replaceAll("'", "''")}'`, type: "string" };
  if (typeof value === "boolean")
    return { sql: value ? "1" : "0", type: "boolean" };
  return { sql: String(value), type: "number" };
}
function operand(
  arg: Operand,
  inputs: Map<string, ValueType>,
  values: Map<string, Value>,
): Value {
  if (arg.input !== undefined) {
    const type = inputs.get(arg.input);
    if (!type) throw Error(`Unknown input: ${arg.input}`);
    return { sql: arg.input, type };
  }
  if (arg.step !== undefined) {
    const value = values.get(arg.step);
    if (!value) throw Error(`Unknown or forward step: ${arg.step}`);
    return value;
  }
  return literal(arg.value);
}
function arity(args: Value[], n: number) {
  if (args.length !== n) throw Error(`Expected ${n} operands`);
}
function numeric(args: Value[]) {
  if (args.some((a) => a.type !== "number"))
    throw Error("Expected numeric operands");
}
function binary(args: Value[], operator: string, arithmetic: boolean): Value {
  arity(args, 2);
  if (arithmetic) numeric(args);
  else if (args[0].type !== args[1].type)
    throw Error("Incompatible comparison");
  return {
    type: arithmetic ? "number" : "boolean",
    sql: `(${args[0].sql} ${operator} ${args[1].sql})`,
  };
}
function divide(args: Value[]): Value {
  arity(args, 2);
  numeric(args);
  return { type: "number", sql: `(1.0 * ${args[0].sql} / ${args[1].sql})` };
}
function booleanGroup(args: Value[], operator: string): Value {
  if (args.length < 2 || args.some((a) => a.type !== "boolean"))
    throw Error("Expected boolean operands");
  return {
    type: "boolean",
    sql: `(${args.map((a) => a.sql).join(` ${operator} `)})`,
  };
}
function nullCheck(args: Value[], not: boolean): Value {
  arity(args, 1);
  return {
    type: "boolean",
    sql: `(${args[0].sql} IS ${not ? "NOT " : ""}NULL)`,
  };
}
function cases(args: Value[]): Value {
  if (args.length < 3 || args.length % 2 !== 1) throw Error("Invalid case");
  const fallback = args[args.length - 1];
  const branches: string[] = [];
  for (let i = 0; i < args.length - 1; i += 2) {
    if (args[i].type !== "boolean" || args[i + 1].type !== fallback.type)
      throw Error("Incompatible case");
    branches.push(`  WHEN ${args[i].sql} THEN ${args[i + 1].sql}`);
  }
  return {
    type: fallback.type,
    sql: `CASE\n${branches.join("\n")}\n  ELSE ${fallback.sql}\nEND`,
  };
}
function countDistinct(args: Value[]): Value {
  arity(args, 2);
  if (args[1].type !== "boolean") throw Error("Count filter must be boolean");
  return {
    type: "number",
    sql: `COUNT(DISTINCT ${args[0].sql}) FILTER (WHERE ${args[1].sql})`,
  };
}
function sum(args: Value[]): Value {
  arity(args, 1);
  numeric(args);
  return { type: "number", sql: `SUM(${args[0].sql})` };
}
function nullIf(args: Value[]): Value {
  arity(args, 2);
  if (args[0].type !== args[1].type) throw Error("Incompatible null_if");
  return { type: args[0].type, sql: `NULLIF(${args[0].sql}, ${args[1].sql})` };
}
function identity(args: Value[]): Value {
  arity(args, 1);
  return args[0];
}
const operators: Record<string, (args: Value[]) => Value> = {
  identity,
  divide,
  case: cases,
  count_distinct: countDistinct,
  sum,
  null_if: nullIf,
  add: (args) => binary(args, "+", true),
  subtract: (args) => binary(args, "-", true),
  multiply: (args) => binary(args, "*", true),
  eq: (args) => binary(args, "=", false),
  lt: (args) => binary(args, "<", false),
  lte: (args) => binary(args, "<=", false),
  gte: (args) => binary(args, ">=", false),
  and: (args) => booleanGroup(args, "AND"),
  or: (args) => booleanGroup(args, "OR"),
  is_null: (args) => nullCheck(args, false),
  is_not_null: (args) => nullCheck(args, true),
};
function compileProgram(steps: Step[], inputs: Map<string, ValueType>) {
  const values = new Map<string, Value>();
  let last: Value | undefined;
  for (const step of steps) {
    if (!identifier.test(step.name) || values.has(step.name))
      throw Error(`Invalid or duplicate step: ${step.name}`);
    const operation = Object.hasOwn(operators, step.operator)
      ? operators[step.operator]
      : undefined;
    if (!operation) throw Error(`Unknown operator: ${step.operator}`);
    last = operation(step.arguments.map((arg) => operand(arg, inputs, values)));
    if (last.sql.length > 100_000)
      throw Error("Measurement expression is too large");
    values.set(step.name, last);
  }
  if (!last) throw Error("Empty measurement program");
  return last.sql;
}
/** Bounded operators only; no raw SQL or executable code in a body. This fixture
 * compiler is not a SemLang/Malloy exporter or a provider source adapter. */
export function compileMeasurement(spec: ControlMeasurement) {
  if (spec.version !== 1) throw Error("Unsupported measurement version");
  const inputs = new Map<string, ValueType>();
  for (const input of spec.inputs) {
    if (!identifier.test(input.name) || inputs.has(input.name))
      throw Error(`Invalid or duplicate input: ${input.name}`);
    inputs.set(
      input.name,
      input.data_type === "nullable_number"
        ? "number"
        : (input.data_type as ValueType),
    );
  }
  return {
    formula_language:
      "Generated SQL from structured measurement v1; definition only",
    measurement_formula: compileProgram(spec.programs.measurement, inputs),
    deadline_formula: compileProgram(spec.programs.deadline, inputs),
    formula: compileProgram(spec.programs.decision, inputs),
    source_requirements: spec.evidence_rules.join("\n"),
    ...("aggregation" in spec.programs
      ? {
          aggregation_formula: compileProgram(
            spec.programs.aggregation,
            inputs,
          ),
        }
      : {}),
    aggregation: spec.reporting,
  };
}
export const responseDefinition = definitions.response;
export const quarterlyDefinition = definitions.quarterly;
export const responseMeasurement = compileMeasurement(responseDefinition);
export const quarterlyMeasurement = compileMeasurement(quarterlyDefinition);
