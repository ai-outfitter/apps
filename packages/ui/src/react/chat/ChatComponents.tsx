import { ChatComponentContext, type SignUpProvider, usePlatformURL } from "@ai-outfitter/ui/react/chat/context";
import Icon from "@ai-outfitter/ui/react/Icon";
import { renderWorkflowCard } from "@ai-outfitter/ui/scripts/workflow-card";
import type { UIMessage } from "ai";
import { memo, type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import "@ai-outfitter/ui/workflow.css";
import {
  CONNECT_LATER,
  CONNECT_SERVICES,
  connectServicesOutput,
  PROPOSE_TASKS,
  PROPOSE_WORKFLOW,
  proposeTasksOutput,
  workflowProposalOutput,
  workProfileStatus,
} from "@ai-outfitter/app-sdk/platform-records";
import { RoutineResult } from "@ai-outfitter/ui/react/chat/TurnOnRoutine";
import { previewRoutine, type RoutineTask, turnedOnMessage } from "@ai-outfitter/ui/react/chat/turn-on-routine";
import { turningOn, useTurnOnRoutine } from "@ai-outfitter/ui/react/chat/use-turn-on-routine";
import { WorkProfileCard } from "@ai-outfitter/ui/react/chat/WorkProfile";
import type { z } from "zod";
import { connectedMessage } from "./message-helpers";

const WORK_PROFILE = "work_profile";
const workProfileOutput = workProfileStatus;
const SERVICES = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
} as const;
type Service = keyof typeof SERVICES;
type Connection = { provider: Service; status: string };

function signupWithEmail(href: string, email?: string) {
  if (!email) return href;
  const url = new URL(href);
  url.searchParams.set("email", email);
  return url.href;
}

/**
 * Marks, for this tab, that Connect left this chat for Google; read once on
 * return. Signed out there is no chat yet, so the mark waits for the chat
 * sign-up saves the conversation to.
 */
const connectMark = (chatPath: string) => `outfitter:connecting:${chatPath}`;
const SIGN_UP_MARK = connectMark("sign-up");
/** This chat's connect marks, left in place. */
function connectMarks(chatPath: string) {
  try {
    return [connectMark(chatPath), SIGN_UP_MARK].filter((key) => sessionStorage.getItem(key) !== null);
  } catch {
    return [];
  }
}
function takeConnectMark(chatPath: string) {
  const marked = connectMarks(chatPath);
  for (const key of marked) sessionStorage.removeItem(key);
  return marked.length > 0;
}
/** Checks, a second apart, for connections a replica has not caught up to. */
const CONNECTION_RETRIES = 3;
function setConnectMark(chatPath: string) {
  try {
    sessionStorage.setItem(connectMark(chatPath), "1");
  } catch {
    // Without storage the member asks for their tasks themselves.
  }
}

/**
 * Connect the member's inbox and calendar from inside the conversation. Back
 * from account sign-up or Google with a service connected, the card asks for the work profile (or, without Gmail, the recurring tasks)
 * itself, once. Not now sends CONNECT_LATER as the member's message; once
 * anything follows the card, it no longer offers it.
 */
export function ConnectServices({ services, email, answered }: z.infer<typeof connectServicesOutput> & { answered: boolean }) {
  const context = useContext(ChatComponentContext);
  const headingId = useId();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const started = useRef(false);
  const platform = usePlatformURL();
  const signedIn = context?.signedIn === true;
  const chatPath = context?.signedIn ? context.chatPath : null;
  const wanted = services.join(" ");
  useEffect(() => {
    if (!chatPath) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Back from Google, the connections can trail the redirect on a replica:
    // check again a few times before offering Connect.
    const load = (attempt: number) =>
      fetch(platform("/api/connectors/google"))
        .then((response): Promise<Connection[]> | Connection[] => (response.ok ? response.json() : []))
        .catch((): Connection[] => [])
        .then((rows) => {
          if (!current) return;
          const incomplete = wanted
            .split(" ")
            .some((service) => !rows.some((row) => row.provider === service && row.status === "active"));
          if (incomplete && attempt < CONNECTION_RETRIES && connectMarks(chatPath).length)
            timer = setTimeout(() => load(attempt + 1), 1000);
          else setConnections(rows);
        });
    void load(0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [chatPath, wanted, platform]);
  const connected = (service: Service) =>
    connections?.some((c) => c.provider === service && c.status === "active") ?? false;
  const missing = services.filter((service) => !connected(service));
  useEffect(() => {
    if (!context?.signedIn || context.busy || started.current || !connections) return;
    started.current = true;
    const back = takeConnectMark(context.chatPath);
    const linked = services.filter(connected);
    // With Gmail, the reply shows the work profile built from it; otherwise it
    // looks for tasks, including after a sign-up that connected nothing.
    if (back && linked.length) {
      const { text, intent } = connectedMessage(linked.map((s) => SERVICES[s]), linked.includes("gmail"));
      context.send(text, intent);
    } else if (back) context.send("Find my recurring tasks.");
  });
  if (!context) return null;
  return (
    <section className="chat-component connect-services" aria-labelledby={headingId}>
      <h3 id={headingId}>Build routines around your work</h3>
      <p>{signedIn
        ? `Connect Google so I can check recent mail and events${email ? ` for ${email}` : ""} for recurring work. You review what I suggest.`
        : "Connecting Gmail or GitHub signs you up and gives Outfitter more context to identify recurring routines and recommend useful apps. Gmail can provide mail and calendar context; GitHub can provide repository and organization context. Review the provider’s permissions before approving. You can skip for now, and this draft uses only what you shared here."}</p>
      {signedIn && connections ? (
        <ul className="connect-services-status">
          {services.map((service) => {
            const on = connected(service);
            return (
              <li key={service} data-connected={on}>
                {on ? <Icon name="check" size={14} /> : null} {SERVICES[service]}{on ? " connected" : " not connected"}
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConnectServicesActions services={services} email={email} answered={answered} connections={connections} missing={missing} />
    </section>
  );
}

function ConnectServicesActions({ services, email, answered, connections, missing }: {
  services: readonly Service[]; email?: string; answered: boolean;
  connections: Connection[] | null; missing: Service[];
}) {
  const context = useContext(ChatComponentContext);
  if (!context) return null;
  return <>
    {!context.signedIn ? (
      <SignUpToConnect services={services} email={email} />
    ) : connections && missing.length ? (
      <ConnectForm services={missing} chatPath={context.chatPath} email={email} />
    ) : null}
    {!answered && (!context.signedIn || (connections && missing.length)) ? (
      <button type="button" className="connect-later" disabled={context.busy || (!context.signedIn && context.previewFixture)} onClick={() => context.send(CONNECT_LATER)}>
        Not now
      </button>
    ) : null}
  </>;
}

/** Signed out, a provider sign-in creates an account and preserves this chat. */
function SignUpToConnect({ services, email }: { services: readonly Service[]; email?: string }) {
  const context = useContext(ChatComponentContext);
  if (!context || context.signedIn) return null;
  if (context.previewFixture)
    return <button type="button" className="primary" disabled>
      Continue with an account <span aria-hidden="true">→</span>
    </button>;
  if (!context.providers.length)
    return (
      <a className="primary" href={signupWithEmail(context.signupHref, email)}>
        Sign up to connect <span aria-hidden="true">→</span>
      </a>
    );
  return (
    <div className="connect-provider-options">
      {context.providers.includes("google") ? <ProviderForm provider="google" email={email} connect={services} className="primary" onSubmit={() => setConnectMark("sign-up")}>
        Connect with Gmail <span aria-hidden="true">→</span>
      </ProviderForm> : null}
      {context.providers.includes("github") ? <ProviderForm provider="github" email={email} className="primary" onSubmit={() => setConnectMark("sign-up")}>
        Connect with GitHub <span aria-hidden="true">→</span>
      </ProviderForm> : null}
    </div>
  );
}

/** Signed in, Connect asks Google for the services not yet connected and returns to this chat. */
function ConnectForm({ services, chatPath, email }: { services: readonly Service[]; chatPath: string; email?: string }) {
  const [leaving, setLeaving] = useState(false);
  const platform = usePlatformURL();
  // Google returns to this chat as the browser addresses it (inside the app's mount).
  const returnTo = typeof window === "undefined" ? chatPath : window.location.pathname;
  return (
    // data-astro-reload: the chat page's ClientRouter would otherwise intercept this POST, fail on
    // Google's cross-origin redirect and fall back to a GET of the action, which is a 404.
    <form
      method="post"
      action={platform("/api/connectors/google/authorize")}
      data-astro-reload=""
      onSubmit={() => {
        setConnectMark(chatPath);
        setLeaving(true);
      }}
    >
      {services.map((service) => (
        <input key={service} type="hidden" name="capability" value={service} />
      ))}
      <input type="hidden" name="returnTo" value={returnTo} />
      {email ? <input type="hidden" name="loginHint" value={email} /> : null}
      <button type="submit" className="primary" disabled={leaving} aria-busy={leaving}>
        {leaving ? (
          "Opening Google…"
        ) : (
          <>
            Connect Google <span aria-hidden="true">→</span>
          </>
        )}
      </button>
    </form>
  );
}

const PROVIDERS: Record<SignUpProvider, string> = { google: "Google", github: "GitHub" };

/**
 * A form that starts sign-in with one provider and returns to this
 * conversation. `connect` asks Google for those capabilities in the same
 * consent. While the browser leaves for the provider, the button says so.
 */
function ProviderForm({
  provider,
  email,
  connect,
  className,
  onSubmit,
  children,
}: {
  provider: SignUpProvider;
  email?: string;
  connect?: readonly Service[];
  className: string;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  const context = useContext(ChatComponentContext);
  const [leaving, setLeaving] = useState(false);
  // Back from the provider through the browser's history, the page is live again.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => event.persisted && setLeaving(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  if (!context || context.signedIn) return null;
  return (
    <form
      method="post"
      action="/login"
      data-astro-reload=""
      onSubmit={() => {
        onSubmit?.();
        setLeaving(true);
      }}
    >
      <input type="hidden" name="action" value={provider} />
      <input type="hidden" name="returnTo" value={context.signupReturnTo} />
      <input type="hidden" name="switchAccount" value="0" />
      {email && provider === "google" ? <input type="hidden" name="loginHint" value={email} /> : null}
      {provider === "google" && connect
        ? connect.map((service) => <input key={service} type="hidden" name="connect" value={service} />)
        : null}
      <button type="submit" className={className} disabled={leaving} aria-busy={leaving}>
        {leaving ? `Opening ${PROVIDERS[provider]}…` : <>{children}</>}
      </button>
    </form>
  );
}

/**
 * Every way to sign up, without leaving for the login page: each configured
 * provider goes straight to its consent and returns to /onboarding/continue,
 * which saves this conversation and opens it as the member's chat. Email
 * sign-up uses the sign-up page.
 */
export function SignUpOptions() {
  const context = useContext(ChatComponentContext);
  if (!context || context.signedIn) return null;
  return (
    <div className="sign-up-options">
      {context.providers.map((provider) => (
        <ProviderForm key={provider} provider={provider} className="provider-button">
          Continue with {PROVIDERS[provider]}
        </ProviderForm>
      ))}
      {context.emailSignup ? (
        <a className="sign-up-email" href={context.signupHref}>
          Sign up with email
        </a>
      ) : null}
    </div>
  );
}

type Task = z.infer<typeof proposeTasksOutput>["tasks"][number];

/** A proposed task as the routine it turns on. */
const routineTask = (task: Task): RoutineTask => ({
  title: task.title,
  description: task.description ?? task.evidence,
  cadence: task.schedule,
  ...(task.steps?.length && { steps: task.steps }),
  evidence: task.evidence,
});

/**
 * Ask the member to pick one useful task, or name a different one. Signed in,
 * a choice turns the task on as a routine that runs once now; its first result
 * shows here and goes into the chat as the member's message.
 */
function ChooseTask({ tasks, apps = [] }: z.infer<typeof proposeTasksOutput>) {
  const context = useContext(ChatComponentContext);
  const headingId = useId();
  const [sent, setSent] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const { state: turning, turnOn, showPreview } = useTurnOnRoutine();
  const [skipped, setSkipped] = useState(false);
  const preview = context?.signedIn === false && context.previewFixture === true;
  const pending = turningOn(turning);
  // A turned-on routine answers the card for good, preview or not.
  const answered = sent || "routine" in turning || (preview && skipped);
  const interactive = context !== null && !answered && !pending;
  const disabled = context?.busy || pending;
  const respond = (message: string) => {
    if (!context || !interactive || context.busy) return;
    context.send(message);
    setSent(true);
  };
  const choose = async (task: Task) => {
    if (!context || !interactive || context.busy) return;
    setChosen(task.title);
    if (preview) return showPreview(previewRoutine(task.title, task.schedule));
    if (!context.signedIn) return respond(`I want to focus on: ${task.title}`);
    const routine = await turnOn(routineTask(task));
    if (!routine) return;
    // Sent once, even if a reply started while the first run was writing; the
    // choices stay answered.
    context.send(turnedOnMessage(task.title, routine));
    setSent(true);
  };
  const skip = () => (preview ? setSkipped(true) : respond("Let's skip choosing a task for now."));
  return (
    <section className="chat-component choose-task" aria-labelledby={headingId} aria-busy={pending}>
      <div className="choose-task-heading">
        <h3 id={headingId}>Routines to set up</h3>
        {interactive ? <button type="button" className="choose-task-skip" disabled={disabled} onClick={skip}>Skip</button> : null}
      </div>
      <p>{context?.signedIn
        ? "Choose a routine to turn on, or describe another. It runs once now, then on its schedule."
        : "Choose a routine to draft first, or describe another. Nothing is scheduled yet."}</p>
      <ul className="choose-task-list">
        {tasks.map((task: Task) => (
          <li key={task.id}>
            {interactive ? (
              <button type="button" className="choose-task-option" disabled={disabled} onClick={() => void choose(task)} aria-label={`Choose ${task.title}`}>
                <strong>{task.title}</strong><span>{task.schedule}</span><small>{task.evidence}</small>
              </button>
            ) : (
              <div className="choose-task-option"><strong>{task.title}</strong><span>{task.schedule}</span><small>{task.evidence}</small></div>
            )}
          </li>
        ))}
      </ul>
      {apps.length ? (
        <aside className="suggested-apps" aria-label="Optional app recommendations">
          <h4>Suggested apps</h4>
          <p>Optional ideas to support these routines. Nothing is installed or connected yet.</p>
          <ul>
            {apps.map((app) => <li key={app.name}><strong>{app.name}</strong> — {app.reason}</li>)}
          </ul>
        </aside>
      ) : null}
      {turning.phase === "starting" ? <p role="status">Turning on “{chosen}” and running it once…</p> : null}
      {turning.phase === "error" ? <p role="alert">Couldn’t turn on “{chosen}”: {turning.message}</p> : null}
      {"routine" in turning ? (
        <RoutineResult title={chosen ?? ""} routine={turning.routine} preview={preview} waiting={turning.phase === "waiting"} />
      ) : null}
      {skipped ? <p role="status">Preview choice: Skipped for now</p> : null}
    </section>
  );
}

/** The question is rendered with the composer while it awaits an answer. */
export function ChatTaskQuestion({ part }: { part: UIMessage["parts"][number] }) {
  if (part.type !== `tool-${PROPOSE_TASKS}` || !("state" in part) || part.state !== "output-available") return null;
  const output = proposeTasksOutput.safeParse(part.output);
  return output.success ? <ChooseTask key={part.toolCallId} {...output.data} /> : null;
}

/** The model's reads of the member's Google data, edits to their profile and app changes, shown as they happen; not stored. */
const TOOL_NOTES: Record<string, { pending: string; done: (input: Record<string, unknown>) => string; failed: string }> = {
  "tool-graph_query": { pending: "Searching your connected information…", done: () => "Searched your connected information", failed: "Couldn’t search your connected information" },
  "tool-graph_documents": { pending: "Reading your connected information…", done: () => "Read your connected information", failed: "Couldn’t read your connected information" },
  "tool-search_messages": {
    pending: "Searching your Gmail…",
    done: (i) => `Searched Gmail for “${String(i.query ?? "")}”`,
    failed: "Couldn’t search your Gmail just now",
  },
  "tool-get_message": { pending: "Reading an email…", done: () => "Read an email", failed: "Couldn’t read that email just now" },
  "tool-list_events": {
    pending: "Checking your calendar…",
    done: (i) => (i.query ? `Checked your calendar for “${String(i.query)}”` : "Checked your calendar"),
    failed: "Couldn’t check your calendar just now",
  },
  "tool-save_goal": {
    pending: "Saving your goal…",
    done: (i) => (i.id ? "Updated your goals" : `Saved “${String(i.text ?? "")}” to your goals`),
    failed: "Couldn’t save that goal",
  },
  "tool-remove_goal": { pending: "Removing a goal…", done: () => "Removed a goal", failed: "Couldn’t remove that goal" },
  "tool-update_about": { pending: "Updating your profile…", done: () => "Updated your profile", failed: "Couldn’t update your profile" },
  "tool-graph_mutate": {
    pending: "Making a change…",
    done: (i) => `Ran ${String(i.document ?? "a change")}`,
    failed: "Couldn’t make that change",
  },
};

/** A tool's own refusal ({error}) or a document's GraphQL errors. */
const refused = (output: unknown) =>
  typeof output === "object" && output !== null && ("error" in output || ("errors" in output && Array.isArray(output.errors) && output.errors.length > 0));

function ToolNote({ note, part }: { note: (typeof TOOL_NOTES)[string]; part: { state?: string; input?: unknown; output?: unknown } }) {
  const input = typeof part.input === "object" && part.input ? (part.input as Record<string, unknown>) : {};
  const failed = part.state === "output-error" || (part.state === "output-available" && refused(part.output));
  const text = failed ? note.failed : part.state === "output-available" ? note.done(input) : note.pending;
  return <p className="chat-component chat-component-pending">{text}</p>;
}

/** Shared Forerunner card, mounted in the React chat without duplicating its graph UI. */
const WorkflowProposal = memo(function WorkflowProposal({ output }: { output: Extract<z.infer<typeof workflowProposalOutput>, { valid: true }> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    host.current.replaceChildren(renderWorkflowCard(output.card, { compact: true }));
  }, [output]);
  return (
    <div className="chat-component chat-workflow">
      <p className="chat-workflow__intro">A draft based on this conversation</p>
      <div ref={host} />
    </div>
  );
}, (previous, next) => JSON.stringify(previous.output.card) === JSON.stringify(next.output.card));

function WorkflowToolPart({ output }: { output: unknown }) {
  const parsed = workflowProposalOutput.safeParse(output);
  if (!parsed.success) return null;
  return parsed.data.valid
    ? <WorkflowProposal output={parsed.data} />
    : <p className="chat-component">I couldn’t validate that draft. Ask me to revise it.</p>;
}

/**
 * Renders a UI tool call: the finished result as its component, a placeholder
 * while the model is still writing the call. Unknown tools are skipped.
 */
export function ChatToolPart({ part, answered = false }: { part: UIMessage["parts"][number]; answered?: boolean }) {
  const note = TOOL_NOTES[part.type];
  if (note && "state" in part) return <ToolNote note={note} part={part} />;
  if (part.type === `tool-${PROPOSE_TASKS}`) return null;
  const known = [CONNECT_SERVICES, PROPOSE_WORKFLOW, WORK_PROFILE].some((name) => part.type === `tool-${name}`);
  if (!known || !("state" in part)) return null;
  if (part.state === "input-streaming" || part.state === "input-available")
    return <p className="chat-component chat-component-pending">Preparing a card…</p>;
  if (part.state !== "output-available") return null;
  if (part.type === `tool-${PROPOSE_WORKFLOW}`) return <WorkflowToolPart output={part.output} />;
  if (part.type === `tool-${WORK_PROFILE}`) {
    const profile = workProfileOutput.safeParse(part.output);
    return profile.success ? <WorkProfileCard {...profile.data} /> : null;
  }
  const output = connectServicesOutput.safeParse(part.output);
  return output.success ? <ConnectServices {...output.data} answered={answered} /> : null;
}
