import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";

export type GraphDatabase = Awaited<ReturnType<ReturnType<typeof appDataContext>["apps"]["installation"]>>;

/** The organization graph's database: Onto, or the legacy Wiki until the organization moves. */
export async function graphDatabase(host: Parameters<typeof defaultWiki>[0] & Parameters<typeof appDataContext>[0]): Promise<GraphDatabase> {
  return appDataContext(host).apps.installation((await defaultWiki(host)).installationId);
}
