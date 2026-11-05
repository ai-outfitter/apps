import { readText, readBytes } from "./http";

const encoder = new TextEncoder();
const MAX_AGE = 30_000;
async function signingKey(secret: string) {
  if (secret.length < 32) throw new Error("Connector broker key is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const content = (timestamp: string, body: string | Uint8Array) => {
  const prefix = encoder.encode(`connector-broker.v1\nPOST\n/rpc\n${timestamp}\n`);
  const payload = typeof body === "string" ? encoder.encode(body) : body;
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix); signed.set(payload, prefix.length);
  return signed;
};

/** Internal transport only. Callers reload current connection access before signing. */
export async function brokerRequest(body: unknown, secret: string, now = Date.now()) {
  const encoded = JSON.stringify(body);
  const timestamp = String(now);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), content(timestamp, encoded)));
  return new Request("https://connector-broker.internal/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-outfitter-broker-time": timestamp,
      "x-outfitter-broker-signature": [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""),
    },
    body: encoded,
  });
}

export async function authenticatedBrokerBody(request: Request, secret: string, now = Date.now()): Promise<unknown> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc")
    throw new Response("Not found", { status: 404 });
  const timestamp = request.headers.get("x-outfitter-broker-time") ?? "";
  const signature = request.headers.get("x-outfitter-broker-signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > MAX_AGE || !/^[a-f0-9]{64}$/.test(signature))
    throw new Response("Broker authentication required", { status: 401 });
  const body = await readBytes(request, 2 * 1024 * 1024);
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (value) => parseInt(value, 16));
  if (!await crypto.subtle.verify("HMAC", await signingKey(secret), bytes, content(timestamp, body)))
    throw new Response("Broker authentication required", { status: 401 });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new Response("Invalid broker request", { status: 400 }); }
}


/** The platform talks only to this transport; no provider code loads here. */
export function brokerClient(transport: (request: Request) => Promise<Response>, secret: string, credentials: (body: unknown) => unknown = (body) => body) {
  return async (body: unknown): Promise<unknown> => {
    const response = await transport(await brokerRequest(credentials(body), secret));
    if (!response.ok) throw new Response("Connector request failed", { status: [401, 404].includes(response.status) ? 503 : response.status });
    return JSON.parse(await readText(response, 2 * 1024 * 1024));
  };
}
