import { GraphQLBoolean, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { archiveDocument, getDocument, getPage, listDocuments, listPages, pageInput, publishDocument, revisions, saveDocument, saveInput, savePage, transitionInput, type PolicyCheck } from "./store";

export type Context = ActionContext & { database: AgentDatabase; policyCheck?: PolicyCheck };
const revisionFields = {
 documentId:{type:GraphQLID}, revision:{type:GraphQLInt}, title:{type:GraphQLString},summary:{type:GraphQLString},body:{type:GraphQLString},generatedBody:{type:GraphQLString},provenance:{type:GraphQLString},editorId:{type:GraphQLString},createdAt:{type:GraphQLString},
};
const Revision = new GraphQLObjectType({ name:"DocumentRevision", fields:revisionFields });
const Document = new GraphQLObjectType({name:"WikiDocument",fields:{
 ...revisionFields,id:{type:GraphQLID},publishedRevision:{type:GraphQLInt},archived:{type:GraphQLBoolean,resolve:value=>!!value.archived},
}});
const Page = new GraphQLObjectType({name:"WikiPage",fields:{id:{type:GraphQLID},slug:{type:GraphQLString},documentId:{type:GraphQLID},entityRef:{type:GraphQLString},parentId:{type:GraphQLID},revision:{type:GraphQLInt},autoPublish:{type:GraphQLBoolean,resolve:value=>!!value.autoPublish},policyRef:{type:GraphQLString}}});
export const graphqlSchema = new GraphQLSchema({
 query:new GraphQLObjectType<unknown,Context>({name:"Query",fields:{
  documents:{type:new GraphQLList(Document),args:{after:{type:GraphQLID},first:{type:GraphQLInt}},resolve:(_,args,ctx)=>listDocuments(ctx.database,args.after ?? "",args.first ?? 50)},
  document:{type:Document,args:{id:{type:new GraphQLNonNull(GraphQLID)},revision:{type:GraphQLInt}},resolve:(_,args,ctx)=>getDocument(ctx.database,args.id,args.revision)},
  documentRevisions:{type:new GraphQLList(Revision),args:{id:{type:new GraphQLNonNull(GraphQLID)},before:{type:GraphQLInt}},resolve:(_,args,ctx)=>revisions(ctx.database,args.id,args.before)},
  pages:{type:new GraphQLList(Page),resolve:(_,__,ctx)=>listPages(ctx.database)},
  page:{type:Page,args:{slug:{type:new GraphQLNonNull(GraphQLString)}},resolve:(_,args,ctx)=>getPage(ctx.database,args.slug)},
 }}),
 mutation:new GraphQLObjectType<unknown,Context>({name:"Mutation",fields:{
  saveDocument:mutationField({name:"SaveDocument",description:"Save a revisioned draft without publishing it.",input:saveInput,output:Document,run:(ctx:Context,input)=>saveDocument(ctx.database,ctx.identity,input)}),
  savePage:mutationField({name:"SavePage",description:"Create or configure a Wiki page.",input:pageInput,output:Page,run:(ctx:Context,input)=>savePage(ctx.database,ctx.identity,input)}),
  publishDocument:mutationField({name:"PublishDocument",description:"Publish a revision after its policy requirements pass.",input:transitionInput,output:Document,run:(ctx:Context,input)=>publishDocument(ctx.database,ctx.identity,input,ctx.policyCheck)}),
  archiveDocument:mutationField({name:"ArchiveDocument",description:"Archive a document without deleting its history.",input:transitionInput,output:Document,run:(ctx:Context,input)=>archiveDocument(ctx.database,ctx.identity,input)}),
 }}),
});
