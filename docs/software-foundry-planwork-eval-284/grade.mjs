import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function hasMatchingMeter(request, response, runId, usage) {
  if (!runId || !request || !response || request.runId !== runId || response.runId !== runId
    || request.attempt !== 1 || response.attempt !== request.attempt
    || request.model !== response.model || response.status !== 200 || response.finishReason !== "stop") return false;

  const rows = usage.filter(row => row.workloadKind === "workflow" && row.workloadId === runId
    && row.attempt === request.attempt);
  if (rows.length !== 1) return false;
  const [row] = rows;
  const tokens = response.usage;
  return row.requestKey?.startsWith(`workflow:${runId}:app:`) === true
    && row.providerKind === "outfitter" && row.attemptStatus === "completed" && row.httpStatus === 200
    && row.model === response.model && tokens?.prompt_tokens > 0 && tokens?.completion_tokens > 0
    && row.inputTokens === tokens.prompt_tokens && row.outputTokens === tokens.completion_tokens
    && row.totalTokens === tokens.total_tokens && tokens.total_tokens === tokens.prompt_tokens + tokens.completion_tokens;
}

function grade(out, arm, boxExit) {
  const path = name => join(out, name);
  const report = existsSync(path("report.json")) ? JSON.parse(readFileSync(path("report.json"), "utf8")) : {};
  const events = existsSync(path("provider.jsonl")) ? readFileSync(path("provider.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const requests = events.filter(entry => entry.event === "request");
  const completions = events.filter(entry => entry.event === "response");
  const [request] = requests;
  const [completion] = completions;
  const closed = events.find(entry => entry.event === "client-closed" && entry.runId === request?.runId
    && entry.attempt === request?.attempt);
  const run = report.runs?.find(item => item.id === request?.runId);
  const checks = {
    boxExitedCleanly: boxExit === "0",
    noForgejoPublication: report.checks?.noForgejoPublication === true,
  };

  if (arm === "interrupted") {
    checks.zeroProviderRequests = events.length === 0;
    checks.interruptedCollection = report.checks?.interruptedCollection === true
      && ["typed", "draft", "divergent"].every(name => report.interrupted?.[name]?.slotUnchanged);
    return checks;
  }
  checks.oneControlledProviderRequest = requests.length === 1 && request?.attempt === 1 && Boolean(run);

  if (arm === "short" || arm === "cancel") {
    checks.providerClosed = completions.length === 0 && Boolean(closed);
    if (arm === "short") {
      checks.explicitPinnedStepDeadline = run?.stepInference?.timeoutMs === 1500
        && report.attempts?.[0]?.receipt?.run?.id === run?.id;
      checks.shortOverride = report.checks?.shortStepDeadline === true
        && closed?.durationMs >= 500 && closed.durationMs < 5000;
    } else {
      checks.clientCancellationReachedProvider = report.checks?.clientCancellationReachedProvider === true;
    }
    return checks;
  }

  const { runId, artifactSha256 } = report.planWork ?? {};
  const artifact = report.checks?.artifact;
  const planBytes = existsSync(path("plan.json")) ? readFileSync(path("plan.json")) : null;
  checks.verifiedArtifact = Boolean(runId && run?.id === runId && artifact?.runId === runId
    && artifact.sha256 === artifactSha256 && planBytes
    && createHash("sha256").update(planBytes).digest("hex") === artifactSha256);
  checks.matchingProductMeter = completions.length === 1
    && hasMatchingMeter(request, completion, runId, report.usage ?? []);
  if (arm === "legacy") {
    checks.legacyRecovery = report.checks?.legacyRecovery === true;
    checks.verifiedDenials = ["deniedCoverage", "missingUsage", "pending", "mixed", "missingReceipt", "contradictoryReceipt", "runningLegacy"]
      .every(name => report.legacy?.[name] === true);
    checks.lostCollectRepaired = Boolean(report.legacy?.lostCollect);
  } else if (arm === "uncertainty") {
    checks.reconciledReadOnly = report.checks?.uncertainPublicationReconciledReadOnly === true;
  } else if (arm === "delayed") {
    checks.delayedSuccessOver100Seconds = completion?.providerDurationMs > 100_000;
  } else {
    throw new Error("Unknown offline case");
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, arm, boxExit] = process.argv.slice(2);
  const checks = grade(out, arm, boxExit);
  const passed = Object.values(checks).every(Boolean);
  writeFileSync(join(out, "grade.json"), JSON.stringify({ arm, boxExit: Number(boxExit), passed, checks }, null, 2) + "\n");
  process.exitCode = passed ? 0 : 1;
}
