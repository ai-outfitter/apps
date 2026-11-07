import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  documentPolicySubjectDigest,
  readDocumentPolicySubject,
} from "../src/document-policy";

test("policy subject client pins trusted producer and verifies full binding and digest", async () => {
  const binding = {
    version: 1 as const,
    producer: { installationId: "onto" },
    owner: { kind: "organization" as const, id: "org" },
    documentId: "doc",
    revision: 1,
    digest: "a".repeat(64),
    action: "seal",
    provider: "governance",
    config: "policy",
  };
  const trusted = {
    producer: binding.producer,
    owner: binding.owner,
    provider: binding.provider,
    config: binding.config,
  };
  const subject = {
    version: 1 as const,
    binding,
    definition: { id: "report", version: 1 },
  };
  const result = {
    subject,
    digest: await documentPolicySubjectDigest(subject),
  };
  let receipt: unknown = result;
  let calls = 0,
    lists = 0,
    revoked = false;
  const host = {
    call: async (name: string, input: any) => {
      if (name === "actions.list") {
        lists++;
        return revoked && lists > 1
          ? []
          : [
              {
                installationId: "onto",
                actions: [
                  {
                    name: "document.policy-subject",
                    access: "read",
                    permitted: true,
                  },
                ],
              },
            ];
      }
      calls++;
      assert.equal(input.installationId, "onto");
      assert.equal(input.readOnly, true);
      return receipt;
    },
  } as unknown as Pick<
    import("../src/workflow-host").WorkflowHost<"interactive">,
    "call"
  >;
  assert.deepEqual(
    await readDocumentPolicySubject(host, trusted, binding),
    result,
  );
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, {
      ...binding,
      producer: { installationId: "spoof" },
    }),
  );
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, {
      ...binding,
      owner: { kind: "organization", id: "spoof" },
    }),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, { ...binding, action: "publish" }),
  );
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, { ...binding, config: "changed" }),
    /Untrusted/,
  );
  receipt = {
    subject: {
      ...subject,
      binding: { ...binding, owner: { kind: "organization", id: "foreign" } },
    },
    digest: result.digest,
  };
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, binding),
    /Invalid policy subject/,
  );
  receipt = { subject, digest: "bad" };
  await assert.rejects(readDocumentPolicySubject(host, trusted, binding));
  receipt = result;
  revoked = true;
  lists = 0;
  await assert.rejects(
    readDocumentPolicySubject(host, trusted, binding),
    /unavailable/,
  );
  assert.equal(lists, 2, "recheck authorization after reading");
});
