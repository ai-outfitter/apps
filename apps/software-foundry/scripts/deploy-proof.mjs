import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Deliberately fixed target: branch proof must not upgrade other installations. */
export async function deployFoundryProof(expectedHash, { token = process.env.DEMO_DEPLOY_KEY, request = fetch } = {}) {
  if (!token) throw new Error("Missing DEMO_DEPLOY_KEY");
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? "")) throw new Error("Invalid Foundry package hash");
  const response = await request("https://ai-outfitter.com/api/internal/app-upgrades/outfitter/software-foundry", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(300000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedHash }),
  });
  if (!response.ok) throw new Error(`Foundry upgrade failed: HTTP ${response.status}`);
  const receipt = await response.json();
  if (!receipt || receipt.organization !== "outfitter" || receipt.template !== "software-foundry" ||
      receipt.hash !== expectedHash || receipt.mode !== "operational" ||
      receipt.url !== "https://software-foundry.outfitter.ai-outfitter.com" ||
      !["unchanged", "deployed"].includes(receipt.status)) throw new Error("Unexpected Foundry upgrade receipt");
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = JSON.parse(await readFile("src/generated/apps/index.json", "utf8"));
  const receipt = await deployFoundryProof(index["software-foundry"]?.operational?.hash);
  // Print only the validated receipt, never the request credential or body of an error.
  console.log(JSON.stringify(receipt));
}
