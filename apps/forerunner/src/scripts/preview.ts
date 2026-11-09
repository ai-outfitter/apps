/** A discovery run as the run page reads it from the activity endpoint. */
export type Preview = {
  version?: number;
  systemPrompt: string;
  warnings?: string[];
  id: string;
  createdAt: string;
  destination: string;
  wikiSlug: string;
  sources: {
    label: string;
    count: number;
    method: string;
    window: string;
    error?: string;
  }[];
  entries: {
    id?: string;
    typeId?: string;
    /** Exact namespaced answer keys that resolve to this entry; absent on older previews. */
    modelKeys?: string[];
    matchedId?: string;
    matchedTitle?: string;
    title: string;
    kind: string;
    existing: boolean;
    excerpt: string;
    url?: string;
  }[];
  operations: unknown[];
  /** Every record the model read, under the ref its answer cites. Older runs have none. */
  inputs?: { ref: string; provider: string; account: string; subject: string; date: string; participants: string[]; excerpt: string; url?: string }[];
  savedAt?: string;
  evaluations?: {
    id: string;
    at: string;
    rating: string;
    note: string;
    entryIndex?: number;
    targetId?: string;
  }[];
  /** The Wiki change batch this run was saved into. */
  batch?: { installationId: string; batchId: string; policy: "first-run" | "confidence" };
  /** A batch save: what committed and what still waits for review. Older runs hold graph.apply receipts. */
  receipt?: { batchId?: string; state?: string; reviewBy?: number | null; counts?: Record<string, number>; waiting?: string[] } & Record<string, unknown>;
};
