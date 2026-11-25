import { createServer, request } from "node:http";
import { chmodSync, readFileSync, rmSync } from "node:fs";

const [socket, authFile, port] = process.argv.slice(2);
if (!socket || !authFile || !/^\d+$/.test(port)) throw new Error("Expected socket, broker auth file and loopback broker port");
const authorization = "Bearer " + readFileSync(authFile, "utf8").trim();
const routes = new Set(["GET /v1/models", "POST /v1/chat/completions"]);

const server = createServer((incoming, outgoing) => {
  if (!routes.has(incoming.method + " " + incoming.url)) {
    outgoing.writeHead(404).end();
    incoming.resume();
    return;
  }
  const headers = { authorization };
  if (incoming.headers["content-type"]) headers["content-type"] = incoming.headers["content-type"];
  const upstream = request({
    hostname: "127.0.0.1",
    port,
    method: incoming.method,
    path: incoming.url,
    headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode, { "content-type": response.headers["content-type"] ?? "application/json" });
    response.pipe(outgoing);
  });
  upstream.on("error", () => {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502).end();
  });
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
});
server.listen(socket, () => chmodSync(socket, 0o666));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    rmSync(socket, { force: true });
    process.exit(0);
  });
}
