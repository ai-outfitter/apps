// Enable Foundry execution for one repository in the Outfitter organization:
// approve its role bindings and issue subscription (operator `configure`), then
// read back the result (`inspect`). Safe to repeat; it never resets the repository.
import { pathToFileURL } from "node:url";
import { kubernetesGatewayToken, platformClient } from "./playground.mjs";

const usage = "Usage: npm run configure-repository --workspace @ai-outfitter/app-software-foundry -- OWNER/NAME [--gateway-token-from-kubernetes]";

export async function configureRepository({ repository, gatewayToken, request = fetch }) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw Error(usage);
  const platform = platformClient(gatewayToken, request, repository);
  const configured = await platform("configure");
  const inspection = await platform("inspect");
  if (!inspection?.configurationValid || inspection.reviewer?.login !== "vega-unsup")
    throw Error(`Foundry configuration for ${repository} is not valid: ${JSON.stringify(inspection)}`);
  return { configured, inspection };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const repository = args.find((arg) => !arg.startsWith("--"));
    const gatewayToken = args.includes("--gateway-token-from-kubernetes") ? kubernetesGatewayToken() : process.env.WORKSPACE_GATEWAY_TOKEN;
    console.log(JSON.stringify(await configureRepository({ repository, gatewayToken }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
