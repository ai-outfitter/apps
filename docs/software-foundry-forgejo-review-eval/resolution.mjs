import { appendFileSync } from "node:fs";

function log(name, entry) {
  appendFileSync(`/out/${name}.jsonl`, JSON.stringify(entry) + "\n");
}

export async function resolve(req, res) {
  if (req.method !== "POST" || req.url !== "/resolve") return res.writeHead(404).end();
  const body = Buffer.concat(await Array.fromAsync(req));
  const { principal } = JSON.parse(body);
  const response = await fetch("http://127.0.0.1:8787/api/internal/inference/resolve", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(9_000),
    headers: { authorization: req.headers.authorization, "content-type": "application/json" }, body,
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch {}
  log("resolution", { principal, status: response.status,
    providers: data?.providers?.map(provider => provider.name) ?? [] });
  return res.writeHead(response.status, { "content-type": "application/json" }).end(raw);
}

export function decoy(req, res) {
  log("decoy", { method: req.method, path: req.url });
  return res.writeHead(503).end("Alternate fixture provider should receive zero calls");
}
