import {GraphQLBoolean,GraphQLID,GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString} from "graphql";
import {z} from "zod";
import type {Context} from "./graphql";

const Hit=new GraphQLObjectType({name:"WikiSearchHit",fields:{
 slug:{type:GraphQLString},id:{type:GraphQLID},revision:{type:GraphQLInt},publishedRevision:{type:GraphQLInt},
 title:{type:GraphQLString},summary:{type:GraphQLString},body:{type:GraphQLString},generatedBody:{type:GraphQLString}
}});
const Page=new GraphQLObjectType({name:"WikiSearchResults",fields:{
 documents:{type:new GraphQLList(Hit)},next:{type:GraphQLString}
}});
const list=(max:number)=>z.array(z.string().trim().min(1).max(256)).max(max).nullish();
const input=z.object({refs:list(100),search:list(20),revision:z.number().int().positive().nullish(),
 after:z.string().nullish(),first:z.number().int().min(1).max(100).default(20),includeBody:z.boolean().default(false)});

export const searchDocuments={
 type:Page,args:{
  refs:{type:new GraphQLList(new GraphQLNonNull(GraphQLString))},search:{type:new GraphQLList(new GraphQLNonNull(GraphQLString))},
  revision:{type:GraphQLInt},after:{type:GraphQLString},first:{type:GraphQLInt,defaultValue:20},includeBody:{type:GraphQLBoolean,defaultValue:false}
 },
 async resolve(_:unknown,raw:unknown,ctx:Context){
  const {refs,search,revision,after,first,includeBody}=input.parse(raw);
  const filters=["d.archived=0","d.id>?"],params:unknown[]=[revision??null,after??""];
  if(refs?.length){
   filters.push("(d.id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM wiki_pages p WHERE p.documentId=d.id AND p.slug IN (SELECT value FROM json_each(?))))");
   params.push(JSON.stringify(refs),JSON.stringify(refs));
  }
  if(search?.length){
   filters.push(`EXISTS (SELECT 1 FROM json_each(?) term WHERE ${["r.title","r.summary","r.body","r.generatedBody"].map(field=>"instr(lower("+field+"),lower(term.value))>0").join(" OR ")} OR EXISTS (SELECT 1 FROM wiki_pages p WHERE p.documentId=d.id AND instr(lower(p.slug),lower(term.value))>0))`);
   params.push(JSON.stringify(search));
  }
  const rows=await ctx.database.query({sql:`SELECT d.id,r.title,r.summary,r.revision,d.publishedRevision,
   (SELECT p.slug FROM wiki_pages p WHERE p.documentId=d.id ORDER BY p.slug LIMIT 1) AS slug
   ${includeBody?",r.body,r.generatedBody":""} FROM wiki_documents d JOIN wiki_document_revisions r
   ON r.documentId=d.id AND r.revision=coalesce(?,d.revision) WHERE ${filters.join(" AND ")} ORDER BY d.id LIMIT ?`,params:[...params,first+1]});
  return {documents:rows.slice(0,first),next:rows.length>first?rows[first-1].id:null};
 }
};
