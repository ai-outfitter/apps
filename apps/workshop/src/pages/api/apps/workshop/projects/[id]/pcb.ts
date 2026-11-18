import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../../../server/context";
import { PcbFileInput, PcbImportInput, uploadPcbFile, importPcbSnapshot, pcbSnapshotBundle } from "../../../../../../server/pcb-snapshots";
export const PUT: APIRoute=({request,locals,params})=>respond(async()=>uploadPcbFile(workshopContext(request,locals),params.id??"",await readJSON(request,PcbFileInput,29_000_000)));
export const POST: APIRoute=({request,locals,params})=>respond(async()=>importPcbSnapshot(workshopContext(request,locals),params.id??"",await readJSON(request,PcbImportInput,2_000_000)));
export const GET: APIRoute=({request,locals,params})=>respond(()=>pcbSnapshotBundle(workshopContext(request,locals),params.id??"",new URL(request.url).searchParams.get("snapshot")??""));
