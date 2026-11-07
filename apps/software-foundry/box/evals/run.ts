// Runs the Software Foundry box evals with Agent Eval: each fixture under
// evals/ goes through the sealed box and is graded by its EVAL.ts.
//
//   node --import tsx apps/software-foundry/box/evals/run.ts [eval ...]
//
// Settings: see runBoxEvals in box/eval/agent.ts.
import { fileURLToPath } from "node:url";
import { runBoxEvals } from "@ai-outfitter/box/eval";

await runBoxEvals(fileURLToPath(new URL(".", import.meta.url)), {
  name: "foundry-box", displayName: "Software Foundry box", image: "outfitter/software-foundry-box:dev",
}, {
  // A fixture without request.json is a feature request made from its PROMPT.md.
  requestFromPrompt(prompt) {
    const [title = "Eval task", ...rest] = prompt.trim().split("\n");
    return {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      kind: "feature",
      title: title.replace(/^#+\s*/, "").slice(0, 200),
      problem: prompt.trim(),
      acceptanceCriteria: [{ id: "eval", text: rest.join("\n").trim() || prompt.trim() }],
      delivery: "pull_request",
    };
  },
  succeeded: (result) => result.status === "landed",
});
