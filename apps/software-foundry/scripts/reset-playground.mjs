// In-place reset of the fixed disposable playground. Never delete the repository.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { jsonClient } from "./json-client.mjs";
export const TARGET = "ai-outfitter/outfitter-playground-internal";
export const REPOSITORY_ID = 1416716694;
// Last prepared baseline before agents repaired the seeded split-rounding bug.
export const BASELINE = "b1a48c5218a5b0feddf38c44063de01dce4860d2";
const path = `/repos/${TARGET}`;
export function savedGhToken({ env = process.env } = {}) {
  const clean = { ...env };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ])
    delete clean[name];
  return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
    env: clean,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
export function githubClient(token, request = fetch) {
  const call = jsonClient({
    origin: "https://api.github.com",
    token,
    missing: "Missing saved GitHub operator login",
    label: "GitHub",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    request,
  });
  return async (method, suffix, body) => {
    const value = await call(method, suffix, body);
    if (value?.errors?.length) throw Error(`GitHub ${method} ${suffix}: GraphQL operation rejected`);
    return value;
  };
}
async function pages(api, suffix) {
  const result = [];
  for (let page = 1; page <= 50; page++) {
    const items = await api(
      "GET",
      `${path}/${suffix}${suffix.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(items)) throw Error("Unexpected playground inventory");
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw Error("Playground inventory exceeds reset limit");
}
function target(repo) {
  if (
    repo?.id !== REPOSITORY_ID ||
    repo.full_name !== TARGET ||
    repo.private !== true ||
    repo.default_branch !== "main" ||
    !repo.permissions?.admin
  )
    throw Error(
      "Expected the existing private playground identity and operator administration access",
    );
  return repo;
}
function policy(value) {
  return JSON.stringify(value, (key, item) =>
    key === "url" || key.endsWith("_url") ? undefined : item,
  );
}
async function rule(api) {
  const result = await api("POST", "/graphql", {
    query: `query { repository(owner:"ai-outfitter",name:"outfitter-playground-internal") { databaseId branchProtectionRules(first:100) { nodes { id pattern allowsForcePushes isAdminEnforced } pageInfo { hasNextPage } } } }`,
  });
  const repo = result?.data?.repository;
  if (
    repo?.databaseId !== REPOSITORY_ID ||
    repo.branchProtectionRules.pageInfo.hasNextPage ||
    repo.branchProtectionRules.nodes.length !== 1 ||
    repo.branchProtectionRules.nodes[0].pattern !== "main"
  )
    throw Error("Expected one exact playground main protection rule");
  return repo.branchProtectionRules.nodes[0];
}
async function setRule(api, id, allowsForcePushes, isAdminEnforced) {
  const result = await api("POST", "/graphql", {
    query:
      "mutation($input:UpdateBranchProtectionRuleInput!){updateBranchProtectionRule(input:$input){branchProtectionRule{id allowsForcePushes isAdminEnforced}}}",
    variables: {
      input: { branchProtectionRuleId: id, allowsForcePushes, isAdminEnforced },
    },
  });
  const confirmed =
    result?.data?.updateBranchProtectionRule?.branchProtectionRule;
  if (
    confirmed?.id !== id ||
    confirmed.allowsForcePushes !== allowsForcePushes ||
    confirmed.isAdminEnforced !== isAdminEnforced
  )
    throw Error("Protection update was not confirmed");
}
function assertProtection(protection) {
  if (
    !protection.enforce_admins?.enabled ||
    protection.allow_force_pushes?.enabled ||
    !protection.required_pull_request_reviews?.require_code_owner_reviews ||
    protection.required_pull_request_reviews.required_approving_review_count <
      1 ||
    !protection.required_status_checks?.checks?.some(
      (check) => check.context === "test" && check.app_id === 15368,
    )
  )
    throw Error(
      "Protected playground checks and independent approval must be enabled before reset",
    );
}
function assertWorkflows(workflows) {
  const test = workflows?.find(
    (item) => item.path === ".github/workflows/test.yml",
  );
  const agents = workflows?.filter((item) =>
    [
      ".github/workflows/outfitter-implement.yml",
      ".github/workflows/outfitter-managed-node.yml",
    ].includes(item.path),
  );
  if (
    test?.state !== "active" ||
    agents?.length !== 2 ||
    agents.some((item) => item.state !== "disabled_manually")
  )
    throw Error(
      "Keep test Actions active and both agent-execution Actions disabled",
    );
}
async function preflight(api) {
  const repo = target(await api("GET", path));
  const before = await api("GET", `${path}/git/ref/heads/main`);
  const seed = await api("GET", `${path}/git/commits/${BASELINE}`);
  if (seed?.sha !== BASELINE || !/^[a-f0-9]{40}$/.test(before?.object?.sha))
    throw Error("Invalid playground commit inventory");
  const protection = await api("GET", `${path}/branches/main/protection`);
  assertProtection(protection);
  const protectionRule = await rule(api);
  if (protectionRule.allowsForcePushes || !protectionRule.isAdminEnforced)
    throw Error("Unexpected playground protection flags");
  const rulesets = await api("GET", `${path}/rulesets?includes_parents=true`);
  if (
    !Array.isArray(rulesets) ||
    rulesets.some((item) => item.enforcement !== "disabled")
  )
    throw Error("Additional active rulesets need explicit reset support");
  const workflows = (await api("GET", `${path}/actions/workflows?per_page=100`))
    .workflows;
  assertWorkflows(workflows);
  const pulls = await pages(api, "pulls?state=open");
  const issues = (await pages(api, "issues?state=all")).filter(
    (item) => !item.pull_request,
  );
  const branches = (await pages(api, "branches")).filter(
    (item) => item.name !== "main",
  );
  if (branches.some((item) => item.protected))
    throw Error("Refusing to delete another protected branch");
  return { repo, before, protection, protectionRule, pulls, issues, branches };
}
/** @type {() => Promise<void>} */
const missingIdlePreflight = async () => {
  throw Error("Foundry idle preflight required before applying reset");
};
export async function resetFoundryPlayground({
  apply = false,
  token,
  request = fetch,
  assertIdle = missingIdlePreflight,
}) {
  const api = githubClient(token, request);
  const { repo, before, protection, protectionRule, pulls, issues, branches } =
    await preflight(api);
  const receipt = {
    status: apply ? "reset" : "preflight-ok",
    repository: TARGET,
    repositoryId: repo.id,
    previousHead: before.object.sha,
    baseline: BASELINE,
    closedPulls: pulls.map((item) => ({
      number: item.number,
      url: item.html_url,
      headSha: item.head.sha,
    })),
    deletedIssues: issues.map((item) => ({
      number: item.number,
      url: item.html_url,
      title: item.title,
    })),
    deletedBranches: branches.map((item) => item.name),
    retainedPullHistory: true,
    protectionRestored: false,
    actions: { test: "active", agents: "disabled_manually" },
  };
  if (!apply) return receipt;
  await assertIdle();
  target(await api("GET", path));
  if (
    (await api("GET", `${path}/git/ref/heads/main`)).object.sha !==
    before.object.sha
  )
    throw Error("Main changed after preflight; reset refused");
  // Close open PRs before deleting issue records/branches. GitHub cannot delete PRs.
  for (const pull of pulls)
    await api("PATCH", `${path}/pulls/${pull.number}`, { state: "closed" });
  for (const issue of issues) {
    if (!issue.node_id) throw Error("Issue has no deletion identity");
    const deleted = await api("POST", "/graphql", {
      query:
        "mutation($id:ID!){deleteIssue(input:{issueId:$id}){repository{databaseId}}}",
      variables: { id: issue.node_id },
    });
    if (deleted?.data?.deleteIssue?.repository?.databaseId !== REPOSITORY_ID)
      throw Error("Issue deletion was not confirmed");
  }
  for (const branch of branches)
    await api(
      "DELETE",
      `${path}/git/refs/heads/${encodeURIComponent(branch.name)}`,
    );
  await assertIdle();
  if (before.object.sha !== BASELINE) {
    await resetHead(api, protectionRule, protection, before.object.sha);
  }
  target(await api("GET", path));
  if (
    (await api("GET", `${path}/git/ref/heads/main`)).object.sha !== BASELINE ||
    (await pages(api, "issues?state=open")).length ||
    (await pages(api, "issues?state=all")).some((item) => !item.pull_request)
  )
    throw Error("Reset read-back failed; no proof was started");
  return { ...receipt, protectionRestored: true };
}
async function resetHead(api, protectionRule, protection, expectedHead) {
  let resetError, restoreError;
  try {
    await setRule(api, protectionRule.id, true, false);
    if (
      (await api("GET", `${path}/git/ref/heads/main`)).object.sha !==
      expectedHead
    )
      throw Error("Main changed before reset; force update refused");
    await api("PATCH", `${path}/git/refs/heads/main`, {
      sha: BASELINE,
      force: true,
    });
  } catch (error) {
    resetError = error;
  } finally {
    try {
      await setRule(
        api,
        protectionRule.id,
        protectionRule.allowsForcePushes,
        protectionRule.isAdminEnforced,
      );
      if (
        policy(await api("GET", `${path}/branches/main/protection`)) !==
        policy(protection)
      )
        restoreError = Error(
          "Protection restoration needs operator attention; do not start a proof",
        );
    } catch (error) {
      restoreError = error;
    }
  }
  if (restoreError)
    throw Error(
      "Protection restoration needs operator attention; do not start a proof",
    );
  if (resetError) throw resetError;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) {
    console.error(
      "Use catalog/apps/software-foundry/scripts/playground.mjs --apply for an idle-checked reset and proof; this standalone command supports --check only.",
    );
    process.exitCode = 1;
  } else
    try {
      console.log(
        JSON.stringify(
          await resetFoundryPlayground({ token: savedGhToken() }),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
