import type { Definition, DocumentContract } from "./service";
import { defaultContract } from "./render";

/** Synthetic issue definition; callers explicitly bind a trusted Planning provider.
 * Production issue publication is intentionally outside the document example. */
export function issueDefinition(
  kind: "feature" | "bug",
  planningInstallation: string,
): Definition {
  const contract: DocumentContract = {
    ...defaultContract,
    identity: `example.issue.${kind}`,
    rendering: {
      mode: "template",
      template: kind === "feature" ? "feature-issue" : "bug-issue",
      sections: [
        {
          title: "Use cases",
          provider: planningInstallation,
          pointer: "/data/project/useCases",
          required: true,
        },
        {
          title: "User stories",
          provider: planningInstallation,
          pointer: "/data/project/stories",
          required: true,
        },
        {
          title: "Requirements",
          provider: planningInstallation,
          pointer: "/data/project/requirements",
          required: true,
        },
        {
          title: "Acceptance criteria",
          provider: planningInstallation,
          pointer: "/data/project/acceptanceCriteria",
          required: true,
        },
        {
          title: "Evidence",
          provider: planningInstallation,
          pointer: "/data/project/evidence",
          required: false,
        },
      ],
    },
  };
  return {
    contract,
    sources: [
      {
        provider: planningInstallation,
        config: JSON.stringify({
          query:
            "query IssueContext { project { useCases stories requirements acceptanceCriteria evidence } }",
        }),
      },
    ],
  };
}
export function issueDraft(
  kind: "feature" | "bug",
  title: string,
  evidence: string[],
) {
  return {
    kind,
    title,
    evidence,
    publication: {
      status: "STUB" as const,
      message: "Draft only; publication is not implemented.",
    },
  };
}
