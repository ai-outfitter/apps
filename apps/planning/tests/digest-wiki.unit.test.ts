import assert from "node:assert/strict";
import test from "node:test";
import {previousReportPeriod} from "../src/server/report-period";
import { digestPeriod, readDailyReport } from "../src/server/digest-wiki";

test("daily periods follow local midnight across DST transitions", () => {
 const local = (value:string) => digestPeriod(Date.parse(value),"America/Chicago");
 assert.equal(local("2026-03-08T05:59:59Z"),"2026-03-07");
 assert.equal(local("2026-03-08T06:00:00Z"),"2026-03-08");
 assert.equal(local("2026-03-09T04:59:59Z"),"2026-03-08");
 assert.equal(local("2026-03-09T05:00:00Z"),"2026-03-09");
 assert.equal(local("2026-11-01T06:30:00Z"),local("2026-11-01T07:30:00Z"));
});


test("previous-day windows remain bound to scheduled occurrence through DST and retries",()=>{
 const spring=previousReportPeriod(Date.parse("2026-03-09T13:00:00Z"));
 assert.deepEqual(spring,{date:"2026-03-08",timezone:"America/Chicago",start:Date.parse("2026-03-08T06:00:00Z"),end:Date.parse("2026-03-09T05:00:00Z")});
 assert.equal(spring.end-spring.start,23*3600000);
 const fall=previousReportPeriod(Date.parse("2026-11-02T14:00:00Z"));
 assert.equal(fall.end-fall.start,25*3600000);
 assert.equal(fall.date,"2026-11-01");
});

test("a saved report is read with one request to the owner's Wiki, named by package",async()=>{
 const calls:{operation:string;input:{template?:string;installationId?:string;action?:string}}[]=[];
 const host={call:async(operation:string,input:never)=>{
  calls.push({operation,input});
  return {data:{p0:{document:{id:"doc",installationId:"wiki",revision:3,archived:false,generatedBody:"x"}}}};
 }};
 // The body here carries no captured source, so the read is refused after its single request.
 await assert.rejects(readDailyReport(host as never,{installationId:"planning",owner:{kind:"organization",id:"org"}} as never,{date:"2026-11-13",timezone:"America/Chicago"}),error=>error instanceof Response&&error.status===409);
 assert.equal(calls.length,1);
 assert.deepEqual([calls[0].operation,calls[0].input.template,calls[0].input.installationId,calls[0].input.action],["actions.call","wiki-map",undefined,"graph.graphql"]);
});
