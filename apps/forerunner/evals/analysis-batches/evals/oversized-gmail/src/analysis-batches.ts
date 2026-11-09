// Starting behavior extracted from semanticProposal at 5563bf1d: one request for all evidence.
export type AnalysisInput = {
  evidence: { ref: string; title: string; excerpt: string }[];
  existing: { id: string; name: string; type: string }[];
  limits: string;
};
export function analysisBatches(input: AnalysisInput): AnalysisInput[] {
  return [input];
}
