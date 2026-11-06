import type { AppIdentity } from "@ai-outfitter/app-sdk/server";

/** One prepared statement of an atomic batch. */
export type Statement = { sql: string; params?: unknown[] };
/** D1 prepared batches and libSQL write batches: every statement applies or none do. */
export type BatchDatabase = {
  query(statement: Statement): Promise<Record<string, unknown>[]>;
  batch(statements: Statement[]): Promise<unknown>;
};
export type ProposalStatus =
  "pending" | "applied" | "rejected" | "cancelled" | "uncertain";
export type ProposalRow = {
  id: string;
  installationId: string;
  ownerId: string;
  threadId: string;
  turnId: string | null;
  requestKey: string;
  payloadDigest: string;
  action: string;
  projectId: string | null;
  revision: number;
  status: ProposalStatus;
  data: string;
  receipt: string | null;
  decidedBy: string | null;
  timelineEntryId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};
/** Decided statuses whose receipts survive conversation deletion. */
export const retainedStatuses = ["applied", "uncertain", "rejected"] as const;

/** Field order is not evidence: equal values produce equal digests. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
export async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJSON(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const changed = () =>
  new Response(
    "Changed or invalid records. Review again; your draft is preserved.",
    { status: 409 },
  );

/**
 * App-owned reviewed proposals and decision receipts. Every read is scoped to
 * the installation and the requesting member, independent of any conversation:
 * a member who can read an organization-shared transcript still cannot review
 * or approve another member's proposal.
 */
export class ProposalStore {
  constructor(
    readonly db: BatchDatabase,
    readonly identity: Pick<AppIdentity, "installationId" | "userId">,
    readonly names: { table: string; guard: string },
  ) {
    for (const name of Object.values(names))
      if (!/^[a-z][a-z0-9_]*$/.test(name))
        throw new Error("Invalid proposal table name");
  }
  get table() {
    return this.names.table;
  }
  get guardTable() {
    return this.names.guard;
  }
  /** In-batch assertion; a false condition aborts the entire batch. */
  guard(condition: string, params: unknown[] = []): Statement {
    return {
      sql: `INSERT INTO ${this.guardTable}(value) VALUES(CASE WHEN (${condition}) THEN 1 ELSE 0 END)`,
      params,
    };
  }
  async atomic(steps: Statement[]) {
    try {
      await this.db.batch([
        ...steps,
        { sql: `DELETE FROM ${this.guardTable}` },
      ]);
    } catch (error) {
      for (let e = error; e instanceof Error; e = e.cause as Error)
        if (/constraint|CHECK/i.test(e.message)) throw changed();
      throw error;
    }
  }
  private async first(sql: string, params: unknown[]) {
    return (await this.db.query({ sql, params }))[0] as ProposalRow | undefined;
  }
  /** The member's own proposal in this installation, or 404. */
  async get(id: string) {
    const row = await this.first(
      `SELECT * FROM ${this.table} WHERE id=? AND installationId=? AND ownerId=?`,
      [id, this.identity.installationId, this.identity.userId],
    );
    if (!row) throw new Response("Proposal not found", { status: 404 });
    return row;
  }
  /** The member's latest proposals in one conversation, oldest first. */
  async forThread(threadId: string, limit = 50) {
    const rows = (await this.db.query({
      sql: `SELECT * FROM ${this.table} WHERE installationId=? AND ownerId=? AND threadId=? ORDER BY rowid DESC LIMIT ?`,
      params: [
        this.identity.installationId,
        this.identity.userId,
        threadId,
        limit,
      ],
    })) as ProposalRow[];
    return rows.reverse();
  }
  /** Owner-scoped unresolved receipts remain discoverable after their thread is deleted. */
  async unresolved(limit = 50) {
    return (await this.db.query({
      sql: `SELECT * FROM ${this.table} WHERE installationId=? AND ownerId=? AND status='uncertain' ORDER BY rowid DESC LIMIT ?`,
      params: [this.identity.installationId, this.identity.userId, limit],
    })) as ProposalRow[];
  }
  /**
   * Save a proposal under a stable request key. An exact replay (same key and
   * payload) returns the existing proposal; reusing the key for a different
   * payload is a conflict and changes nothing.
   */
  async create(input: {
    threadId: string;
    turnId?: string;
    requestKey: string;
    action: string;
    projectId?: string | null;
    data: unknown;
    /** The payload that identifies the request; defaults to `data`. */
    identity?: unknown;
  }) {
    const payloadDigest = await digest({
      threadId: input.threadId,
      action: input.action,
      payload: input.identity ?? input.data,
    });
    const existing = await this.first(
      `SELECT * FROM ${this.table} WHERE installationId=? AND requestKey=?`,
      [this.identity.installationId, input.requestKey],
    );
    if (existing) {
      if (
        existing.ownerId !== this.identity.userId ||
        existing.payloadDigest !== payloadDigest
      )
        throw new Response(
          "This request was already used for another proposal",
          {
            status: 409,
          },
        );
      return existing;
    }
    const id = crypto.randomUUID(),
      now = Date.now();
    await this.db.batch([
      {
        sql: `INSERT INTO ${this.table}(id,installationId,ownerId,threadId,turnId,requestKey,payloadDigest,action,projectId,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(installationId,requestKey) DO NOTHING`,
        params: [
          id,
          this.identity.installationId,
          this.identity.userId,
          input.threadId,
          input.turnId ?? null,
          input.requestKey,
          payloadDigest,
          input.action,
          input.projectId ?? null,
          JSON.stringify(input.data),
          now,
          now,
        ],
      },
    ]);
    // A concurrent identical request may have won the insert; re-read by key.
    const saved = await this.first(
      `SELECT * FROM ${this.table} WHERE installationId=? AND requestKey=?`,
      [this.identity.installationId, input.requestKey],
    );
    if (
      !saved ||
      saved.ownerId !== this.identity.userId ||
      saved.payloadDigest !== payloadDigest
    )
      throw new Response("This request was already used for another proposal", {
        status: 409,
      });
    return saved;
  }
  async revise(id: string, revision: number, data: unknown) {
    await this.get(id);
    await this.atomic([
      this.guard(
        `EXISTS(SELECT 1 FROM ${this.table} WHERE id=? AND installationId=? AND ownerId=? AND revision=? AND status='pending')`,
        [id, this.identity.installationId, this.identity.userId, revision],
      ),
      {
        sql: `UPDATE ${this.table} SET data=?,revision=revision+1,updatedAt=? WHERE id=?`,
        params: [JSON.stringify(data), Date.now(), id],
      },
    ]);
    return this.get(id);
  }
  /**
   * Decide a pending proposal in ONE batch: the proposal guard, the caller's
   * domain guards and writes, and the receipt commit or roll back together.
   * A replay of the same decision at the same revision returns the original
   * receipt without repeating any write.
   */
  async decide(
    id: string,
    revision: number,
    steps: Statement[],
    receipt: unknown,
    status: Exclude<ProposalStatus, "pending" | "cancelled"> = "applied",
  ) {
    const row = await this.get(id);
    const replay = this.replay(row, revision, status);
    if (replay) return replay;
    await this.atomic([
      this.guard(
        `EXISTS(SELECT 1 FROM ${this.table} WHERE id=? AND installationId=? AND ownerId=? AND revision=? AND status='pending')`,
        [id, this.identity.installationId, this.identity.userId, revision],
      ),
      ...steps,
      {
        sql: `UPDATE ${this.table} SET status=?,receipt=?,decidedBy=?,updatedAt=? WHERE id=?`,
        params: [
          status,
          JSON.stringify(receipt),
          this.identity.userId,
          Date.now(),
          id,
        ],
      },
    ]);
    return this.get(id);
  }
  /** The committed row for an exact duplicate decision, else undefined (or 409). */
  replay(row: ProposalRow, revision: number, status: ProposalStatus) {
    if (row.status === "pending") return undefined;
    if (row.status === status && Number(row.revision) === revision) return row;
    throw new Response(
      row.status === "cancelled"
        ? "This proposal was cancelled with its conversation"
        : "Proposal is no longer pending",
      { status: 409 },
    );
  }
  /**
   * The conversation was deleted: cancel every pending proposal it holds, for
   * any member. Applied, uncertain and rejected receipts are retained.
   */
  async cancelThread(threadId: string, reason = "conversation deleted") {
    await this.db.batch([
      {
        sql: `UPDATE ${this.table} SET status='cancelled',receipt=?,updatedAt=? WHERE installationId=? AND threadId=? AND status='pending'`,
        params: [
          JSON.stringify({ cancelled: true, reason }),
          Date.now(),
          this.identity.installationId,
          threadId,
        ],
      },
    ]);
  }
  /** Decided proposals whose timeline entry has not been recorded yet. */
  async unsynced(threadId?: string, limit = 20) {
    return (await this.db.query({
      sql: `SELECT * FROM ${this.table} WHERE installationId=? AND ownerId=? AND status IN ('applied','rejected','uncertain') AND timelineEntryId IS NULL${threadId ? " AND threadId=?" : ""} ORDER BY updatedAt LIMIT ?`,
      params: [
        this.identity.installationId,
        this.identity.userId,
        ...(threadId ? [threadId] : []),
        limit,
      ],
    })) as ProposalRow[];
  }
  async markSynced(
    id: string,
    entryId: string,
    expected?: Pick<ProposalRow, "revision" | "status">,
  ) {
    await this.db.batch([
      {
        sql: `UPDATE ${this.table} SET timelineEntryId=? WHERE id=? AND installationId=? AND timelineEntryId IS NULL${expected ? " AND revision=? AND status=?" : ""}`,
        params: [
          entryId,
          id,
          this.identity.installationId,
          ...(expected ? [expected.revision, expected.status] : []),
        ],
      },
    ]);
  }
}
