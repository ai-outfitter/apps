// Keep each released definition immutable. Existing requests execute their pinned
// transition table when a later package becomes the default for new requests.
export const hiring = {
  version: "0.1.0",
  transitions: [
    {
      from: "awaiting_approval",
      action: "approve",
      by: "approver",
      to: "research_blocked",
    },
    {
      from: "awaiting_approval",
      action: "request_changes",
      by: "approver",
      to: "changes_requested",
    },
    {
      from: "awaiting_approval",
      action: "reject",
      by: "approver",
      to: "rejected",
    },
    {
      from: "changes_requested",
      action: "resubmit",
      by: "requester",
      to: "awaiting_approval",
    },
    {
      from: "awaiting_approval",
      action: "cancel",
      by: "requester",
      to: "cancelled",
    },
    {
      from: "changes_requested",
      action: "cancel",
      by: "requester",
      to: "cancelled",
    },
    {
      from: "research_blocked",
      action: "cancel",
      by: "requester",
      to: "cancelled",
    },
  ],
  steps: [
    {
      id: "intake",
      name: "Submit a staffing need",
      actor: "Requester",
      evidence: "Role, responsibilities and expected outcomes",
      available: true,
    },
    {
      id: "approval",
      name: "Review the staffing request",
      actor: "Assigned human approver",
      evidence: "Decision on the exact request revision; no self-approval",
      available: true,
    },
    {
      id: "research",
      name: "Research candidates",
      actor: "Research agent",
      evidence: "Candidates and permitted source references",
      available: false,
    },
    {
      id: "campaign",
      name: "Approve an outreach campaign",
      actor: "Human approver",
      evidence: "Approved criteria, messaging, sender and operating limits",
      available: false,
    },
    {
      id: "outreach",
      name: "Contact candidates and coordinate interviews",
      actor: "Agent within approved campaign",
      evidence: "Email receipts and candidate replies; Gmail first",
      available: false,
    },
    {
      id: "interviews",
      name: "Interview and decide",
      actor: "Human interviewers and hiring approver",
      evidence: "Interview evaluations and a separate hiring decision",
      available: false,
    },
    {
      id: "offer",
      name: "Approve terms and receive acceptance",
      actor: "Human offer approver and candidate",
      evidence: "Approved offer revision and candidate acceptance",
      available: false,
    },
    {
      id: "enrollment",
      name: "Verify employee enrollment",
      actor: "Human enrolls; connector verifies",
      evidence:
        "Correlated Rippling employee enabled and enrollment communication observed",
      available: false,
    },
  ],
} as const;

export const hiringDefinitions: Record<string, typeof hiring> = {
  [hiring.version]: hiring,
};

export type HiringState =
  | "awaiting_approval"
  | "changes_requested"
  | "research_blocked"
  | "rejected"
  | "cancelled";
export const stateLabels: Record<HiringState, string> = {
  awaiting_approval: "Awaiting approval",
  changes_requested: "Changes requested",
  research_blocked: "Approved · research unavailable",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
