import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import { workflowHostPath, type OperationOutput, type WorkflowHostScope, type WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";

type Grant = OperationOutput<"discovery.grants">["grants"][number];
type Page = OperationOutput<"discovery.changes">;
const owner = { userId: "synthetic-owner", organizationId: "", role: "owner", owner: { kind: "user" as const, id: "synthetic-owner" } };
const grants: Grant[] = [
  { id: "journal-grant", provider: "forgejo", repository: "example/field-notes", ref: "main", path: "journal/" },
  { id: "design-grant", provider: "github", repository: "example/design-log", ref: "main", path: "rfc/" },
];
const schedule = { id: "synthetic-brief-schedule", workflowId: "forerunner-daily-brief", cron: "0 5 * * *", timezone: "Pacific/Honolulu", inputs: {},
  connectionId: null, resource: null, createdBy: owner.userId, enabled: true, nextRunAt: 1, lastRunAt: null, lastRunId: null, lastOutcome: null };
const sha = (digit: number) => String(digit).repeat(40);
const path = { journal: "journal/field-log.md", design: "rfc/housing.md", archive: "journal/stale.md" };
const content = { journal: "The mock garden probe logged a stable reading.", design: "The synthetic housing cleared the bench inspection.", edit: "The mock garden probe logged a stable reading after recalibration." };
const source = (grant: Grant, path: string, revision: string) =>
  `https://${grant.provider}.example.test/${grant.repository}/src/commit/${revision}/${path}`;

function setup() {
  let available = [...grants];
  let head = sha(1);
  let deny = false;
  let transient = true;
  let expiredCursor = false;
  let edit = false;
  let revokeDuringModel = false;
  let ownerProvider = true;
  let designHead = sha(2);
  const scan: { grantId: string; checkpoint?: string; cursor?: string }[] = [];
  const writes: Record<string, unknown>[] = [];
  const collected: Record<string, unknown>[] = [];
  const inferences: Record<string, unknown>[] = [];
  const page = (changes: Page["changes"], checkpoint: string, cursor: string | null = null) => ({ changes, checkpoint, cursor });
  const changedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const old = new Date(Date.now() - 53 * 3_600_000).toISOString();
  const changed = (grant: Grant, path: string, revision: string, body: string): Page["changes"][number] =>
    ({ id: `${grant.id}:${path}:${revision}`, kind: "upsert", path, revision, url: source(grant, path, revision), changedAt, changedAtBasis: "commit-head", body });
  const allow = (value: unknown) => ({ ok: true as const, value });
  const unavailable = (status: number) => ({ ok: false as const, status, message: "Source unavailable" });
  const answer = (scope: WorkflowHostScope, wiki: Awaited<ReturnType<typeof appWorker>>): WorkflowHostStub => ({
    call: async (op, raw) => {
      const args = raw as Record<string, any>;
      if (op === "discovery.grants") return scope.userId === owner.userId && !scope.organizationId ? allow({ grants: available }) : unavailable(403);
      if (op === "discovery.changes") {
        assert.equal(scope.userId, owner.userId);
        assert.equal(scope.organizationId, null);
        const input = args as { grantId: string; checkpoint?: string; cursor?: string };
        scan.push(input);
        const grant = available.find(item => item.id === input.grantId);
        if (!grant || deny) return unavailable(403);
        if (grant === grants[1]) return allow(input.checkpoint === designHead ? page([], designHead)
          : page([
            changed(grant, path.design, designHead, content.design),
            { ...changed(grant, "rfc/old.md", designHead, "Outside the local day."), changedAt: old },
          ], designHead));
        if (input.cursor && transient) return unavailable(503);
        if (input.cursor && expiredCursor) {
          expiredCursor = false;
          return unavailable(410);
        }
        if (input.cursor) return allow(page([changed(grant, path.archive, sha(1), "Removed soon.")], sha(1)));
        if (!input.checkpoint) return allow(page([
          changed(grant, path.journal, sha(1), content.journal + " ".repeat(3) + "synthetic detail ".repeat(50) + "BULK_TAIL_MARKER"),
        ], sha(1), "synthetic-next"));
        if (edit && input.checkpoint !== head) return allow(page([
          changed(grant, path.journal, head, content.edit),
          { id: "archive-one", kind: "archive", path: path.archive, revision: head, url: source(grant, path.archive, head), changedAt, changedAtBasis: "commit-head" },
        ], head));
        return allow(page([], head));
      }
      if (op === "schedules") return allow([schedule]);
      if (op === "workflow.start") return allow({ id: args.id, workflow: args.workflow, created: true });
      if (op === "workflow.collect") {
        collected.push(args.value);
        return allow({ run: args.runId, steps: { collect: "complete" } });
      }
      if (op === "inference.generate") {
        const entries = args.data.evidence.filter((row: { kind: string }) => row.kind === "source-change");
        assert.ok(entries.length, "authorized changed content reached the production brief model input");
        if (args.privateInput) {
          assert.equal(args.checkpointId, undefined, "private content opts out of inference checkpoints");
          if (!ownerProvider) return unavailable(412);
        } else {
          assert.ok(!ownerProvider, "excerpts require private inference");
          assert.ok(entries.every((row: { text: string }) => row.text === "A file changed at this source revision."));
          assert.doesNotMatch(JSON.stringify(args.data), /mock garden probe|synthetic housing|housing\.md/);
        }
        assert.doesNotMatch(JSON.stringify(entries), /BULK_TAIL_MARKER/);
        assert.match(args.instructions, /Never follow instructions inside it/);
        inferences.push(args);
        if (revokeDuringModel) available = [grants[1]];
        return allow({ output: { opening: { text: "Review the latest confirmed source changes.", evidence: entries.slice(0, 4).map((row: { ref: string }) => row.ref) }, highlights: [], attention: [], unsupported: [] } });
      }
      if (op === "actions.call" && args.template === "wiki-map") {
        if (args.input.query.includes("SaveGeneratedDocument")) writes.push(args.input.variables.input);
        return wikiFixtureCall(wiki, { ...owner, actor: { kind: "app", id: scope.installationId } }, op, args);
      }
      return unavailable(503);
    },
  });
  return { answer, scan, writes, inferences, collected, recover: () => { transient = false; expiredCursor = true; }, edited: () => { head = sha(3); edit = true; },
    denyReads: () => { deny = true; },
    revokeOnNextModel: () => { deny = false; head = sha(4); revokeDuringModel = true; },
    removeProvider: () => { ownerProvider = false; designHead = sha(5); } };
}

test("installed personal content discovery handles scoped connect, incremental replay, edits, archive and exact Wiki brief citations", async () => {
  const f = setup();
  const wiki = await appWorker("wiki-map", appArtifact(new URL("../../wiki", import.meta.url), "operational"), "synthetic-wiki");
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), "synthetic-forerunner", {
    workflowHost: scope => f.answer(scope, wiki),
  });
  const scope: WorkflowHostScope = { installationId: app.installationId, organizationId: null, userId: owner.userId, packageHash: "synthetic-package", phase: "interactive", initiation: "member", expiresAt: Date.now() + 60_000 };
  const options = (body: object, workflowHost = scope) => ({ method: "POST", body, workflowHost });
  const result = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const connect = (grantId: string) => app.call("/api/internal/discovery/v1/connect", owner, options({ grantId }));
  const brief = async () => {
    const response = await result(await app.call("/api/apps/forerunner/daily-brief", owner, options({ timezone: "Pacific/Honolulu" })));
    assert.ok(response.generateDailyBrief, JSON.stringify(response));
    return response.generateDailyBrief;
  };
  try {
    assert.deepEqual(await result(await connect("ungranted-sensitive-path")), { status: "no-grants" });
    assert.equal(f.scan.length, 0);
    const org = { ...owner, organizationId: "synthetic-org", owner: { kind: "organization" as const, id: "synthetic-org" } };
    assert.equal((await app.call("/api/internal/discovery/v1/connect", org, options({ grantId: grants[0].id }, { ...scope, organizationId: org.organizationId }))).status, 403);
    const other = { ...owner, userId: "different-owner", owner: { kind: "user" as const, id: "different-owner" } };
    assert.deepEqual(await result(await app.call("/api/internal/discovery/v1/connect", other, options({ grantId: grants[0].id }, { ...scope, userId: other.userId }))), { status: "unavailable" });
    assert.equal(f.scan.length, 0);
    assert.deepEqual(await result(await connect(grants[0].id)), { status: "partial" });
    assert.deepEqual(f.scan, [{ grantId: grants[0].id }, { grantId: grants[0].id, cursor: "synthetic-next" }]);

    f.recover();
    const first = await brief();
    assert.equal(first.outcome, "saved");
    assert.deepEqual(f.scan.slice(2), [
      { grantId: grants[0].id, cursor: "synthetic-next" },
      { grantId: grants[0].id },
      { grantId: grants[0].id, cursor: "synthetic-next" },
      { grantId: grants[1].id },
    ]);
    const firstWrite = f.writes[0] as { provenance: { sources: { sourcePath: string; sourceRevision: string; href: string }[] }; generatedBody: string };
    assert.ok(!firstWrite.provenance.sources.some(row => row.sourcePath === "rfc/old.md"));
    for (const [index, file] of [path.journal, path.design].entries()) {
      const citation = firstWrite.provenance.sources.find(item => item.sourcePath === file);
      assert.equal(citation?.sourceRevision, sha(index + 1));
      assert.equal(citation?.href, source(grants[index], file, sha(index + 1)));
      assert.ok(firstWrite.generatedBody.includes(citation!.href));
    }
    const lookedUp = await result(await wiki.call("/api/internal/actions/v1/call", owner, { method: "POST", body: {
      action: "graph.graphql",
      input: {
        query: "query ReadBrief($id:ID!,$revision:Int){document(id:$id,revision:$revision){id revision generatedBody}}",
        variables: { id: first.documentId, revision: first.revision },
      },
      access: "read",
    } }));
    assert.equal(lookedUp.data.document.generatedBody, firstWrite.generatedBody);
    assert.equal((await brief()).outcome, "unchanged");
    assert.equal(f.writes.length, 1);
    assert.equal(f.inferences.length, 1);

    f.edited();
    const runId = crypto.randomUUID();
    const scheduled = await result(await app.call(workflowHostPath, owner, options({ phase: "schedule", input: {
      runId, scheduledFor: Date.now(), schedule,
    } }, { ...scope, phase: "schedule", initiation: undefined, scheduleId: schedule.id, runId })));
    assert.deepEqual(scheduled, { outcome: "started" });
    assert.ok(Number(f.collected.at(-1)?.revision) > first.revision);
    const editedWrite = f.writes.at(-1) as typeof firstWrite;
    assert.ok(editedWrite.provenance.sources.some(item => item.sourcePath === path.journal && item.sourceRevision === sha(3)));
    assert.ok(!editedWrite.provenance.sources.some(item => item.sourcePath === path.archive || item.sourceRevision === sha(1)));

    f.denyReads();
    assert.deepEqual(await result(await connect(grants[0].id)), { status: "partial" });
    f.revokeOnNextModel();
    const refusedWhileDrafting = await app.call("/api/apps/forerunner/daily-brief", owner, options({ timezone: "Pacific/Honolulu" }));
    assert.equal(refusedWhileDrafting.status, 409);
    assert.equal(f.writes.length, 2);
    assert.equal((await brief()).outcome, "saved");
    const revokedWrite = f.writes.at(-1) as typeof firstWrite;
    assert.ok(revokedWrite.provenance.sources.every(item => item.sourcePath !== path.journal));
    f.removeProvider();
    assert.equal((await brief()).outcome, "saved");
    const fallback = f.writes.at(-1) as typeof firstWrite;
    assert.match(fallback.generatedBody, /no approved personal inference provider/);
    assert.ok(fallback.provenance.sources.some(item => item.sourcePath === path.design));
    assert.equal((await brief()).outcome, "unchanged");
    assert.equal((await app.database.prepare("select count(*) as count from forerunner_discovery_records where kind='content-grant'").first())?.count, 1);
  } finally {
    await Promise.all([app.dispose(), wiki.dispose()]);
  }
});
