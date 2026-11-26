import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

const relay = createServer((client) => {
  const broker = createConnection("/run/foundry-inference.sock");
  client.pipe(broker).pipe(client);
  client.on("error", () => broker.destroy());
  broker.on("error", () => client.destroy());
  client.on("close", () => broker.destroy());
  broker.on("close", () => client.destroy());
});
await new Promise((resolve, reject) => {
  relay.once("error", reject).listen(18181, "127.0.0.1", resolve);
});
const supervisor = spawn(process.execPath, ["/app/.box/box/supervisor.mjs"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => supervisor.kill(signal));
}
supervisor.on("exit", (code) => process.exit(code ?? 1));
