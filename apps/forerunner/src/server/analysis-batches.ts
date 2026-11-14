/** The host measures serialized JS string length. Leave room below its 64 KiB ceiling. */
export const analysisDataBudget = 56 * 1024;
export type AnalysisInput = {
  evidence: { ref: string; title: string; excerpt: string }[];
  existing: { id: string; name: string; type: string }[];
  limits: string;
};

/** Preserve whole excerpts and global refs; repeat trusted identity and Wiki context per call. */
export function analysisBatches(input: AnalysisInput, budget = analysisDataBudget): AnalysisInput[] {
  if (!Number.isInteger(budget) || budget < 1 || budget > analysisDataBudget) throw new Error("Batch budget must fit the host request budget");
  const identity = input.evidence.filter(e => e.ref === "operating-user");
  const records = input.evidence.filter(e => e.ref !== "operating-user");
  const batches: AnalysisInput[] = [];
  const make = (evidence: AnalysisInput["evidence"]): AnalysisInput => ({ ...input, evidence: [...evidence, ...identity] });
  let current = make([]);
  if (JSON.stringify(current).length > budget) throw new Error("Analysis context exceeds the request budget");
  for (const record of records) {
    const next = make([...current.evidence.filter(e => e.ref !== "operating-user"), record]);
    if (JSON.stringify(next).length <= budget) { current = next; continue; }
    if (current.evidence.length > identity.length) batches.push(current);
    current = make([record]);
    if (JSON.stringify(current).length > budget) throw new Error("A source record exceeds the analysis request budget");
  }
  if (current.evidence.length > identity.length || !batches.length) batches.push(current);
  return batches;
}
