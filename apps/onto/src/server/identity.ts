import { and, eq, sql } from "drizzle-orm";
import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
type Database = ReturnType<typeof installationDatabase>;
import { graphNodes, graphTypes } from "./schema";

const provider = "outfitter-principal";
const active = () =>
  and(eq(graphNodes.archived, false), eq(graphTypes.archived, false));
const kind = (type: string) =>
  type === "Agent" ? ("agent" as const) : ("human" as const);
const holderType = (type: string) => type === "Person" || type === "Agent";
function rows(db: Database) {
  return db
    .select({
      id: graphNodes.id,
      holderId: graphNodes.id,
      principalId: graphNodes.externalId,
      type: graphTypes.name,
    })
    .from(graphNodes)
    .innerJoin(graphTypes, eq(graphTypes.id, graphNodes.typeId))
    .where(and(active(), eq(graphNodes.externalProvider, provider)));
}

/** Private canonical identity, selected by the host's verified principal/ref.
 * Public graph properties, titles, authored bodies and provenance are never identities. */
export async function resolveIdentity(
  db: Database,
  input: { principalId: string; reference?: EntityRef },
) {
  const { principalId, reference } = input;
  const linked = (await rows(db)).filter(
    (row) => row.principalId === principalId && holderType(row.type),
  );
  const sourced = reference
    ? await db
        .select({ id: graphNodes.id, type: graphTypes.name })
        .from(graphNodes)
        .innerJoin(graphTypes, eq(graphTypes.id, graphNodes.typeId))
        .where(
          and(
            active(),
            sql`json_extract(${graphNodes.source}, '$.installationId')=${reference.installationId}`,
            sql`json_extract(${graphNodes.source}, '$.type')=${reference.type}`,
            sql`json_extract(${graphNodes.source}, '$.id')=${reference.id}`,
          ),
        )
    : [];
  // Both are verified identity evidence. A source reference must not hide an
  // existing private principal link; conflicting holders remain blocked.
  const matches = [
    ...new Map([...linked, ...sourced].map((row) => [row.id, row])).values(),
  ];
  if (matches.length > 1 || matches.some((row) => !holderType(row.type)))
    throw new Response("Ambiguous or invalid canonical identity", {
      status: 409,
    });
  const row = matches[0];
  return row ? { holderId: row.id, principalId, kind: kind(row.type) } : null;
}
export async function listIdentities(db: Database, who: AppIdentity) {
  requireEditor(who);
  return (await rows(db))
    .filter((row) => holderType(row.type))
    .map((row) => ({
      id: row.id,
      holderId: row.id,
      principalId: String(row.principalId),
      kind: kind(row.type),
    }));
}
export async function unlinkIdentity(
  db: Database,
  who: AppIdentity,
  holderId: string,
) {
  requireEditor(who);
  await db
    .update(graphNodes)
    .set({ externalProvider: null, externalId: null })
    .where(
      and(
        eq(graphNodes.id, holderId),
        eq(graphNodes.externalProvider, provider),
      ),
    );
  return { removed: true };
}
export async function linkIdentity(
  db: Database,
  who: AppIdentity,
  input: { holderId: string; principalId: string; kind: "human" | "agent" },
) {
  requireEditor(who);
  const [holder] = await db
    .select({ type: graphTypes.name, provider: graphNodes.externalProvider })
    .from(graphNodes)
    .innerJoin(graphTypes, eq(graphTypes.id, graphNodes.typeId))
    .where(and(active(), eq(graphNodes.id, input.holderId)));
  if (holder?.type !== (input.kind === "human" ? "Person" : "Agent"))
    throw new Response("Identity type mismatch", { status: 409 });
  if (holder.provider && holder.provider !== provider)
    throw new Response(
      "Preserve the existing provider identity; use its verified canonical reference",
      { status: 409 },
    );
  // One principal identifies one canonical holder throughout this Wiki. This
  // does not create any assignments, RAPID duties, or platform permissions.
  await db.batch([
    db
      .update(graphNodes)
      .set({ externalProvider: null, externalId: null })
      .where(
        and(
          eq(graphNodes.externalProvider, provider),
          eq(graphNodes.externalId, input.principalId),
        ),
      ),
    db
      .update(graphNodes)
      .set({ externalProvider: provider, externalId: input.principalId })
      .where(eq(graphNodes.id, input.holderId)),
  ]);
  return { linked: true };
}
