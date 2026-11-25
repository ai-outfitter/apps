import { createServer, request } from "node:http";
import { once } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

export async function startForgejoRelay({ repository, armPath, lookupFailurePath, receiptPath }) {
  const writes = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, "http://forgejo.localhost");
    const issueWrite = incoming.method === "POST" && /^\/api\/v1\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname);
    const isAnchor = url.pathname === `/api/v1/repos/${repository}/issues`;
    if (incoming.method === "GET" && isAnchor && url.searchParams.has("created_by") && existsSync(lookupFailurePath)) {
      unlinkSync(lookupFailurePath);
      outgoing.writeHead(502, { "content-type": "application/json" }).end('{"message":"Fixture reconciliation read failed"}');
      return;
    }
    const options = { host: "127.0.0.1", port: 3301, path: incoming.url, method: incoming.method, headers: incoming.headers };
    const upstream = request(options, (response) => {
      if (issueWrite) {
        const title = JSON.parse(Buffer.concat(chunks).toString("utf8")).title;
        const loseResponse = response.statusCode === 201 && isAnchor && existsSync(armPath);
        writes.push({ path: incoming.url, title, status: response.statusCode, responseLost: loseResponse });
        writeFileSync(receiptPath, JSON.stringify(writes));
        if (loseResponse) {
          unlinkSync(armPath);
          response.resume();
          outgoing.destroy();
          return;
        }
      }
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      outgoing.writeHead(502).end();
    });
    const chunks = [];
    if (issueWrite) incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.pipe(upstream);
  });
  server.listen(3300, "127.0.0.1");
  await once(server, "listening");
  return server;
}
