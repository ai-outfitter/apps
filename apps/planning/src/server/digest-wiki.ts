import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readWikiPage, wikiDocuments } from "@ai-outfitter/app-sdk/wiki-documents";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import {reportPeriodForDate,type ReportPeriod } from "./report-period";
import {reportPreview,boundedReportMarkdown} from "./report-preview";
import {reportMarkdown} from "./report-markdown";
export { localDate as digestPeriod } from "./report-period";

type Host = Pick<WorkflowHost<"interactive">,"call">;
export type ReportRef={installationId:string;documentId:string;revision:number;slug:string;inputDigest:string;status:"complete"|"incomplete"};
/** Reports live in the Wiki package; naming it asks one provider instead of describing every installed app. */
/** Idempotent generated-section update; Wiki enforces revision guards and keeps authored/publication history. */
export async function saveReportNote(host:Host,actor:AppIdentity,input:{
 level:"project"|"organization"|"personal";subject:string;title:string;period:ReportPeriod;
 content:Record<string,unknown>;status:ReportRef["status"];runId:string;capturedAt:number;
}):Promise<ReportRef>{
 const slug=`${input.level}-daily-${await stableGraphId(actor.owner,actor.installationId,input.subject,input.period.date,input.period.timezone)}`;
 const current=await readWikiPage(host,slug);
 if(current?.archived)throw new Response("The daily report document is archived",{status:409});
 const inputDigest=await stableGraphId(input.period,input.status,input.content);
 const preview=reportPreview(input.content,input.level);
 const generatedBody=`Status: ${input.status}\n\n${typeof input.content.summary === "string" ? input.content.summary : ""}\n\n${boundedReportMarkdown(reportMarkdown(preview))}\n\n<details>\n<summary>Captured sources and provenance</summary>\n\n\`\`\`json\n${JSON.stringify({...preview,period:input.period,status:input.status,inputDigest},null,input.level==="project"?2:undefined)}\n\`\`\`\n</details>`;
 const source={kind:"planning.daily-report",owner:actor.owner,installationId:actor.installationId,subject:input.subject,level:input.level,period:input.period,inputDigest,runId:input.runId,capturedAt:input.capturedAt,status:input.status};
 const writeInput={...(current?{id:current.id,revision:current.revision}:{slug,title:input.title}),generatedBody,provenance:source};
 if(new TextEncoder().encode(JSON.stringify({input:writeInput})).byteLength>32768)throw new Response("Daily report preview exceeds the bounded write size; no document was changed",{status:413});
 if(current?.generatedBody===generatedBody)return {installationId:current.installationId,documentId:current.id,revision:current.revision,slug,inputDigest,status:input.status};
 const saved=await wikiDocuments(host,"graph.mutate","mutation SaveGeneratedDocument($input:SaveGeneratedDocumentInput!){saveGeneratedDocument(input:$input){id revision publishedRevision}}",{input:writeInput});
 const receipt=z.object({saveGeneratedDocument:z.object({id:z.string(),revision:z.number()})}).parse(saved).saveGeneratedDocument;
 const wiki=current ?? await readWikiPage(host,slug);
 if(!wiki || wiki.id!==receipt.id)throw new Error("Saved report could not be located in its Wiki");
 return {installationId:wiki.installationId,documentId:receipt.id,revision:receipt.revision,slug,inputDigest,status:input.status};
}

export const dailyReportReadInput=z.strictObject({
 level:z.enum(["project","organization","personal"]).optional(),subject:z.string().min(1).max(256).optional(),
 date:z.iso.date(),timezone:z.string().min(1).max(64).default("America/Chicago"),
});
/** Reads the owner's exact generated draft; a missing report is absence, never successful no-change coverage. */
export async function readDailyReport(host:Host,actor:AppIdentity,raw:z.input<typeof dailyReportReadInput>):Promise<Record<string,unknown>|null>{
 const input=dailyReportReadInput.parse(raw),level=input.level??(actor.owner.kind==="organization"?"organization":"personal");
 if(level==="organization" && actor.owner.kind!=="organization" || level==="personal" && actor.owner.kind!=="user")throw new Response("Report owner does not match its scope",{status:403});
 const subject=level==="project"?input.subject:actor.owner.id;
 if(!subject)throw new Response("A project report needs a project ID",{status:400});
 const slug=`${level}-daily-${await stableGraphId(actor.owner,actor.installationId,subject,input.date,input.timezone)}`;
 const document=await readWikiPage(host,slug);
 if(!document||document.archived)return null;
 const match=/```json\n([\s\S]*)\n```(?:\n<\/details>)?$/.exec(document.generatedBody);
 if(!match)throw new Response("Daily report has no captured generated source",{status:409});
 const source=z.record(z.string(),z.json()).parse(JSON.parse(match[1]));
 const captured=z.object({period:z.object({date:z.string(),timezone:z.string(),start:z.number(),end:z.number()}),status:z.enum(["complete","incomplete"]),inputDigest:z.string()}).parse(source);
 const expected=reportPeriodForDate(input.date,input.timezone);
 if(JSON.stringify(captured.period)!==JSON.stringify(expected))throw new Response("Daily report period does not match its requested identity",{status:409});
 return {...source,owner:actor.owner,planningInstallationId:actor.installationId,reference:{installationId:document.installationId,documentId:document.id,revision:document.revision,slug}};
}
