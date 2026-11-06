import agenticEngineer from "../fixtures/hr-role-hiring.agentic-engineer.json";
import softwareEngineer from "../fixtures/hr-role-hiring.software-engineer.json";

// Synthetic UI review records. Never mixed with organization hiring records.
export const roles = [
  {
    id: "machine-learning-lead",
    title: "Machine Learning Team Lead",
    department: "Science & Engineering",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "High",
    status: "Open",
    days: 98,
    process: 7,
    review: 110,
    offer: 0,
    target: "2026-07-14",
    next: "Late by 98 days",
  },
  {
    id: "senior-recruiter",
    title: "Senior Recruiter",
    department: "Operations",
    manager: "Riley Chen",
    owner: "Riley",
    priority: "High",
    status: "Open",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2026-11-13",
    next: "Nobody in process",
  },
  {
    id: "market-lead",
    title: "Market Lead",
    department: "Growth",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "Medium",
    status: "Open",
    days: 60,
    process: 5,
    review: 11,
    offer: 0,
    target: "2026-08-13",
    next: "Late by 60 days",
  },
  {
    id: "head-of-marketing",
    title: "Head of Marketing",
    department: "Experience",
    manager: "Sam Rivera",
    owner: "Sam",
    priority: "Medium",
    status: "Open",
    days: 58,
    process: 3,
    review: 9,
    offer: 0,
    target: "2026-08-15",
    next: "Late by 58 days",
  },
  {
    id: "science-platform-lead",
    title: "Applied Science Platform Lead",
    department: "Science & Engineering",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "Medium",
    status: "Open",
    days: 72,
    process: 3,
    review: 65,
    offer: 0,
    target: "2026-07-20",
    next: "Late by 72 days",
  },
  {
    id: "multimodal-engineer",
    title: "Machine Learning Engineer, Multimodal Modeling",
    department: "Science & Engineering",
    manager: "Sam Rivera",
    owner: "Sam",
    priority: "Medium",
    status: "Open",
    days: 53,
    process: 3,
    review: 155,
    offer: 0,
    target: "2026-08-29",
    next: "Late by 53 days",
  },
  {
    id: "agentic-engineer",
    title: "Member of Technical Staff, Agentic Engineer",
    department: "Science & Engineering",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "Medium",
    status: "Open",
    days: 43,
    process: 6,
    review: 50,
    offer: 0,
    target: "2026-09-09",
    next: "Late by 43 days",
  },
  {
    id: "data-engineer",
    title: "Member of Technical Staff, Data Engineer",
    department: "Science & Engineering",
    manager: "Sam Rivera",
    owner: "Sam",
    priority: "Medium",
    status: "Open",
    days: 25,
    process: 3,
    review: 26,
    offer: 0,
    target: "2026-09-22",
    next: "Late by 25 days",
  },
  {
    id: "recruiter",
    title: "Recruiter",
    department: "Operations",
    manager: "Riley Chen",
    owner: "Riley",
    priority: "Medium",
    status: "Open",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2026-11-13",
    next: "Nobody in process",
  },
  {
    id: "software-engineer",
    title: "Software Engineer",
    department: "Science & Engineering",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "Medium",
    status: "Approved",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2026-11-20",
    next: "Push to Ashby",
  },
  {
    id: "product-designer",
    title: "Product Designer",
    department: "Experience",
    manager: "Sam Rivera",
    owner: "Sam",
    priority: "Medium",
    status: "Approved",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2026-12-01",
    next: "Confirm interview loop",
  },
  {
    id: "operations-lead",
    title: "Operations Lead",
    department: "Operations",
    manager: "Riley Chen",
    owner: "Riley",
    priority: "Medium",
    status: "Approved",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2026-12-15",
    next: "Confirm start date",
  },
  {
    id: "research-engineer",
    title: "Research Engineer",
    department: "Science & Engineering",
    manager: "Alex Morgan",
    owner: "Alex",
    priority: "Medium",
    status: "Planned",
    days: 0,
    process: 0,
    review: 0,
    offer: 0,
    target: "2027-01-15",
    next: "Complete role brief",
  },
];
export const stages = [
  "Recruiter screen",
  "HM screen",
  "CPO screen",
  "Take-home",
  "Onsite",
  "CEO interview",
];
export const steps = [
  { id: "basics", title: "The basics", description: "Let's make it concrete" },
  {
    id: "moc",
    title: "Scorecard (MOC)",
    description: "Mission, outcomes, competencies",
  },
  {
    id: "description",
    title: "Job description",
    description: "The public posting",
  },
  {
    id: "level",
    title: "Level and pay",
    description: "Scope and compensation",
  },
  { id: "interviews", title: "Interview loop", description: "Who tests what" },
  {
    id: "approval",
    title: "Approval",
    description: "Configured human sign-off",
  },
  { id: "publish", title: "Post in Ashby", description: "Last step" },
];
export const automations = [
  {
    group: "Recruiting",
    title: "Ashby sync",
    status: "On",
    description:
      "Pulls jobs, applicants, offers, interview schedules and stage history into our copy. The dashboard and role pages read from here.",
    schedule: "Every night, 09:00 UTC",
    last: "Today, 09:01",
    runs: "30 runs in 30 days",
  },
  {
    group: "Recruiting",
    title: "Onsite alert email",
    status: "Not connected",
    description:
      "When a candidate moves into an onsite stage, notify the hiring manager with the onsite checklist. Once per candidate.",
    schedule: "Every 15 minutes",
    last: "Never run",
    runs: "No live runs",
  },
  {
    group: "Recruiting",
    title: "Duplicate candidate records",
    status: "On",
    description:
      "Find candidate records that may describe the same person. Review the suggested matches; never merge automatically.",
    schedule: "Daily at 09:30 UTC · new records only",
    last: "Today, 09:31",
    runs: "5 matches",
  },
  {
    group: "Recruiting",
    title: "Résumé screener upkeep",
    status: "Manual screening",
    description:
      "Keeps screening records tidy and deletes only what is allowed. Screening itself runs when you ask for it, not on a timer.",
    schedule: "Every night, 09:00 UTC",
    last: "Never run",
    runs: "No live runs",
  },
  {
    group: "Recruiting",
    title: "Juicebox outreach",
    status: "Not connected",
    description:
      "Reads the weekly sourcing numbers so outreach rates can roll up onto roles.",
    schedule: "On demand · weekly sourcing export",
    last: "Never run",
    runs: "No live runs",
  },
  {
    group: "Tasks",
    title: "Task queue → Linear",
    status: "Not connected",
    description:
      "Reads what changed, evaluates task rules, creates new tasks and closes tasks whose reason went away.",
    schedule: "Every 15 minutes",
    last: "Never run",
    runs: "No live runs",
  },
  {
    group: "Tasks",
    title: "Recruiting proposals (booking chase)",
    status: "Approval required",
    description:
      "Sends only approved booking-chase messages from the configured recruiting mailbox. A proposal must be approved before it can send.",
    schedule: "Every 5 minutes",
    last: "Never run",
    runs: "No live runs",
  },
];

// The subset of role workflow outputs the builder displays.
type RoleRecords = {
  brief: Record<"problem" | "ownership" | "location" | "manager" | "arrangement" | "employment", string> & {
    start?: string;
    mustHaves: string[];
    niceToHaves: string[];
  };
  moc: { mission: string; outcomes: string[]; competencies: string[] };
  posting: { body: string };
  compensation: { level: string; minimum: number; maximum: number };
  "interview-loop": { stages: { name: string; focus: string }[] };
};

/** Role builder fields projected from a role workflow fixture's recorded outputs. */
export function roleFields({ records }: { records: RoleRecords }) {
  const { brief, moc, posting, compensation } = records;
  return {
    problem: brief.problem,
    ownership: brief.ownership,
    location: brief.location,
    manager: brief.manager,
    arrangement: brief.arrangement,
    employment: brief.employment,
    ...(brief.start ? { start: brief.start } : {}),
    mustHaves: brief.mustHaves.join("\n"),
    niceToHaves: brief.niceToHaves.join("\n"),
    mission: moc.mission,
    outcomes: moc.outcomes.join("\n"),
    competencies: moc.competencies.join(", "),
    description: posting.body,
    level: compensation.level,
    salaryMin: String(compensation.minimum),
    salaryMax: String(compensation.maximum),
    interviews: records["interview-loop"].stages.map((stage) => `${stage.name} — ${stage.focus}`).join("\n"),
  };
}

// Recorded role-builder outputs come from the shared workflow fixtures that the
// contract tests evaluate; only the intake conversation is view-only demo data.
export const roleDetails = {
  "agentic-engineer": {
    fixture: agenticEngineer.id,
    fields: roleFields(agenticEngineer),
    conversation: [
      { role: "user", text: "We need an agentic engineer to make our agent tooling reliable." },
      { role: "assistant", text: "Let's define the problem, ownership, location, and required experience, then review the scorecard." },
    ],
  },
  "software-engineer": {
    fixture: softwareEngineer.id,
    fields: roleFields(softwareEngineer),
    conversation: [
      { role: "user", text: "We need a software engineer to improve the platform." },
      { role: "assistant", text: "I have organized the role brief and scorecard for review." },
    ],
  },
};

export const screenerCriteria: Record<string, string> = {
  "agentic-engineer": "Production engineering experience relevant to agent reliability\nEvidence of evaluation design and debugging\nExamples of cross-team technical ownership",
};
