import type { Assembly } from "../lib/assembly";
import type { Params } from "../lib/project";
import type { BuildRequest } from "../lib/workspace";

type Inputs = BuildRequest["parameters"];
type Bounds = { min: number[]; max: number[] };
function heading(parent: HTMLElement, text: string) {
  const h = document.createElement("h3");
  h.textContent = text;
  parent.append(h);
}
function valueField(parent: HTMLElement, name: string, initial: Inputs[string]) {
  const label = document.createElement("label"),
    input = document.createElement("input");
  label.textContent = name;
  input.type = typeof initial === "number" ? "number" : typeof initial === "boolean" ? "checkbox" : "text";
  if (input.type === "checkbox") input.checked = Boolean(initial);
  else {
    input.value = String(initial);
    if (input.type === "number") {
      input.step = "any";
      input.required = true;
    }
  }
  label.append(input);
  parent.append(label);
  return input;
}
export function modelSizing(
  host: HTMLElement,
  options: {
    bounds?: Bounds;
    preset?: Params;
    configurations?: Assembly["configurations"];
    configurationUrl: URL;
    inputs?: Inputs;
    requestBuild?: (values: Inputs) => void;
  },
) {
  host.replaceChildren();
  if (options.bounds) {
    heading(host, "Assembled dimensions");
    const dims = document.createElement("dl");
    ["Width (X)", "Depth (Y)", "Height (Z)"].forEach((axis, i) => {
      const label = document.createElement("dt"),
        value = document.createElement("dd");
      label.textContent = axis;
      value.textContent = Number((options.bounds!.max[i] - options.bounds!.min[i]).toFixed(2)) + " mm";
      dims.append(label, value);
    });
    host.append(dims);
  }
  if (options.preset && options.preset.design !== "custom" && options.preset.design !== "cube") {
    const p = document.createElement("p");
    p.textContent = "Wall thickness: " + options.preset.wall + " mm";
    host.append(p);
  }
  const configs = options.configurations;
  if (configs?.length) {
    const url = options.configurationUrl;
    const form = document.createElement("form"),
      label = document.createElement("label"),
      picker = document.createElement("select");
    label.textContent = "Configuration";
    label.append(picker);
    form.append(label);
    picker.add(new Option("Saved assembly", ""));
    for (const config of configs) picker.add(new Option(config.name, config.name));
    picker.value = url.searchParams.get("configuration") ?? "";
    const fields = document.createElement("div");
    form.append(fields);
    const inputs = new Map<string, HTMLInputElement>();
    function renderFields() {
      fields.replaceChildren();
      inputs.clear();
      const config = configs?.find((c) => c.name === picker.value);
      const current =
        picker.value === url.searchParams.get("configuration")
          ? JSON.parse(url.searchParams.get("parameters") ?? "{}")
          : {};
      for (const p of config?.parameters ?? []) {
        const input = valueField(fields, p.name, current[p.name] ?? p.defaultValue);
        input.min = String(p.min);
        input.max = String(p.max);
        inputs.set(p.name, input);
      }
    }
    picker.onchange = renderFields;
    renderFields();
    const submit = document.createElement("button");
    submit.textContent = "Preview configuration";
    form.append(submit);
    form.onsubmit = (e) => {
      e.preventDefault();
      url.searchParams.delete("item");
      url.searchParams.delete("parameters");
      if (picker.value) url.searchParams.set("configuration", picker.value);
      else url.searchParams.delete("configuration");
      if (inputs.size)
        url.searchParams.set(
          "parameters",
          JSON.stringify(Object.fromEntries(Array.from(inputs, ([k, input]) => [k, input.valueAsNumber]))),
        );
      location.assign(url);
    };
    host.append(form);
  }
  const entries = Object.entries(options.inputs ?? {});
  if (entries.length) {
    heading(host, "Build parameters");
    const form = document.createElement("form");
    const inputs = entries.map(([name, value]) => {
      const input = valueField(form, name, value);
      input.disabled = !options.requestBuild;
      return { name, input };
    });
    if (options.requestBuild) {
      const submit = document.createElement("button");
      submit.textContent = "Request build with parameters";
      form.append(submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        options.requestBuild!(
          Object.fromEntries(
            inputs.map(({ name, input }) => [
              name,
              input.type === "number"
                ? input.valueAsNumber
                : input.type === "checkbox"
                  ? input.checked
                  : input.value,
            ]),
          ),
        );
      };
    }
    host.append(form);
  }
  return Boolean(host.childElementCount);
}
