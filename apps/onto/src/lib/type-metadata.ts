import type { TypeDefinition } from "./graph";

type Fields = TypeDefinition["properties"];
type JsonSchema = NonNullable<TypeDefinition["jsonSchema"]>;
type Ontology = NonNullable<TypeDefinition["ontology"]>;
export type StoredTypeMetadata =
  Fields | { fields: Fields; jsonSchema?: JsonSchema; ontology?: Ontology };

// Keep legacy field arrays readable. Optional document metadata fits in the
// existing JSON column, while the public type contract stays flat.
export function storeType<
  T extends {
    properties: Fields;
    jsonSchema?: JsonSchema;
    ontology?: Ontology;
  },
>(type: T) {
  const { jsonSchema, ontology, ...rest } = type;
  const properties: StoredTypeMetadata =
    jsonSchema || ontology
      ? {
          fields: type.properties,
          ...(jsonSchema && { jsonSchema }),
          ...(ontology && { ontology }),
        }
      : type.properties;
  return { ...rest, properties };
}
export function readType<T extends { properties: StoredTypeMetadata }>(
  type: T,
) {
  const { properties, ...rest } = type;
  return Array.isArray(properties)
    ? { ...rest, properties }
    : {
        ...rest,
        properties: properties.fields,
        ...(properties.jsonSchema !== undefined && {
          jsonSchema: properties.jsonSchema,
        }),
        ...(properties.ontology !== undefined && {
          ontology: properties.ontology,
        }),
      };
}
