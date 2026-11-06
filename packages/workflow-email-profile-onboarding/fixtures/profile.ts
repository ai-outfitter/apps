import type { EmailProfile } from "@ai-outfitter/workflow-email-profile-onboarding/types";
export const emailProfileFixture = {
  whoTheyAre: { summary: "Coordinates a small product team.", organization: "Sample Studio" },
  suspectedRole: { title: "Product lead", confidence: "medium", reasoning: "Frequent planning and customer conversations." },
  writingStyle: { summary: "Brief and direct in the sampled sent messages.", traits: ["Concise", "Action-oriented"], confidence: "low" },
  suggestedWorkflows: [
    { title: "Prepare a customer follow-up", description: "Draft next steps after customer email.", trigger: "After a customer conversation", steps: ["Summarize the discussion", "Draft a reply for review"], whyUseful: "Customer follow-ups recur in the sample." },
    { title: "Weekly planning digest", description: "Collect unresolved planning decisions.", trigger: "Before weekly planning", steps: ["Collect open threads", "Propose a short agenda"], whyUseful: "Planning discussions appear frequently." },
  ],
  suggestedApps: [
    {
      name: "Customer request tracker",
      goal: "Give every customer request one place, an owner and a reply date so none wait on a buried thread.",
      audience: "team",
      persona: { name: "Product team member", need: "See which customer requests are theirs and what is overdue." },
      successMetrics: [
        { name: "Requests answered within two working days", target: "90%", query: "Requests answered within 2 working days of arrival ÷ requests received" },
        { name: "Requests with no owner", target: "0 at the end of each week", query: "Open requests with no owner at the end of the week" },
      ],
      whyUseful: "Customer questions arrive by email and get handed around the team.",
      source: { provider: "gmail", observation: "Customer questions arrive by email and are forwarded between teammates.", volume: null },
      record: { name: "request", fields: ["from", "subject", "received at", "owner", "due by", "status"] },
      operations: ["connector.gmail.messages.list", "connector.gmail.messages.get"],
    },
  ],
} satisfies EmailProfile;
