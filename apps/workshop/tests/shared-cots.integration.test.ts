import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import type { ResolvedAssembly } from "../src/lib/assembly-resolution";
import type { CotsEvidenceResult } from "../src/server/cots-evidence";
import { documents } from "../src/server/documents";
import {
  assemblyItem, connectorEnvelope, fixtureMember, partNumber, purchasedPart, seedSharedCots, sharedCotsWorker, supplierSource,
} from "./fixtures/shared-cots";

test("a field researcher resolves the same purchased connector across two product assemblies", { timeout: 60_000 }, async t => {
  const fixture = await sharedCotsWorker();
  try {
    const { app, graph, callGraph } = fixture;
    const {
      outdoor, bench, carrier, insert, canonical, ownerRoot, outdoorPart, absentPart, photos,
      duplicatePhoto, recordInput, outdoorSave, recordEvidence,
    } = await seedSharedCots(fixture);
    const { evidence } = recordInput;
    await t.test("a direct consumer inherits both legacy attachment owners without fit evidence", async () => {
      const legacy = await graph<CotsEvidenceResult>("WorkshopCotsEvidence", {
        input: { projectId: outdoor.id, itemId: outdoorPart.id },
      });
      assert.equal(legacy.items.length, 1);
      const [shared] = legacy.items;
      assert.deepEqual(shared.photos.map(photo => photo.sha256).sort(), photos.map(({ file }) => file.sha256).sort());
      const alternate = shared.photos.find(photo => photo.sha256 === duplicatePhoto.file.sha256);
      assert.deepEqual(new Set(alternate?.attachments.map(attachment => attachment.itemId)), new Set([canonical.id, ownerRoot.id]));
      assert.deepEqual(shared.interfaces, []);
      assert.ok(shared.photos.every(photo => photo.basis === "legacy-attachment"));
      assert.ok(shared.warnings.some(warning => warning.code === "legacy_photo_unreviewed"));
    });

    const owner = await recordEvidence();
    const retry = await graph<CotsEvidenceResult>("RecordWorkshopCotsEvidence", { input: recordInput });
    assert.equal(retry.revision, owner.revision, "retrying the same mutation preserves the owner save");
    await t.test("GraphQL evidence and CAD agree across direct and transitive product uses", async productTest => {
      assert.match(outdoorSave.cotsWarnings.find(warning =>
        warning.itemId === absentPart.id && warning.code === "evidence_missing",
      )?.message ?? "", /reference photos or interface dimensions/i);
      for (const product of [outdoor, bench]) {
        await productTest.test(product.name, async () => {
          const input = { projectId: product.id, revision: product.revision };
          const result = await graph<CotsEvidenceResult>("WorkshopCotsEvidence", { input });
          assert.deepEqual({ projectId: result.projectId, revision: result.revision }, input);

          const matches = result.items.filter(item => item.number === partNumber);
          assert.equal(matches.length, 1, "repeated placements produce one shared part definition");
          const [shared] = matches;
          assert.deepEqual(shared.owner, {
            projectId: owner.id, itemId: canonical.id, revision: owner.revision,
            name: canonical.name, number: canonical.number, partRevision: canonical.revision,
          });
          assert.equal(shared.supplierSource, supplierSource);
          assert.deepEqual(shared.photos.map(photo => photo.sha256), photos.map(({ file }) => file.sha256));
          for (const [index, { file, photo, revision }] of photos.entries()) {
            const projected = shared.photos[index];
            assert.equal(projected.basis, "recorded");
            assert.deepEqual(
              { fileName: projected.fileName, bytes: projected.bytes, revision: projected.attachmentRevision,
                observation: projected.observation, downloadPath: projected.downloadPath },
              { fileName: file.fileName, bytes: file.bytes, revision, observation: photo.observation, downloadPath: file.downloadPath },
            );
            const attachmentKeys = projected.attachments.map(attachment =>
              JSON.stringify([attachment.projectId, attachment.itemId, attachment.revision, attachment.fileName]),
            );
            assert.equal(new Set(attachmentKeys).size, attachmentKeys.length);
            assert.ok(projected.attachments.some(attachment =>
              attachment.projectId === owner.id && attachment.itemId === canonical.id &&
              attachment.revision === revision && attachment.fileName === file.fileName,
            ), "the original canonical attachment pin is preserved");
            if (projected.sha256 === duplicatePhoto.file.sha256) {
              assert.ok(projected.attachments.some(attachment =>
                attachment.projectId === owner.id && attachment.itemId === ownerRoot.id &&
                attachment.revision === duplicatePhoto.revision && attachment.fileName === duplicatePhoto.file.fileName,
              ), "the second original attachment pin is preserved");
            }
          }
          const [depth, latch] = evidence.interfaces;
          assert.deepEqual(shared.interfaces, [
            { ...depth, verification: { ...depth.verification, testedOwnerRevision: duplicatePhoto.revision } },
            latch,
          ]);
          const missingFit = shared.warnings.find(warning => warning.code === "fit_untested");
          assert.equal(missingFit?.interfaceId, evidence.interfaces[1].id);
          assert.equal(shared.warnings.some(warning =>
            warning.code === "fit_tested_elsewhere" && warning.interfaceId === evidence.interfaces[0].id,
          ), product.id === bench.id);

          const cad = await graph<ResolvedAssembly>("ResolvedWorkshopAssembly", { input });
          assert.equal(cad.assembly.items.find(item => item.id === cad.assembly.rootId)?.uses.length, product.id === bench.id ? 2 : 3);
          const matchingCad = cad.assembly.items.filter(item => item.kind === "cots" && item.number === partNumber);
          assert.equal(matchingCad.length, 1);
          assert.deepEqual(matchingCad[0].geometry, connectorEnvelope);
          assert.equal(shared.itemId, matchingCad[0].id, "evidence links back to the selected CAD item");
          assert.deepEqual(
            (await graph<CotsEvidenceResult>("WorkshopCotsEvidence", { input: { ...input, itemId: matchingCad[0].id } })).items,
            [shared],
          );
          if (product.id === bench.id) {
            assert.deepEqual(new Set(cad.sources.map(source => source.projectId)), new Set([insert.id, carrier.id]));
          } else {
            const absent = result.items.find(item => item.itemId === absentPart.id);
            assert.ok(absent);
            assert.deepEqual({ photos: absent.photos, interfaces: absent.interfaces }, { photos: [], interfaces: [] });
            assert.match(absent.warnings.find(warning => warning.code === "evidence_missing")?.message ?? "", /no owned-part reference photos or interface dimensions/i);
          }
        });
      }
    });

    await t.test("original bytes verify with both historical attachment owners", async () => {
      const attachments = [
        ...photos.map(photo => ({ ...photo, itemId: canonical.id })),
        { ...duplicatePhoto, itemId: ownerRoot.id },
      ];
      for (const { file, photo, revision, itemId } of attachments) {
        const readback = await graph<{ revision: number; itemId: string; file: typeof file; base64: string }>(
          "VerifyWorkshopAssemblyFile", {
            input: {
              projectId: owner.id, itemId, revision,
              fileName: file.fileName, expectedSha256: file.sha256, byteOffset: 0,
            },
          },
        );
        assert.equal(readback.revision, revision);
        assert.equal(readback.itemId, itemId);
        assert.deepEqual(readback.file, file);
        assert.deepEqual(Buffer.from(readback.base64, "base64"), photo.original);
      }
    });

    await t.test("writes reject untested revisions and callers outside their scope", async () => {
      const [depth, latch] = evidence.interfaces;
      const wrongTestRevision = await callGraph("RecordWorkshopCotsEvidence", {
        input: {
          ...recordInput,
          expectedRevision: owner.revision,
          evidence: {
            ...evidence,
            interfaces: [{ ...depth, verification: { ...depth.verification, testedRevision: outdoor.revision - 1 } }, latch],
          },
        },
      }, fixtureMember);
      assert.equal(wrongTestRevision.result.errors?.[0]?.extensions?.status, 409);
      assert.match(wrongTestRevision.result.errors?.[0]?.message ?? "", /tested revision does not contain/i);

      const differentPartProject = await fixture.createProject("Different purchased connector");
      const differentPart = {
        ...purchasedPart(), mpn: "OTHER-CONNECTOR",
        cotsEvidenceRef: { projectId: owner.id, itemId: canonical.id },
      };
      const differentRoot = assemblyItem("Connector enclosure", "DIFFERENT", [{ itemId: differentPart.id, refdes: "J1" }]);
      const wrongPart = await callGraph("UpdateWorkshopAssembly", {
        projectId: differentPartProject.id,
        expectedRevision: differentPartProject.revision,
        assembly: { rootId: differentRoot.id, items: [differentRoot, differentPart] },
      }, fixtureMember);
      assert.equal(wrongPart.result.errors?.[0]?.extensions?.status, 409);
      assert.match(wrongPart.result.errors?.[0]?.message ?? "", /different purchased part/i);

      const reader = { ...fixtureMember, userId: "fixture-observer", role: "member" };
      const readerMutation = await callGraph("RecordWorkshopCotsEvidence", { input: recordInput }, reader);
      assert.equal(readerMutation.result.errors?.[0]?.extensions?.status ?? readerMutation.status, 403);
      const foreignMember = { ...fixtureMember, userId: "foreign-owner", organizationId: "foreign-fixture" };
      const headers = identityHeaderValues({
        ...fixtureMember, userId: foreignMember.userId, role: "external",
        installationId: app.installationId, callerOrganizationId: foreignMember.organizationId,
      });
      const externalMutation = await app.dispatch("", new Request(app.origin + actionPath + "/call", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "graph.mutate",
          input: { query: documentText(documents.RecordWorkshopCotsEvidence.document), variables: { input: recordInput } },
        }),
      }));
      assert.equal(externalMutation.status, 403, await externalMutation.text());

      const foreign = await sharedCotsWorker(foreignMember);
      try {
        const denied = await foreign.callGraph("RecordWorkshopCotsEvidence", { input: recordInput }, foreignMember);
        assert.ok([400, 403, 404].includes(denied.result.errors?.[0]?.extensions?.status ?? denied.status));
        assert.equal(denied.result.data?.recordWorkshopCotsEvidence ?? null, null);
        const hidden = await foreign.callGraph("WorkshopCotsEvidence", { input: { projectId: bench.id } }, foreignMember);
        assert.ok([400, 403, 404].includes(hidden.result.errors?.[0]?.extensions?.status ?? hidden.status));
        assert.equal(hidden.result.data?.workshopCotsEvidence ?? null, null);
        const asset = await foreign.app.call(photos[0].file.downloadPath, foreignMember);
        assert.ok([403, 404].includes(asset.status), `Unexpected foreign file status ${asset.status}`);
        const foreignProduct = await foreign.createProject("Unrelated fixture");
        const alias = { ...purchasedPart(), cotsEvidenceRef: { projectId: owner.id, itemId: canonical.id } };
        const root = assemblyItem("Unrelated enclosure", "UNRELATED", [{ itemId: alias.id, refdes: "J1" }]);
        const linked = await foreign.callGraph("UpdateWorkshopAssembly", {
          projectId: foreignProduct.id,
          expectedRevision: foreignProduct.revision,
          assembly: { rootId: root.id, items: [root, alias] },
        }, foreignMember);
        assert.ok([400, 403, 404].includes(linked.result.errors?.[0]?.extensions?.status ?? linked.status));
        assert.equal(linked.result.data?.updateWorkshopAssembly ?? null, null);
      } finally {
        await foreign.app.dispose();
      }

      assert.equal((await graph<CotsEvidenceResult>("WorkshopCotsEvidence", {
        input: { projectId: owner.id, itemId: canonical.id },
      })).revision, owner.revision, "rejected writes leave the canonical project at its saved revision");
    });
  } finally {
    await fixture.app.dispose();
  }
});
