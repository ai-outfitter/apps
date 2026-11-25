import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import { listenBridge } from "./chat-bridge.mjs";
import { createNativeProvider, privateDirectory } from "./native-pi.mjs";

try {
  const { values } = parseArgs({ options: {
    consent: { type: "string" }, "auth-dir": { type: "string" }, "runtime-dir": { type: "string" },
    "run-dir": { type: "string" }, model: { type: "string" }, port: { type: "string", default: "0" },
  } });
  if (values.consent !== "subtract-helper" || !values.model || !/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535)
    throw Error("Explicit consent for subtract-helper, a native model, and a valid port are required");
  const runDir = await privateDirectory(values["run-dir"]);
  const authDir = await privateDirectory(values["auth-dir"]);
  const runtimeDir = await privateDirectory(values["runtime-dir"]);
  const directories = [authDir, runtimeDir, runDir];
  if (directories.some((left, index) => directories.some((right, other) =>
    index !== other && (left === right || left.startsWith(right + sep)))))
    throw Error("Keep local auth, runtime, and per-run secret in separate directories");
  const provider = await createNativeProvider({ runtimeDir, authDir, model: values.model });
  const secret = randomBytes(32).toString("hex");
  const secretPath = join(runDir, "gateway-bearer");
  await writeFile(secretPath, secret + "\n", { mode: 0o600, flag: "wx" });
  try {
    const broker = await listenBridge({ provider, model: values.model, secret, port: Number(values.port) });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, broker.close);
    process.once("beforeExit", () => { void unlink(secretPath).catch(() => {}); });
    console.log(JSON.stringify({ url: broker.url, bearerFile: secretPath, fixture: "subtract-helper", model: values.model }));
  } catch {
    await unlink(secretPath);
    throw Error("Listen failed");
  }
} catch {
  // Native providers and storage may include credentials in diagnostics.
  console.error("Broker startup refused. Check the explicit consent, pinned Pi runtime, private auth/run directories, native model, and port.");
  process.exitCode = 1;
}
