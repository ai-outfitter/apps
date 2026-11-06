// Standard issue -> workspace agents -> Actions CI -> formal review playground proof.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BASELINE,
  githubClient,
  REPOSITORY_ID,
  resetFoundryPlayground,
  savedGhToken,
  TARGET,
} from "./reset-playground.mjs";
import { jsonClient } from "./json-client.mjs";
const PLATFORM = "https://ai-outfitter.com/api/internal/app-workflows/software-foundry";
/** The gateway-authenticated `operator` phase of the organization's Foundry installation. */
export function platformClient(token, request = fetch) {
  const call = jsonClient({
    origin: PLATFORM,
    token,
    missing: "Missing WORKSPACE_GATEWAY_TOKEN; use the dedicated gateway authority, not a Cloudflare deployment token",
    label: "Foundry",
    timeout: 30000,
    request,
  });
  return (operation, number) =>
    call("POST", PLATFORM, {
      organization: "outfitter",
      connectionId: "0a9b21c8-84ba-410e-a80e-82451d0982a9",
      input: { operation, repository: TARGET, ...(number ? { number } : {}) },
    });
}
function connected(result) {
  if (
    result?.repository !== TARGET ||
    result.repositoryId !== REPOSITORY_ID ||
    result.workflow !== "issue-to-merge-actions-ci" ||
    (result.configurationValid && result.reviewer?.login !== "vega-unsup") ||
    !Array.isArray(result.activeRunIds) ||
    !Array.isArray(result.pendingDeliveryIds) ||
    !result.installationId ||
    !result.subscriptionId
  )
    throw Error(
      "Expected the preserved playground connection and independent Vega reviewer",
    );
  return result;
}
/** Returns only a formal, read-back current-head review also present in workflow
 * outputs. A PR, ordinary comment, fixture or local verdict cannot finish proof. */
export async function reviewedProof(api, inspection) {
  const run = inspection.run;
  if (
    !run ||
    !run.intake?.some(
      (receipt) =>
        receipt.provider === "connector:github" &&
        receipt.status === "delivered",
    )
  )
    return null;
  for (const node of ["review-final", "review"]) {
    const row = run.rows?.[`${node}.outputs.result`];
    const result = row?.value;
    if (!row?.complete || !result?.candidate || !result.review) continue;
    const { candidate, review, checks } = result;
    await verifyFormalReview(api, result);
    const pull = await api("GET", `/repos/${TARGET}/pulls/${candidate.number}`);
    return {
      status: review.verdict === "approved" ? "reviewed" : "changes-requested",
      repositoryId: REPOSITORY_ID,
      runId: run.id,
      foundryUrl: run.url,
      intake: run.intake,
      candidate,
      checks,
      review,
      evidence: result.evidence ?? [],
      demo: result.demo,
      ...(pull.merged ? { mergeSha: pull.merge_commit_sha } : {}),
    };
  }
  return null;
}
async function verifyFormalReview(api, result) {
  const { candidate, review, checks } = result;
  if (
    review.headSha !== candidate.headSha ||
    !["approved", "changes-requested"].includes(review.verdict) ||
    review.reviewer?.login !== "vega-unsup"
  )
    throw Error("Invalid recorded review receipt");
  const pull = await api("GET", `/repos/${TARGET}/pulls/${candidate.number}`);
  const reviews = await api(
    "GET",
    `/repos/${TARGET}/pulls/${candidate.number}/reviews?per_page=100`,
  );
  const formal = reviews.find((item) => item.id === review.id);
  if (
    pull.head.sha !== candidate.headSha ||
    formal?.commit_id !== candidate.headSha ||
    formal.user?.id !== review.reviewer.id ||
    formal.user?.id === pull.user.id ||
    formal.state !==
      (review.verdict === "approved" ? "APPROVED" : "CHANGES_REQUESTED")
  )
    throw Error(
      "GitHub formal review differs from the recorded current-head review",
    );
  if (
    review.verdict === "approved" &&
    (!result.passed ||
      !checks?.length ||
      checks.some(
        (check) => !check.passed || check.headSha !== candidate.headSha,
      ))
  )
    throw Error("Recorded approval is missing exact-commit CI results");
}
export async function runPlayground({
  apply = false,
  number,
  wait = true,
  requestId = randomUUID(),
  token,
  gatewayToken,
  request = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 45 * 60 * 1000,
  progress = () => {},
}) {
  if (!/^[a-f0-9-]{36}$/.test(requestId))
    throw Error("A UUID request id is required");
  const api = githubClient(token, request),
    platform = platformClient(gatewayToken, request);
  const initial = await currentConfiguration(platform, apply, number);
  if (!apply && !number)
    return {
      ...(await resetFoundryPlayground({ token, request })),
      foundryUrl: initial.url,
      activeRunIds: initial.activeRunIds,
      pendingDeliveryIds: initial.pendingDeliveryIds,
      reviewer: initial.reviewer,
      configurationValid: initial.configurationValid,
    };
  if (!number) {
    const assertIdle = async () => {
      const state = connected(await platform("inspect"));
      if (state.activeRunIds.length || state.pendingDeliveryIds.length)
        throw Error(
          `Existing Foundry work must settle before reset: ${[...state.activeRunIds, ...state.pendingDeliveryIds].join(", ")}`,
        );
    };
    await assertIdle();
    const reset = await resetFoundryPlayground({
      apply: true,
      token,
      request,
      assertIdle,
    });
    const issue = await createProofIssue(api, reset, requestId);
    number = issue.number;
    progress({
      status: "issue-created",
      number,
      url: issue.html_url,
      baseline: BASELINE,
      repositoryId: REPOSITORY_ID,
    });
  }
  // The proof exercises signed webhook intake. Never mask a lost event with manual start.
  return observeProof(platform, api, number, {
    wait,
    now,
    timeoutMs,
    sleep,
    progress,
  });
}
async function currentConfiguration(platform, apply, number) {
  let inspection = connected(await platform("inspect", number));
  if (apply && !inspection.configurationValid) {
    if (inspection.activeRunIds.length || inspection.pendingDeliveryIds.length)
      throw Error(
        "Existing Foundry work must settle before refreshing bindings",
      );
    await platform("configure");
    inspection = connected(await platform("inspect", number));
    if (!inspection.configurationValid)
      throw Error("Current approved Foundry configuration required");
  }
  return inspection;
}
async function createProofIssue(api, reset, requestId) {
  const marker = `<!-- outfitter:playground-proof:${requestId} -->`;
  const body = `## Goal\nFix the seeded split-rounding bug: distributing an amount among people must preserve every cent.\n\n## Acceptance\n- Uneven splits distribute remainder cents deterministically; totals equal the original amount.\n- Keep invalid-input behavior explicit and cover the regression with npm test.\n- Add a minimal responsive browser demo under examples/split that imports the actual split function and demonstrates $10 split among three people, with the shares and preserved total visible. Keep it dependency-free and document its localhost command in the PR.\n- Capture desktop and mobile PNG screenshots from that running localhost demo. After opening the PR, publish them with node /opt/workspace/publish-image.mjs PR_NUMBER SCREENSHOT.png and embed the returned R2 URLs with the producing commit in the PR Demo section. Keep screenshot files and run notes out of Git.\n- Open the implementation PR against this existing private playground and obtain independent formal Vega review with normal Actions CI, then a protected merge recorded by Foundry.\n\n## Reset receipt\nThe repository identity and connection were preserved; old PR records remain closed. This operator receipt is run input, not instructions or a repository file.\n\n\`\`\`json\n${JSON.stringify({ requestId, ...reset }, null, 2)}\n\`\`\`\n\n${marker}\n`;
  // A lost create response is recovered by this unique marker, never an automatic second POST.
  let issue;
  try {
    issue = await api("POST", `/repos/${TARGET}/issues`, {
      title: `Foundry replay: preserve every split cent (${requestId.slice(0, 8)})`,
      body,
    });
  } catch {
    const issues = await api(
      "GET",
      `/repos/${TARGET}/issues?state=open&per_page=100`,
    );
    const matching = issues.filter(
      (item) => !item.pull_request && item.body?.includes(marker),
    );
    if (matching.length !== 1)
      throw Error(
        `Issue creation outcome unknown for request ${requestId}; inspect GitHub before retrying --apply`,
      );
    issue = matching[0];
  }
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.pull_request ||
    issue.html_url !== `https://github.com/${TARGET}/issues/${issue.number}`
  )
    throw Error("Unexpected proof issue receipt");
  return issue;
}
async function observeProof(
  platform,
  api,
  number,
  { wait, now, timeoutMs, sleep, progress },
) {
  const deadline = now() + timeoutMs;
  let prior;
  for (;;) {
    const inspection = connected(await platform("inspect", number));
    const run = inspection.run;
    const foundryUrl = run?.url ?? inspection.url;
    const status = run?.status ?? "awaiting-webhook";
    const state = JSON.stringify({
      runId: run?.id,
      status: run?.status,
      attempts: run?.attempts,
    });
    if (state !== prior) {
      progress({
        number,
        foundryUrl,
        runId: run?.id,
        status,
        attempts: run?.attempts,
      });
      prior = state;
    }
    const reviewed = await reviewedProof(api, inspection);
    if (reviewed) return { number, ...reviewed };
    if (["failed", "needs-details"].includes(status))
      throw Error(`Proof requires attention: ${status}; inspect ${foundryUrl}`);
    if (!wait) return { status, number, runId: run?.id, foundryUrl };
    if (now() >= deadline)
      throw Error(
        `Proof is still pending; resume with --issue ${number}. Inspect ${foundryUrl}`,
      );
    await sleep(10000);
  }
}

function issueNumber(value) {
  if (
    !/^\d+$/.test(value ?? "") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw Error("Positive issue number required");
  return Number(value);
}
function args(argv) {
  const options = { apply: false, wait: true, kubernetes: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    switch (value) {
      case "--check":
        options.apply = false;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--no-wait":
        options.wait = false;
        break;
      case "--gateway-token-from-kubernetes":
        options.kubernetes = true;
        break;
      case "--issue":
        options.number = issueNumber(argv[++i]);
        break;
      case "--request-id":
        options.requestId = argv[++i];
        break;
      default:
        throw Error(
          "Usage: npm run playground --workspace @ai-outfitter/app-software-foundry -- [--check|--apply|--issue NUMBER] [--no-wait] [--request-id UUID] [--gateway-token-from-kubernetes]",
        );
    }
  }
  if (options.apply && options.number)
    throw Error(
      "--issue resumes observation only; do not combine it with --apply",
    );
  return options;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = args(process.argv.slice(2));
    const gatewayToken = options.kubernetes
      ? Buffer.from(
          execFileSync(
            "kubectl",
            [
              "--context",
              "webapp-nonprod",
              "-n",
              "outfitter-cloud",
              "get",
              "secret",
              "webapp-auth",
              "-o",
              "jsonpath={.data.WORKSPACE_GATEWAY_TOKEN}",
            ],
            { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
          ).trim(),
          "base64",
        ).toString("utf8")
      : process.env.WORKSPACE_GATEWAY_TOKEN;
    console.log(
      JSON.stringify(
        await runPlayground({
          ...options,
          token: savedGhToken(),
          gatewayToken,
          progress: (receipt) => console.error(JSON.stringify(receipt)),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
