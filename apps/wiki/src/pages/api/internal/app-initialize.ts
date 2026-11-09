import type {APIRoute} from "astro";
import {requestIdentity,requireEditor,respond} from "@ai-outfitter/app-sdk/server";
export const POST:APIRoute=({request})=>respond(async()=>{requireEditor(requestIdentity(request));return {initialized:true};});
