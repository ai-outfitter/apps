import type { FieldOptions } from "@ai-outfitter/app-sdk/agent-context";
import type { FieldSchema } from "@ai-outfitter/app-sdk/agent-schema";
import { useId } from "react";

const labelFor = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
type FieldProps = {
  options?: FieldOptions[string];
  id: string;
  schema: FieldSchema;
  value: unknown;
  disabled: boolean;
  change: (next: unknown) => void;
};
function JSONField({ id, value, disabled, change }: FieldProps) {
  return (
    <textarea
      id={id}
      disabled={disabled}
      value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      onChange={(e) => {
        try {
          change(JSON.parse(e.target.value));
        } catch {
          change(e.target.value);
        }
      }}
    />
  );
}
function RelationshipField({
  id,
  value,
  disabled,
  change,
  options,
}: FieldProps & { options: FieldOptions[string] }) {
  const attributes = { id, disabled };
  return (
    <select
      {...attributes}
      value={String(value ?? "")}
      onChange={(e) =>
        change(
          options.find((o) => String(o.value ?? "") === e.target.value)
            ?.value ?? null,
        )
      }
    >
      {value != null && !options.some((option) => option.value === value) ? (
        <option value={String(value)}>Existing selection (unavailable)</option>
      ) : null}
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value ?? "")}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
function FieldControl(props: FieldProps) {
  const { id, schema, value, disabled, change, options } = props,
    choices = schema.anyOf ?? [schema];
  const isNull = (choice: FieldSchema) =>
    choice.type === "null" ||
    (Array.isArray(choice.type) && choice.type.includes("null"));
  const field = choices.find((choice) => !isNull(choice)) ?? schema,
    fieldType = Array.isArray(field.type)
      ? field.type.find((type) => type !== "null")
      : field.type,
    nullable = choices.some(isNull) || isNull(schema);
  const editText = (text: string) =>
    change(nullable && text === "" ? null : text);
  const attributes = { id, disabled: disabled || Boolean(field.readOnly) };
  if (options)
    return (
      <RelationshipField
        {...props}
        options={options}
        disabled={attributes.disabled}
      />
    );
  if (field.enum)
    return (
      <select
        {...attributes}
        value={String(value ?? "")}
        onChange={(e) => editText(e.target.value)}
      >
        {nullable ? <option value="">None</option> : null}
        {field.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  if (fieldType === "boolean")
    return (
      <input
        {...attributes}
        type="checkbox"
        checked={value === true}
        onChange={(e) => change(e.target.checked)}
      />
    );
  if (["integer", "number"].includes(String(fieldType)))
    return (
      <input
        {...attributes}
        type="number"
        value={String(value ?? "")}
        onChange={(e) =>
          change(
            nullable && e.target.value === "" ? null : Number(e.target.value),
          )
        }
      />
    );
  if (["object", "array"].includes(String(fieldType)))
    return <JSONField {...props} />;
  return (
    <textarea
      {...attributes}
      maxLength={field.maxLength}
      value={String(value ?? "")}
      onChange={(e) => editText(e.target.value)}
    />
  );
}
/** Schema describes fields; the app server owns authorization and validation. */
export default function SchemaFields({
  schema,
  value,
  onChange,
  disabled = false,
  options = {},
}: {
  schema: FieldSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  options?: FieldOptions;
}) {
  const prefix = useId(),
    properties = schema.properties ?? {},
    missing = Object.keys(properties).filter((key) => !(key in value));
  return (
    <div className="agent-fields">
      {Object.entries(properties)
        .filter(([key]) => key in value)
        .map(([name, definition]) => (
          <div key={name}>
            <label htmlFor={`${prefix}-${name}`}>
              {definition.title ?? labelFor(name)}
            </label>
            <FieldControl
              id={`${prefix}-${name}`}
              schema={definition}
              options={options[name]}
              value={value[name]}
              disabled={disabled}
              change={(next) => onChange({ ...value, [name]: next })}
            />
            {definition.description ? (
              <small>{definition.description}</small>
            ) : null}
            {!disabled && !schema.required?.includes(name) ? (
              <button
                type="button"
                className="ui-button ui-button--ghost"
                onClick={() => {
                  const next = { ...value };
                  delete next[name];
                  onChange(next);
                }}
              >
                Omit {labelFor(name)}
              </button>
            ) : null}
          </div>
        ))}
      {!disabled && missing.length > 0 ? (
        <label>
          Add a field
          <select
            value=""
            onChange={(e) => {
              const key = e.target.value,
                field = properties[key];
              if (field) {
                const choices = field.anyOf ?? [field],
                  isNull = (choice: FieldSchema) =>
                    choice.type === "null" ||
                    (Array.isArray(choice.type) &&
                      choice.type.includes("null")),
                  nonNull = choices.find((choice) => !isNull(choice)),
                  initial = Object.hasOwn(field, "default")
                    ? field.default
                    : choices.some(isNull)
                      ? null
                      : nonNull?.enum?.[0] ?? "";
                onChange({
                  ...value,
                  [key]: initial,
                });
              }
            }}
          >
            <option value="">Choose field</option>
            {missing.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
