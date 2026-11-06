/** Package-owned mapping, not a platform-specific dispatch branch. */
export function engineerContext(lease) {
  if (!["triage", "plan", "implement", "confirm-merge"].includes(lease.nodeId))
    throw new Error("This adapter cannot execute a resident review node");
  const settings = lease.inputs.settings;
  if (
    !settings ||
    typeof settings.engineerProfile !== "string" ||
    !settings.engineerProfile.trim()
  )
    throw new Error("Pinned engineer profile is required");
  const model = settings.model ?? "gpt-6-luna";
  if (
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(model)
  )
    throw new Error("Invalid managed model");
  // The managed workflow owns available model selection. Unknown future model IDs
  // are not mapped back to older defaults or restricted to today's tier aliases.
  return {
    version: 1,
    runId: lease.runId,
    nodeId: lease.nodeId,
    definitionHash: lease.definitionHash,
    model,
    engineerProfile: settings.engineerProfile,
    instructions: lease.instructions,
    inputs: lease.inputs,
    outputs: lease.outputs,
    inference: {
      authentication: "actions-oidc",
      audience: "outfitter-inference",
    },
  };
}
