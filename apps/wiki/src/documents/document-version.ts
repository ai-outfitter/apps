import {GraphQLID,GraphQLInt,GraphQLNonNull,GraphQLObjectType,GraphQLString} from "graphql";
import {z} from "zod";
import type {Context} from "./graphql";

// A series key and version belong to the producer. Older generated documents
// already identify their series by kind and their dated edition by date.
export const documentVersion = {
  description:"Read a generated document series. Defaults to its greatest version (lexical order) and that document's current draft revision. Supply version and revision to pin both.",
  type:new GraphQLObjectType({
    name:"WikiDocumentVersion",
    fields:{
      documentId:{type:GraphQLID},revision:{type:GraphQLInt},slug:{type:GraphQLString},
      version:{type:GraphQLString},title:{type:GraphQLString},body:{type:GraphQLString},
      generatedBody:{type:GraphQLString},timezone:{type:GraphQLString},status:{type:GraphQLString},savedAt:{type:GraphQLString},
    },
  }),
  args:{key:{type:new GraphQLNonNull(GraphQLString)},version:{type:GraphQLString},revision:{type:GraphQLInt}},
  async resolve(_:unknown,args:{key:string;version?:string|null;revision?:number|null},ctx:Context){
    const key=z.string().min(1).max(256).parse(args.key);
    const version=args.version??null, revision=args.revision??null;
    if(revision!==null)z.number().int().positive().parse(revision);
    const edition="coalesce(json_extract(head.provenance,'$.version'),json_extract(head.provenance,'$.date'))";
    const [row]=await ctx.database.query({
      sql:`WITH selected AS (
        SELECT d.id,d.revision,p.slug,${edition} AS version
        FROM wiki_document_revisions head JOIN wiki_documents d ON d.id=head.documentId AND d.revision=head.revision
        JOIN wiki_pages p ON p.documentId=d.id
        WHERE d.archived=0 AND json_extract(head.provenance,'$.kind')=?
        AND (json_extract(head.provenance,'$.owner.id') IS NULL OR json_extract(head.provenance,'$.owner.id')=?)
        AND typeof(${edition})='text' ${version===null?"":"AND "+edition+"=?"}
        ORDER BY ${edition} DESC,head.createdAt DESC,p.slug LIMIT 1
      ) SELECT s.id AS documentId,s.slug,s.version,r.revision,r.title,r.body,r.generatedBody,
        json_extract(r.provenance,'$.timezone') AS timezone,json_extract(r.provenance,'$.status') AS status,r.createdAt
        FROM selected s JOIN wiki_document_revisions r ON r.documentId=s.id AND r.revision=coalesce(?,s.revision)`,
      params:[key,ctx.identity.owner.id,...(version===null?[]:[version]),revision],
    });
    return row?{...row,savedAt:new Date(Number(row.createdAt)).toISOString()}:null;
  },
};
