// Project-driven delivery (docs/plans/project-delivery-flow.md) through the published MutateProject
// and ProjectDelivery documents, with Planning's real database and a host that stands in for the
// task dispatcher, Governance, Workshop's published documents and Foundry's readiness and submit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { parse, print } from "graphql";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { runPreparation } from "../src/server/delivery-prepare";
import { submitDeliveryPackage } from "../src/server/delivery-read";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import { IntakeService, type PlanningContext } from "../src/server/intake";

type Result = { data: Record<string, unknown> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] };
const mutate = mutateAction(graphqlSchema, { canInvoke: () => true });
const query = graphqlAction(graphqlSchema);
const gate = { installationId: "governance", controlId: "10000000-0000-4000-8000-000000000001" };
// Workshop's published documents, as the platform compares them: parsed and printed.
const workshopPublished = new Set((JSON.parse(readFileSync(new URL("../../workshop/graph/documents.json", import.meta.url), "utf8")) as { query: string }[]).map((d) => print(parse(d.query))));

/** The Sunny SNY-1 breadboard prototype, traced to Artera SNSP-1. */
const sunny = {
  board: { key: "breadboard-hardware", title: "SNY-1 breadboard prototype", kind: "hardware",
    statement: "Build the first SNY-1 prototype on a breadboard: Seeed XIAO ESP32-S3 Sense with an external U.FL antenna, a BH1750 light sensor and an SCD41 CO₂ sensor.",
    components: [
      { name: "Seeed XIAO ESP32-S3 Sense", manufacturer: "Seeed Studio", mpn: "113991115" },
      { name: "External U.FL 2.4 GHz antenna" }, { name: "BH1750 light sensor breakout" }, { name: "SCD41 CO2 sensor breakout" },
      { name: "Breadboard" }, { name: "Jumper wires", quantity: 10 },
    ],
    dimensions: [{ name: "Assembled breadboard footprint" }],
    acceptanceCriteria: ["The assembled breadboard powers from USB-C and every module is seated"],
    target: { productRevision: "SNY-1 rev A (from Artera SNSP-1 rev A)" } },
  wiring: { key: "i2c-bus", title: "Shared I²C sensor bus", kind: "wiring",
    statement: "BH1750 and SCD41 share one I²C bus with 3V3 and GND from the XIAO.",
    interfaces: [{ name: "I2C SDA", value: "D4/GPIO5" }, { name: "I2C SCL", value: "D5/GPIO6" }, { name: "BH1750 address", value: "0x23" }, { name: "SCD41 address", value: "0x62" }],
    connections: [{ from: "XIAO D4/GPIO5", to: "BH1750 SDA, SCD41 SDA", signal: "SDA" }, { from: "XIAO D5/GPIO6", to: "BH1750 SCL, SCD41 SCL", signal: "SCL" }, { from: "XIAO 3V3", to: "sensor VCC", signal: "3V3" }, { from: "XIAO GND", to: "sensor GND", signal: "GND" }],
    acceptanceCriteria: ["A bench I²C scan finds 0x23 and 0x62"] },
  firmware: { key: "firmware-readings", title: "ESPHome sensor readings", kind: "firmware",
    statement: "ESPHome firmware reads lux from the BH1750 and CO₂, temperature and humidity from the SCD41 every 60 seconds.",
    interfaces: [{ name: "I2C SDA", value: "D4/GPIO5" }, { name: "I2C SCL", value: "D5/GPIO6" }],
    deliverables: ["esphome/sny-1-breadboard.yaml"], target: { repository: "ncrmro/sunny" },
    acceptanceCriteria: ["esphome config validates for esp32-s3", "A flashed board reports all four readings"] },
  enclosure: { key: "printed-enclosure", title: "Printed enclosure", kind: "enclosure",
    statement: "A 3D-printed enclosure holds the breadboard build with airflow to the SCD41.",
    components: [{ name: "Printed enclosure shell", kind: "printed" }], dependsOn: ["breadboard-hardware"],
    acceptanceCriteria: ["The breadboard build fits the enclosure"] },
};

function fixture() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  const state = {
    taskStarts: [] as { task: string; id: string }[], failDispatch: false, approved: false, repoAuthorized: false,
    workshop: new Map<string, { id: string; name: string; revision: number; phase: string; brief: string; requirements: string; assembly: { items: unknown[] } }>(),
    workshopCalls: [] as string[], submits: [] as unknown[], intakes: 0,
  };
  const refuse = (text: string, status: number) => { throw new Response(text, { status }); };
  const workshopCall = (input: { query: string; variables: Record<string, any> }) => {
    const text = print(parse(input.query));
    const name = /(?:query|mutation) (\w+)/.exec(text)![1];
    state.workshopCalls.push(name);
    if (/^mutation/.test(text) && !workshopPublished.has(text)) refuse("Run a mutation document published by the destination app", 403);
    const v = input.variables.input;
    const get = (id: string) => state.workshop.get(id) ?? refuse("Not found", 404);
    switch (name) {
      case "PlanningWorkshopProjects": return { data: { workshopProjects: { nodes: [...state.workshop.values()].map(({ id, name }) => ({ id, name })) } } };
      case "WorkshopProjectHandoff": return { data: { workshopProjectHandoff: structuredClone(get(v.id)) } };
      case "CreateWorkshopProject": {
        const row = { id: crypto.randomUUID(), name: v.name, revision: 1, phase: "concept", brief: "", requirements: "", assembly: { items: [{ id: "starter" }] } };
        state.workshop.set(row.id, row);
        return { data: { createWorkshopProject: row } };
      }
      case "DescribeWorkshopProject": case "SaveWorkshopAssembly": {
        const row = get(v.id);
        if (row.revision !== v.revision) refuse("Changed", 409);
        Object.assign(row, name === "SaveWorkshopAssembly" ? { assembly: v.assembly } : { phase: v.phase, brief: v.brief, requirements: v.requirements }, { revision: row.revision + 1 });
        return { data: { [name[0].toLowerCase() + name.slice(1)]: row } };
      }
    }
    throw new Error(`Unexpected Workshop document ${name}`);
  };
  const answers: Record<string, (input: any) => unknown> = {
    "task.start": (input) => { if (state.failDispatch) refuse("Dispatch unavailable", 503); state.taskStarts.push(input); return { id: input.id, task: input.task, created: true }; },
    "workflow.collect": () => ({ run: "complete", steps: {} }),
    "workflow.start": () => refuse("Router unavailable", 503),
    "entities.get": (input) => input.type === "project" ? { ref: { installationId: "planning", type: "project", id: input.id }, revision: 1, title: "", attributes: {}, references: [] } : refuse("Not found", 404),
    "identity.resolve": () => ({ holderId: "holder" }),
    "actions.list": (input) => input.template === "workshop" ? [{ installationId: "workshop", actions: [] }]
      : input.template === "software-foundry" ? [{ installationId: "foundry", actions: [{ name: "work.readiness", permitted: true }] }] : [],
    "governance.gate-policy": () => ({ workKinds: ["research", "hardware", "implementation"], evidenceRequirements: { researchCitations: false, resolvedGaps: false }, duties: [{ duty: "perform", assignment: { holderId: "holder" } }] }),
    "governance.request-gate": () => ({ id: "review-1" }),
    "governance.verify-gate": () => (state.approved ? { verified: true } : refuse("Decision required", 409)),
    "graph.graphql": workshopCall, "graph.mutate": workshopCall,
    "work.readiness": (input) => state.repoAuthorized ? { repository: input.repository, ready: true, repositoryId: 7, execution: true, blockers: [] }
      : { repository: input.repository, ready: false, repositoryId: null, execution: false, blockers: [{ code: "repository", message: `No authorized access to ${input.repository}`, remediation: "Install the GitHub App on the repository." }] },
    "work.submit": (input) => { state.submits.push(input); return { submissionId: "f".repeat(64), repository: input.target.repository, issue: { number: 1, url: "https://github.com/ncrmro/sunny/issues/1", created: true }, run: null }; },
  };
  const host = { call: async (name: string, raw: unknown) => {
    const input = raw as Record<string, any>;
    const answer = answers[name === "actions.call" ? String(input.action) : name];
    if (!answer) throw new Error(`Unexpected ${name}: ${JSON.stringify(input).slice(0, 200)}`);
    return answer(name === "actions.call" ? input.input : input);
  } };
  const store = {
    query: async (s: { sql: string; params?: unknown[] }) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows as Record<string, unknown>[],
    batch: async (ss: { sql: string; params?: unknown[] }[]) => client.batch(ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
  const caller = (userId = "owner", canEdit = true): PlanningContext => {
    const actor = { kind: "member" as const, id: userId };
    return { identity: { userId, organizationId: "sunny", owner: { kind: "organization", id: "sunny" }, installationId: "planning", role: canEdit ? "owner" : "member", canEdit },
      actor, originActor: actor, members: () => ["owner", "member"], db: () => db, host: () => host, store: () => store } as unknown as PlanningContext;
  };
  const doc = (context: PlanningContext, name: keyof typeof documents, variables: Record<string, unknown>) => {
    const text = documentText(documents[name].document);
    return (text.startsWith("mutation") ? mutate : query).invoke(context, { query: text, operationName: name, variables }) as Promise<Result>;
  };
  /** One MutateProject item, answering its receipt and instructions. */
  const mutateProject = async (action: string, input: unknown, key: string = crypto.randomUUID(), context = caller()) => {
    const result = await doc(context, "MutateProject", { input: { items: [{ key, action, input }] } });
    assert.equal(result.errors, undefined, result.errors?.[0]?.message ?? "");
    const out = result.data!.mutateProject as { items: { status: string; result: any; error?: { code: string; message: string } }[]; instructions: { code: string; taskId?: string; call?: unknown }[] };
    return { ...out.items[0], instructions: out.instructions };
  };
  const delivery = async (projectId: string) => {
    const result = await doc(caller(), "ProjectDelivery", { input: { projectId } });
    assert.equal(result.errors, undefined, result.errors?.[0]?.message ?? "");
    return result.data!.projectDelivery as any;
  };
  /** Run the dispatched task the way platform dispatch invokes the phase. */
  const runTask = (id: string, context = caller()) => runPreparation(context, { runId: id, task: "planning-delivery-prepare", inputs: { preparationId: id } }) as Promise<any>;
  const rows = async (sql: string) => (await client.execute(sql)).rows;
  /** An editor sets the intake's Governance control explicitly, as RouteIntake allows. */
  const gateRoutes = async (intakeId: string) => {
    const service = new IntakeService(caller());
    const row = await service.get(intakeId);
    await service.route(row, { routes: row.body.routes.map(({ kind, dependsOn, rationale }) => ({ kind, dependsOn, rationale, gate })) });
  };
  return { client, db, state, caller, doc, mutateProject, delivery, runTask, rows, gateRoutes,
    migrate: () => migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }) };
}

async function sunnyProject(f: ReturnType<typeof fixture>, requirements: unknown[] = [sunny.board, sunny.wiring, sunny.firmware, sunny.enclosure]) {
  await f.migrate();
  const created = await f.mutateProject("create", { name: "SNY-1 breadboard prototype", githubRepository: "https://github.com/ncrmro/sunny", pressRelease: "Sunny SNY-1 tells you when a room needs air or light.", requirements });
  return created;
}

test("adding requirements saves them, records a preparation intent and starts the registered task", async () => {
  const f = fixture();
  try {
    const created = await sunnyProject(f);
    assert.equal(created.status, "pending", "the run is still to come");
    const { result } = created;
    assert.equal(result.revision, 1);
    assert.deepEqual(result.requirementChanges.map((c: any) => [c.key, c.change, c.revision, c.actionable]),
      [["breadboard-hardware", "added", 1, true], ["i2c-bus", "added", 1, true], ["firmware-readings", "added", 1, true], ["printed-enclosure", "added", 1, true]]);
    assert.equal(result.preparation.state, "dispatched");
    assert.deepEqual(f.state.taskStarts, [{ task: "planning-delivery-prepare", id: result.preparation.id, inputs: { preparationId: result.preparation.id } }]);
    assert.deepEqual(created.instructions.map((i) => [i.code, i.taskId]), [["WAIT_FOR_RUN", result.preparation.id]]);
    // Being added says nothing about approval, implementation or verification.
    const read = await f.delivery(result.id);
    assert.ok(read.requirements.every((r: any) => !("status" in r) && !("verified" in r)));
    assert.ok(read.acceptance.every((a: any) => a.state === "unverified"));
  } finally { f.client.close(); }
});

test("hardware and firmware prepare independently: Workshop project read back, Foundry blockers explicit, enclosure fit deferred", async () => {
  const f = fixture();
  try {
    const { result } = await sunnyProject(f);
    const done = await f.runTask(result.preparation.id);
    assert.equal(done.state, "prepared");
    const read = await f.delivery(result.id);
    assert.equal(read.intakeDecisions.truncated, false);
    assert.ok(read.intakeDecisions.items.length > 0);
    assert.ok(read.intakeDecisions.items.some((item: any) => item.questions.some((question: string) => question.includes("Release"))));
    const plan = read.preparation.plan;
    assert.deepEqual(plan.routes.map((r: any) => r.kind).sort(), ["hardware", "implementation"]);
    assert.ok(plan.routes.every((r: any) => r.gate?.controlId === undefined || r.gate), "routes carry a gate when Governance has one");
    const workshop = read.packages.find((p: any) => p.target === "workshop");
    const foundry = read.packages.find((p: any) => p.target === "foundry");
    // Hardware: BOM with unknown costs, wiring, I²C interfaces, unknown dimensions, CAD only because the enclosure asks.
    assert.equal(workshop.state, "proposed");
    assert.equal(workshop.body.bom.length, 7);
    assert.ok(workshop.body.bom.every((part: any) => part.unitCost === null && part.inventory === null && part.source === null));
    assert.deepEqual(workshop.body.interfaces.map((i: any) => `${i.name}=${i.value}`), ["I2C SDA=D4/GPIO5", "I2C SCL=D5/GPIO6", "BH1750 address=0x23", "SCD41 address=0x62"]);
    assert.deepEqual(workshop.body.dimensions.map((d: any) => [d.name, d.value, d.verified]), [["Assembled breadboard footprint", null, false]]);
    assert.deepEqual(workshop.body.deferred.map((d: any) => [d.requirement, d.waitsFor]), [["printed-enclosure", ["breadboard-hardware"]]]);
    assert.ok(!workshop.body.acceptanceCriteria.some((a: any) => a.requirement === "printed-enclosure"), "no fit claim while dimensions are unknown");
    assert.equal(workshop.body.cad.required, true);
    // The Workshop project is persisted through Workshop's own published documents and read back independently.
    assert.equal(f.state.workshop.size, 1);
    const [saved] = f.state.workshop.values();
    assert.equal(saved.phase, "concept");
    assert.match(saved.requirements, new RegExp(`planning-package: ${workshop.digest}`));
    assert.match(saved.brief, /Nothing has been purchased, generated, fabricated or fit-checked/);
    assert.ok((saved.assembly.items as { notes?: string }[]).filter((i) => i.notes?.includes("Placement unverified")).length >= 6);
    assert.equal(workshop.readback.matchesPackage, true);
    assert.equal(workshop.receipt.state, "verified");
    // Firmware: frozen package with shared interfaces and deliverables; it does not wait for the enclosure.
    assert.equal(foundry.state, "proposed");
    assert.equal(foundry.body.repository, "ncrmro/sunny");
    assert.deepEqual(foundry.body.deliverables.map((d: any) => d.path), ["esphome/sny-1-breadboard.yaml"]);
    assert.ok(foundry.body.sharedInterfaces.some((i: any) => i.name === "I2C SDA" && i.value === "D4/GPIO5"));
    assert.match(foundry.digest, /^[a-f0-9]{64}$/);
    assert.ok(plan.blockers.some((b: any) => b.target === "foundry" && b.code === "repository" && /Install the GitHub App/.test(b.remediation)));
    // Questions name what is unknown instead of inventing it.
    assert.ok(plan.questions.some((q: any) => /Measure Assembled breadboard footprint/.test(q.question)));
    const byId = Object.fromEntries(read.milestones.map((m: any) => [m.id, m.state]));
    assert.deepEqual(byId, { documents: "evidenced", cad: "not_started", "software-build": "blocked", "pull-request": "not_started", "software-release": "not_started", physical: "not_started", marketing: "prepared", manufacturing: "not_started" });
  } finally { f.client.close(); }
});

test("an incomplete requirement produces focused questions, not invented specifications", async () => {
  const f = fixture();
  try {
    const { result } = await sunnyProject(f, [{ key: "battery", title: "Battery life", kind: "hardware", statement: "Runs on battery for TBD months", unknowns: ["Which battery chemistry is allowed?"] }]);
    await f.runTask(result.preparation.id);
    const { preparation } = await f.delivery(result.id);
    assert.deepEqual(preparation.questions.map((q: any) => q.question), [
      'What observable result accepts "Battery life"?', '"Battery life" still says TBD: what is the intended value?', "Battery life: Which battery chemistry is allowed?"]);
  } finally { f.client.close(); }
});

test("conflicting requirements block the packages and refuse submission", async () => {
  const f = fixture();
  try {
    const { result } = await sunnyProject(f);
    await f.runTask(result.preparation.id);
    const edited = await f.mutateProject("edit", { project: { id: result.id, revision: 1 }, mask: { requirements: [{ ...sunny.firmware, interfaces: [{ name: "I2C SDA", value: "GPIO7" }] }] } });
    assert.deepEqual(edited.result.requirementChanges.map((c: any) => [c.key, c.change]), [["firmware-readings", "changed"]]);
    const done = await f.runTask(edited.result.preparation.id);
    assert.equal(done.state, "blocked");
    const read = await f.delivery(result.id);
    assert.deepEqual(read.preparation.conflicts[0].values, [{ requirement: "firmware-readings", value: "GPIO7" }, { requirement: "i2c-bus", value: "D4/GPIO5" }]);
    const foundry = read.packages.filter((p: any) => p.target === "foundry").at(-1);
    assert.equal(foundry.state, "blocked");
    f.state.approved = true; f.state.repoAuthorized = true;
    await assert.rejects(submitDeliveryPackage(f.caller(), { requestId: crypto.randomUUID(), packageId: foundry.id, expectedDigest: foundry.digest }), (e) => e instanceof Response && e.status === 409);
    assert.equal(f.state.submits.length, 0);
  } finally { f.client.close(); }
});

test("identical retries reuse the receipt, the intake, the packages and the Workshop project", async () => {
  const f = fixture();
  try {
    await f.migrate();
    const key = crypto.randomUUID();
    const input = { name: "SNY-1 breadboard prototype", requirements: [sunny.board, sunny.wiring, sunny.firmware] };
    const first = await f.mutateProject("create", input, key);
    const again = await f.mutateProject("create", input, key);
    assert.deepEqual(again.result, first.result);
    assert.equal((await f.rows("SELECT id FROM planning_projects")).length, 1);
    assert.equal(f.state.taskStarts.length, 1);
    const id = first.result.preparation.id;
    await f.runTask(id);
    const packages = await f.rows("SELECT id,digest FROM planning_delivery_packages ORDER BY id");
    // A redelivered task, and a fresh run after a lost reply, change nothing.
    await f.runTask(id);
    await f.client.execute({ sql: "UPDATE planning_preparations SET state='running' WHERE id=?", args: [id] });
    await f.runTask(id);
    assert.deepEqual(await f.rows("SELECT id,digest FROM planning_delivery_packages ORDER BY id"), packages);
    assert.equal(f.state.workshop.size, 1);
    assert.equal((await f.rows("SELECT id FROM planning_intakes")).length, 1);
    assert.equal(f.state.workshopCalls.filter((c) => c === "CreateWorkshopProject").length, 1);
    // A changed input under the same key is a conflict, never a second project.
    const conflict = await f.mutateProject("create", { ...input, name: "Other" }, key);
    assert.equal(conflict.error?.code, "IDEMPOTENCY_CONFLICT");
  } finally { f.client.close(); }
});

test("a changed requirement produces a revised package; the submitted one is kept for reassessment", async () => {
  const f = fixture();
  try {
    const { result } = await sunnyProject(f, [sunny.board, sunny.wiring, sunny.firmware]);
    await f.runTask(result.preparation.id);
    let read = await f.delivery(result.id);
    const firstFoundry = read.packages.find((p: any) => p.target === "foundry");
    const firstWorkshop = read.packages.find((p: any) => p.target === "workshop");
    // Submission needs Governance approval and a ready repository.
    f.state.repoAuthorized = true;
    await f.gateRoutes(read.preparation.intakeId);
    const requestId = crypto.randomUUID();
    const waiting = await submitDeliveryPackage(f.caller(), { requestId, packageId: firstFoundry.id, expectedDigest: firstFoundry.digest });
    assert.equal(waiting.status, "awaiting_review");
    assert.equal(f.state.submits.length, 0);
    f.state.approved = true;
    const submitted = await submitDeliveryPackage(f.caller(), { requestId, packageId: firstFoundry.id, expectedDigest: firstFoundry.digest });
    assert.equal(submitted.status, "submitted");
    assert.equal(f.state.submits.length, 1);
    assert.deepEqual(await submitDeliveryPackage(f.caller(), { requestId, packageId: firstFoundry.id, expectedDigest: firstFoundry.digest }), submitted, "the same request answers the same submission");
    assert.equal(f.state.submits.length, 1);
    const submittedBody = (await f.rows(`SELECT body FROM planning_delivery_packages WHERE id='${firstFoundry.id}'`))[0].body;
    // A descriptive edit (title only) is a new revision that starts nothing.
    const described = await f.mutateProject("edit", { project: { id: result.id, revision: 1 }, mask: { requirements: [{ ...sunny.firmware, title: "ESPHome readings" }] } });
    assert.deepEqual(described.result.requirementChanges.map((c: any) => [c.change, c.revision, c.actionable]), [["descriptive", 2, false]]);
    assert.equal(f.state.taskStarts.length, 1);
    // The interval changes: a revised package is prepared; the submitted one is untouched and flagged.
    const changed = await f.mutateProject("edit", { project: { id: result.id, revision: 2 }, mask: { requirements: [{ ...sunny.firmware, statement: sunny.firmware.statement.replace("60 seconds", "30 seconds") }] } });
    assert.equal(changed.result.requirementChanges[0].change, "changed");
    await f.runTask(changed.result.preparation.id);
    read = await f.delivery(result.id);
    const foundry = read.packages.filter((p: any) => p.target === "foundry");
    assert.deepEqual(foundry.map((p: any) => [p.sequence, p.state]), [[1, "needs_reassessment"], [2, "proposed"]]);
    assert.equal(foundry[1].supersedes, firstFoundry.id);
    assert.equal((await f.rows(`SELECT body FROM planning_delivery_packages WHERE id='${firstFoundry.id}'`))[0].body, submittedBody);
    // The hardware package is unchanged by a firmware change, so the Workshop project is not rewritten.
    assert.deepEqual(read.packages.filter((p: any) => p.target === "workshop").map((p: any) => p.id), [firstWorkshop.id]);
    // The intake keeps its frozen delivery: changed requirements get a follow-up intake.
    assert.equal((await f.rows("SELECT id FROM planning_intakes WHERE body LIKE '%requirement-change%'")).length, 2);
    // History keeps every requirement revision.
    assert.deepEqual((await f.rows("SELECT r.revision FROM planning_requirement_revisions r JOIN planning_requirements q ON q.id=r.requirementId WHERE q.key='firmware-readings' ORDER BY r.revision")).map((r) => r.revision), [1, 2, 3]);
  } finally { f.client.close(); }
});

test("a dispatch failure keeps the saved project and intent; prepare recovers the same preparation", async () => {
  const f = fixture();
  try {
    await f.migrate();
    f.state.failDispatch = true;
    const created = await f.mutateProject("create", { name: "SNY-1", requirements: [sunny.firmware] });
    assert.equal(created.result.revision, 1);
    assert.equal(created.result.preparation.state, "dispatch_failed");
    assert.match(created.result.preparation.dispatchError, /Dispatch unavailable/);
    const retry = created.instructions.find((i) => i.code === "RETRY_PREPARATION");
    assert.deepEqual(retry?.call, { document: "MutateProject", item: { action: "prepare", input: { project: { id: created.result.id, revision: 1 } } } });
    assert.equal((await f.rows("SELECT state FROM planning_preparations"))[0].state, "dispatch_failed");
    f.state.failDispatch = false;
    const recovered = await f.mutateProject("prepare", { project: { id: created.result.id, revision: 1 } });
    assert.equal(recovered.result.preparation.state, "dispatched");
    assert.equal(recovered.result.preparation.id, created.result.preparation.id);
    assert.deepEqual(f.state.taskStarts.map((s) => s.id), [created.result.preparation.id]);
  } finally { f.client.close(); }
});

test("unauthorized submissions and unsupported completion claims are rejected", async () => {
  const f = fixture();
  try {
    const { result } = await sunnyProject(f, [sunny.board, sunny.wiring, sunny.firmware]);
    await f.runTask(result.preparation.id);
    const read = await f.delivery(result.id);
    const foundry = read.packages.find((p: any) => p.target === "foundry");
    const workshop = read.packages.find((p: any) => p.target === "workshop");
    f.state.approved = true;
    await f.gateRoutes(read.preparation.intakeId);
    const member = f.caller("member", false);
    await assert.rejects(submitDeliveryPackage(member, { requestId: crypto.randomUUID(), packageId: foundry.id, expectedDigest: foundry.digest }), (e) => e instanceof Response && e.status === 403);
    // An unauthorized repository blocks submission with its remediation, before anything reaches Foundry.
    const refusal = await submitDeliveryPackage(f.caller(), { requestId: crypto.randomUUID(), packageId: foundry.id, expectedDigest: foundry.digest }).then(() => null, (e) => e);
    assert.ok(refusal instanceof Response && refusal.status === 409);
    assert.match(await refusal.text(), /Install the GitHub App/);
    await assert.rejects(submitDeliveryPackage(f.caller(), { requestId: crypto.randomUUID(), packageId: foundry.id, expectedDigest: "0".repeat(64) }), (e) => e instanceof Response && e.status === 409);
    await assert.rejects(submitDeliveryPackage(f.caller(), { requestId: crypto.randomUUID(), packageId: workshop.id, expectedDigest: workshop.digest }), (e) => e instanceof Response && e.status === 409);
    assert.equal(f.state.submits.length, 0);
    // A requirement cannot be saved as approved, implemented or verified.
    const claim = await f.mutateProject("edit", { project: { id: result.id, revision: 1 }, mask: { requirements: [{ ...sunny.firmware, status: "verified" }] } });
    assert.equal(claim.status, "failed");
    assert.equal(claim.error?.code, "INVALID_INPUT");
    // A finished preparation task is not product completion.
    assert.equal((await f.delivery(result.id)).milestones.find((m: any) => m.id === "software-release").state, "not_started");
    assert.equal((await f.delivery(result.id)).milestones.find((m: any) => m.id === "physical").state, "not_started");
    // Members cannot rerun preparation.
    await assert.rejects(f.runTask(result.preparation.id, member), (e) => e instanceof Response && e.status === 403);
  } finally { f.client.close(); }
});
