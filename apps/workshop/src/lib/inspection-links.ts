import type { Assembly } from "./assembly";

/** Read older inspection presets without changing saved geometry or historic revisions. */
export function inspectionLink(assembly: Assembly, query: URLSearchParams) {
  const configs = assembly.configurations ?? [];
  const name = query.get("configuration") ?? "";
  const preset = configs.find(c => c.name === name);
  const baseName = name.endsWith("-exploded") ? name.slice(0,-9) : name === "Exploded" ? "Assembled" : name;
  const base = configs.find(c => c.name === baseName);
  if (!base) return undefined;
  const legacyParameter = preset?.parameters?.find(p => p.name === "Explode" && p.min === 0 && p.max === 1);
  const legacyReference = assembly.items.find(item => item.id === preset?.rootId)?.reference?.configuration?.endsWith("-exploded");
  const alias = name !== baseName && (!preset || legacyParameter || legacyReference);
  if (!alias && !legacyParameter) return undefined;
  const params = new URLSearchParams(query);
  let values: Record<string,unknown>;
  try { values = JSON.parse(params.get("parameters") ?? "{}"); } catch { return undefined; }
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  const oldAmount = values.Explode;
  if (!alias && oldAmount === undefined) return undefined;
  if (oldAmount !== undefined && (typeof oldAmount !== "number" || oldAmount < 0 || oldAmount > 1)) return undefined;
  delete values.Explode;
  if (Object.keys(values).length) params.set("parameters",JSON.stringify(values)); else params.delete("parameters");
  params.set("configuration",base.name);
  if (!params.has("explode")) params.set("explode",String(Math.round(Number(oldAmount ?? 1)*100)));
  return params;
}
