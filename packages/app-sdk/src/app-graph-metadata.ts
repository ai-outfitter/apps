import { assertValidSchema,buildSchema } from "graphql";
import { z } from "zod";
import { documentRows, type AppDocument, type AppDocumentRow } from "./app-documents";

const publication = z.strictObject({ description: z.string().trim().min(1).max(2000), collection:z.literal(true).optional(), organizationFilter:z.string().max(128).optional(), provenance:z.literal("organizationSlug").optional(), markdown:z.strictObject({title:z.string().max(128),slug:z.string().max(128).optional(),body:z.string().max(128).optional()}).optional() });
const row = z.object({name:z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/).max(128),story:z.string().min(1).max(4000),query:z.string().min(1).max(32768),hidden:z.boolean().optional(),scheduleSource:z.literal(true).optional(),mcp:publication.optional()});
const raw = z.strictObject({schema:z.string().min(1).max(262144),documents:z.array(row).max(100)});
export type PackagedGraphDocument = AppDocumentRow & {hidden?:boolean;scheduleSource?:true;mcp?:z.infer<typeof publication>};
export type PackagedGraphMetadata = {schema:string;documents:PackagedGraphDocument[]};
/** Validate app-owned SDL and named operations together; derive hashes and variable
 * schemas rather than trusting the uploaded row's execution metadata. */
export function packagedGraphMetadata(value:unknown):PackagedGraphMetadata {
 const parsed=raw.parse(value);
 if(new Set(parsed.documents.map(row=>row.name)).size!==parsed.documents.length)throw Error("Duplicate app graph document");
 const schema=buildSchema(parsed.schema);
 assertValidSchema(schema);
 if(schema.getQueryType()?.name!=="Query")throw Error("An app graph needs its query root named Query");
 if(schema.getMutationType() && schema.getMutationType()!.name!=="Mutation")throw Error("An app graph mutation root must be named Mutation");
 if(schema.getSubscriptionType() && schema.getSubscriptionType()!.name!=="Subscription")throw Error("An app graph subscription root must be named Subscription");
 const entries=Object.fromEntries(parsed.documents.map(({name,query,...entry})=>[name,{...entry,document:query} as AppDocument]));
 const checked=documentRows(schema,entries);
 return {schema:parsed.schema,documents:checked.map(document=>{const original=parsed.documents.find(row=>row.name===document.name)!;return {...document,...(original.hidden===undefined?{}:{hidden:original.hidden}),...(original.scheduleSource?{scheduleSource:true as const}:{}),...(original.mcp?{mcp:original.mcp}:{})};})};
}
export const appGraphMetadata=z.unknown().transform((value,ctx)=>{try{return packagedGraphMetadata(value);}catch{ctx.addIssue({code:"custom",message:"Invalid packaged graph schema or documents"});return z.NEVER;}});
