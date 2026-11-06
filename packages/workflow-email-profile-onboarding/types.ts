/** Presentation types; runtime validation comes from workflow.yaml. */
/**
 * The connector operations a suggested app may ask for, as the capability ids
 * an app manifest declares (`connector.<provider>.<operation>`), with how the
 * work profile card says each one. Gmail's messages.list and messages.get are
 * served by the gateway today (packages/connector-gmail); drafts.create is
 * planned. workflow.yaml's `operations` enum lists the same ids, which
 * tests/suggested-app-brief.test.ts keeps equal.
 */
export const APP_OPERATIONS = {
 "connector.gmail.messages.list": "read Gmail",
 "connector.gmail.messages.get": "read Gmail",
 "connector.gmail.drafts.create": "create Gmail drafts",
} as const;
export type AppOperation = keyof typeof APP_OPERATIONS;
export const APP_OPERATION_IDS = Object.keys(APP_OPERATIONS) as [AppOperation, ...AppOperation[]];
type Confidence = "low" | "medium" | "high";
export type EmailProfile = {
 whoTheyAre: {summary: string; organization: string | null};
 suspectedRole: {title: string | null; confidence: Confidence; reasoning: string};
 writingStyle: {summary: string; traits: string[]; confidence: Confidence};
 suggestedWorkflows: {title: string; description: string; trigger: string; steps: string[]; whyUseful: string}[];
 /** Absent on profiles saved before apps were suggested. */
 suggestedApps?: SuggestedApp[];
};
/** Who an app is for: the member, the people they serve, or their colleagues. */
export type AppAudience = "self" | "customers" | "team";
/**
 * The smallest description of an app worth building: goal, persona and how success is counted,
 * plus the brief a build needs: what was seen, the record it keeps and the operations it uses.
 * The brief is absent on apps suggested before it.
 */
export type SuggestedApp = {
 name: string;
 goal: string;
 audience: AppAudience;
 persona: {name: string; need: string};
 /** `query` says in words what is counted over the record. */
 successMetrics: {name: string; target: string; query?: string}[];
 whyUseful: string;
 source?: {provider: "gmail" | "google-calendar"; observation: string; volume: string | null};
 record?: {name: string; fields: string[]};
 operations?: AppOperation[];
};
