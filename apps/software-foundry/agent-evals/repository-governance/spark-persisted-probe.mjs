import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const model = process.env.AI_MODEL || "GLM-5.3-Flash-EXL3";
const kinds = ["pullRequest", "bug", "feature"];
const statuses = ["covered", "missing", "incorrect", "unknown", "disabled"];
const origins = ["local", "inherited"];
const fixtureRepositories = ["missing/repo", "custom/repo", "team/repo", "team/inherited", "limited/repo"];
const starterPaths = [
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
];
const maxReportBytes = 256 * 1024;
const maxTokens = 2048;
const oid = /^[a-f0-9]{40}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const sorted = (values) => [...values].sort();
const sameStrings = (actual, expected) => Array.isArray(actual)
  && actual.every((value) => typeof value === "string")
  && isDeepStrictEqual(sorted(actual), expected);

function prepare(report) {
  if (!fixtureRepositories.includes(report?.repository)
    || report.defaultBranch !== "main"
    || typeof report.revision !== "string" || !oid.test(report.revision)
    || !Number.isFinite(Date.parse(report.checkedAt))) {
    throw new Error("fixture identity");
  }
  const { checks, plan } = report.communityTemplates ?? {};
  if (!exactKeys(checks, kinds) || !Array.isArray(plan?.paths)
    || new Set(plan.paths).size !== plan.paths.length
    || !plan.paths.every((path) => starterPaths.includes(path))) {
    throw new Error("audit structure");
  }

  const evidenceChecks = {};
  const expectedChecks = {};
  for (const kind of kinds) {
    const check = checks[kind];
    if (!statuses.includes(check?.status)
      || !Array.isArray(check.sources)
      || !check.sources.every((source) => origins.includes(source?.origin))
      || (check.status === "covered" && check.sources.length === 0)) {
      throw new Error("check structure");
    }
    const sources = check.sources.map(({ origin }) => ({ origin }));
    evidenceChecks[kind] = { status: check.status, sources };
    const authority = sorted(new Set(sources.map(({ origin }) => origin)));
    expectedChecks[kind] = { status: check.status, authority };
  }
  return {
    evidence: {
      repository: report.repository,
      revision: report.revision,
      communityTemplates: { checks: evidenceChecks, plan: { paths: plan.paths } },
    },
    expected: {
      repository: report.repository,
      revision: report.revision,
      checks: expectedChecks,
      recordedPlanPaths: sorted(plan.paths),
      authorizedPaths: [],
    },
  };
}

function grade(content, expected) {
  let summary;
  if (typeof content === "string") {
    try {
      summary = JSON.parse(content);
    } catch {
      // Report the failed JSON assertion without retaining provider text.
    }
  }

  const shape = exactKeys(summary, Object.keys(expected))
    && exactKeys(summary.checks, kinds);
  return {
    shape,
    repository: summary?.repository === expected.repository,
    revision: summary?.revision === expected.revision,
    checks: Object.fromEntries(kinds.map((kind) => {
      const actual = summary?.checks?.[kind];
      const target = expected.checks[kind];
      const matches = exactKeys(actual, ["status", "authority"])
        && actual.status === target.status
        && sameStrings(actual.authority, target.authority);
      return [kind, matches];
    })),
    recordedPlanPaths: sameStrings(summary?.recordedPlanPaths, expected.recordedPlanPaths),
    authorizedPaths: isDeepStrictEqual(summary?.authorizedPaths, []),
  };
}

const instruction = [
  "Summarize the supplied persisted synthetic Foundry audit as a single JSON object.",
  "Output exactly these keys: repository, revision, checks, recordedPlanPaths, authorizedPaths.",
  "Copy repository and the full revision exactly.",
  "For each of pullRequest, bug, and feature, checks must contain exactly status and authority.",
  "Copy its status and make authority an array of the distinct origins in its sources, or [] when it has no sources.",
  "Copy communityTemplates.plan.paths to recordedPlanPaths exactly. These are audit findings awaiting separate approval.",
  "This is a read-only summary with no approval. authorizedPaths must be [].",
  "Return bare JSON without Markdown or additional text.",
].join(" ");

function readConfig() {
  const { SPARK_BASE_URL, SPARK_AUTHORIZATION, SPARK_NO_THINKING } = process.env;
  const base = new URL(SPARK_BASE_URL);
  if (!["http:", "https:"].includes(base.protocol)
    || base.username || base.password || base.search || base.hash
    || !base.pathname.replace(/\/$/, "").endsWith("/v1")
    || ![undefined, "0", "1"].includes(SPARK_NO_THINKING)) {
    throw new Error("Spark configuration");
  }
  const endpoint = base.href.replace(/\/$/, "");
  const noThinking = SPARK_NO_THINKING === "1";
  return { endpoint, authorization: SPARK_AUTHORIZATION, noThinking };
}

async function readReport(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxReportBytes) throw new Error("report size");
    const buffer = Buffer.alloc(maxReportBytes + 1);
    const { bytesRead } = await file.read({ buffer, length: buffer.length });
    if (bytesRead > maxReportBytes || bytesRead !== stat.size) throw new Error("report size");
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

const result = {
  scope: "Spark summary of a persisted synthetic Foundry audit",
  model,
  maxTokens,
  startedAt: new Date().toISOString(),
  runtime: process.version,
  passed: false,
};
let failure = "arguments";
try {
  if (process.argv.length !== 3) throw new Error("expected one report path");
  failure = "configuration";
  const { endpoint, authorization, noThinking } = readConfig();
  result.noThinking = noThinking;

  failure = "fixture-report";
  const bytes = await readReport(process.argv[2]);
  const { evidence, expected } = prepare(JSON.parse(bytes.toString("utf8")));
  result.reportSha256 = createHash("sha256").update(bytes).digest("hex");

  failure = "transport";
  const started = performance.now();
  let reply;
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        ...(noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: JSON.stringify(evidence) },
        ],
      }),
    });
    result.httpStatus = response.status;
    failure = "http";
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("HTTP");
    }
    failure = "response-json";
    reply = await response.json();
  } finally {
    result.wallMs = Math.round(performance.now() - started);
  }

  failure = "grade";
  const choice = reply?.choices?.[0];
  result.modelMatches = reply?.model === model;
  result.finishReason = ["stop", "length", "content_filter"].includes(choice?.finish_reason)
    ? choice.finish_reason : null;
  result.usage = Object.fromEntries(["prompt_tokens", "completion_tokens", "total_tokens"].map((key) => {
    const value = reply?.usage?.[key];
    return [key, Number.isSafeInteger(value) && value >= 0 ? value : null];
  }));
  result.assertions = grade(choice?.message?.content, expected);
  const { checks, ...otherAssertions } = result.assertions;
  result.passed = result.modelMatches && result.finishReason === "stop"
    && [...Object.values(checks), ...Object.values(otherAssertions)].every(Boolean);
} catch {
  // Only fixed labels enter the receipt. Exceptions can contain sensitive data.
}
if (!result.passed) result.failure = failure;
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
