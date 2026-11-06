/** Describe only the selected output, never the entire composed graph. */
import { getNamedType, isEnumType, isListType, isNonNullType, isObjectType, type GraphQLSchema, type GraphQLOutputType, type OperationDefinitionNode, type SelectionSetNode, Kind } from "graphql";

export function documentOutputSchema(schema: GraphQLSchema, operation: OperationDefinitionNode): Record<string, unknown> {
  const root = operation.operation === "mutation" ? schema.getMutationType() : schema.getQueryType();
  return root ? selectedType(root, operation.selectionSet) : {};
}
function selectedType(type: GraphQLOutputType, selection?: SelectionSetNode): Record<string, unknown> {
  if (isNonNullType(type)) return selectedType(type.ofType, selection);
  if (isListType(type)) return {type:"array",items:selectedType(type.ofType,selection)};
  const named = getNamedType(type);
  if (isEnumType(named)) return {type:"string",enum:named.getValues().map(value=>value.name)};
  if (!isObjectType(named)) return scalarSchema(named.name);
  const properties: Record<string, unknown> = {};
  for (const field of selection?.selections ?? []) {
    if (field.kind !== Kind.FIELD) continue;
    const definition = named.getFields()[field.name.value];
    if (definition) properties[field.alias?.value ?? field.name.value] = {...selectedType(definition.type,field.selectionSet),...(!isNonNullType(definition.type) ? {nullable:true} : {})};
  }
  return {type:"object",properties};
}

function scalarSchema(name: string) {
  const type = ({Int:"integer",Float:"number",Boolean:"boolean",ID:"string",String:"string"} as Record<string,string>)[name];
  return type ? {type} : {description:name};
}
