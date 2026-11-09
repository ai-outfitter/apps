/** Opt-in, private local KG examples. Original Wiki snapshots remain authoritative. */
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {z} from "zod";
import { wikiGraph } from "@ai-outfitter/onto/contracts";
const saved=z.strictObject({format:z.literal("outfitter-kg-examples-local-v1"),graph:wikiGraph});
export async function loadLocalWikiSeed({dataDirectory,organization}:{dataDirectory:string;organization:{slug:string}}){
 const path=join(dataDirectory,"app-snapshots",organization.slug,"wiki-kg-examples.json");
 try{return {source:"Opt-in synthetic KG examples",graph:saved.parse(JSON.parse(await readFile(path,"utf8"))).graph};}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {source:"No KG examples requested",graph:{types:[],nodes:[],edges:[]}};throw error;}
}
