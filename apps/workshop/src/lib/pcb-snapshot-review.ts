import type { PcbSnapshot } from "./pcb-snapshot";
import { pcbReviewArtifact } from "./pcb-review";

/** Select exactly the requested imported record, or the latest import. */
export function resolvePcbSnapshot(snapshots: readonly PcbSnapshot[] | undefined, requested?: string | null) {
  const snapshot = requested ? snapshots?.find(s => s.id === requested) : snapshots?.at(-1);
  if (!snapshot) throw Error(requested ? "The requested PCB snapshot was not found." : "No PCB snapshot has been imported.");
  const review = pcbReviewArtifact(snapshot.manifest.artifacts);
  if (!review || review.path !== snapshot.reviewPath) throw Error("The imported snapshot has no matching PCB review record.");
  return { snapshot, review, current: snapshot.id === snapshots?.at(-1)?.id };
}
