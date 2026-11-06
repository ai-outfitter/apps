/** The organization's draft policy for agent pull requests, as one sentence. */
export function draftPolicyText(connection) {
  if (!connection) return "Connect GitHub to view the draft policy.";
  return connection.draftPullRequests === false
    ? "Off: agents open pull requests ready for review unless more work is expected."
    : "On: agents open draft pull requests by default and may open one ready when it should be reviewed now.";
}
