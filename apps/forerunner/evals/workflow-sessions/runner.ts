import {readFile,writeFile} from "node:fs/promises";
import {workflowSession} from "@ai-outfitter/app-sdk/workflow-session";
import {liveInference, replayAdapter} from "./replay";

const original=workflowSession.parse(JSON.parse(await readFile("session.json","utf8")));
const config=JSON.parse(await readFile("replay-config.json","utf8"));
const result=await replayAdapter(liveInference).replay(original,config.checkpoint,config.overrides ?? {});
if(result.session.branch)result.session.branch.implementation=config.implementation;
await writeFile("candidate.json",JSON.stringify(result,null,2));
