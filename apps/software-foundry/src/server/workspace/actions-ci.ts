import { z } from "zod";
import type { ChangeReceipt, CheckReceipt } from "./forge";

export const githubActionsAppId = 15368;
type API = (path: string) => Promise<any>;
const waiting = (message: string) => new Response(message, { status: 425 });

/** Only exact-commit results from GitHub Actions satisfy the configured gates. */
export async function actionsChecks(api: API, repository: string, candidate: ChangeReceipt, names: string[]) {
  const result = await api(`/repos/${repository}/commits/${candidate.headSha}/check-runs?per_page=100`);
  if (!names.length || result.total_count > 100)
    throw new Response("CI check configuration or history needs attention", { status: 422 });
  return names.map((name): CheckReceipt & { id: number; conclusion: string } => {
    const check = result.check_runs.filter((item: any) =>
      item.name === name && item.app?.id === githubActionsAppId && item.head_sha === candidate.headSha,
    ).sort((a: any, b: any) => b.id - a.id)[0];
    if (!check || check.status !== "completed") throw waiting("Waiting for current GitHub Actions checks");
    if (["cancelled", "timed_out", "action_required", "stale"].includes(check.conclusion))
      throw new Response(`CI infrastructure needs attention: ${name}`, { status: 422 });
    return { id: check.id, name, headSha: candidate.headSha, passed: check.conclusion === "success", conclusion: check.conclusion, url: check.html_url };
  });
}

/** Preview links are trusted only from the Actions bot's current-revision marker. */
export async function actionsPreview(api: API, repository: string, candidate: ChangeReceipt, request: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  const checks = await actionsChecks(api, repository, candidate, ["preview-links"]);
  if (!checks[0].passed) throw new Response("CI preview publication needs attention", { status: 422 });
  const comments = await api(`/repos/${repository}/issues/${candidate.number}/comments?per_page=100`);
  if (comments.length === 100) throw new Response("Preview history needs attention", { status: 422 });
  const comment = comments.filter((item: any) => item.user?.login === "github-actions[bot]" &&
    item.body?.startsWith("<!-- app-previews -->") && item.body.includes(`Revision: \`${candidate.headSha}\``),
  ).sort((a: any, b: any) => b.id - a.id)[0];
  const targets = [...(comment?.body ?? "").matchAll(/\]\((https:\/\/[a-z0-9-]+\.ai-outfitter\.dev)\)/g)].map((match: any) => match[1]);
  if (!targets.length) {
    if (comment?.body.includes("No application changes to preview."))
      return { headSha: candidate.headSha, check: checks[0], commentId: comment.id, targets, kind: "not-needed" };
    throw waiting("Waiting for current PR preview links");
  }
  // CI selects targets from changed paths: prefer Chat, otherwise inspect its app preview.
  const chat = [...(comment.body as string).matchAll(/\[Chat\]\((https:\/\/[a-z0-9-]+\.ai-outfitter\.dev)\)/g)][0]?.[1];
  const preview = chat ?? targets[0];
  const response = await request(`${preview}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw waiting(`Waiting for reachable PR preview (HTTP ${response.status})`); }
  const health = z.object({ status: z.string(), revision: z.string().optional() }).parse(await response.json());
  if (health.status !== "ok" || health.revision !== candidate.headSha) throw waiting("Waiting for matching preview revision");
  return { headSha: candidate.headSha, check: checks[0], commentId: comment.id, targets, verifiedUrl: preview };
}
