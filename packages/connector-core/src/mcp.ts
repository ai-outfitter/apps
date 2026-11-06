/**
 * A connector's hosted MCP server: the provider's own tools, reached with a
 * credential the platform mints for one grant. The connector owns the
 * endpoint, the headers that narrow the server, and which tools it allows,
 * each with the provider permission it needs. The platform owns the grant,
 * mints a credential with exactly the permissions the allowed tools need,
 * holds it, and runs every call; agents, residents and apps only ever see
 * tool names and results.
 */
export type ConnectorMcpTool = {
  /** The provider permission the tool needs, e.g. `{ issues: "write" }`. */
  permissions: Readonly<Record<string, "read" | "write">>;
  /** The input fields naming the resource, checked against the grant before every call. */
  resource: readonly string[];
  /** For a tool that commits, the input field naming the branch it commits to. */
  branch?: string;
};

export type ConnectorMcp = {
  /** The hosted server's URL (streamable HTTP). */
  url: string;
  /** Request headers for a credential, including any that narrow the server's tools. */
  headers(credential: string): Record<string, string>;
  /** The tools any consumer may call, by the server's own names. */
  tools: Readonly<Record<string, ConnectorMcpTool>>;
};

/** The permissions the server's allowed tools need, the stronger grant winning. */
export function mcpPermissions(mcp: ConnectorMcp) {
  const permissions: Record<string, "read" | "write"> = {};
  for (const tool of Object.values(mcp.tools))
    for (const [key, level] of Object.entries(tool.permissions))
      if (permissions[key] !== "write") permissions[key] = level;
  return permissions;
}
