import assert from "node:assert/strict";
import test from "node:test";
import {documentEntities} from "../src/documents/entities";
import type {AgentDatabase} from "@ai-outfitter/app-sdk/agent-store";
const db={query:async()=>{throw new Error("Unauthorized reads must never query documents");}} as unknown as AgentDatabase;
const identity={userId:"external",installationId:"wiki",owner:{kind:"organization" as const,id:"org"},organizationId:"org",role:"external",canEdit:false};
test("document provider refuses external or cross-organization readers before accessing storage",async()=>{
 const provider=documentEntities(db)[0];
 await assert.rejects(provider.get(identity,"document"),error=>error instanceof Response && error.status===403);
 await assert.rejects(provider.get({...identity,role:"member",callerOrganizationId:"other"},"document"),error=>error instanceof Response && error.status===403);
});
