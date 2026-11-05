import { z } from "zod";
import type { ConnectorDescriptor } from "./manifest";

const identifier = z.string().min(1).max(1024);
export const connectorEventSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/).max(128),
  resource: identifier,
  subject: identifier,
  payload: z.unknown(),
}).strict();
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;
/** Factual connector-owned projection of an already verified provider event. */
export const connectorRecordSchema = z.object({
  connector: z.string().regex(/^[a-z][a-z0-9-]*$/).max(128),
  record: z.string().min(1).max(128), value: z.unknown(),
}).strict();
export type ConnectorRecord = z.infer<typeof connectorRecordSchema>;

/** Verified provider identity. The platform resolves this to its own connection
 * row; a provider webhook never supplies a trusted tenant or connection id. */
export type ConnectorDelivery = {
  deliveryId: string;
  dedupeKey?: string;
  externalAccountId: string;
  events: ConnectorEvent[];
};
export const connectorConnectionSchema = z.object({
  id: identifier,
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
  externalId: identifier,
  owner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("organization"), id: identifier }).strict(),
    z.object({ kind: z.literal("user"), id: identifier }).strict(),
  ]),
  status: z.enum(["active", "revoked", "invalid"]),
  config: z.record(z.string(), z.unknown()),
}).strict();
export type ConnectorConnection = z.infer<typeof connectorConnectionSchema>;

/** Derived by the platform on every call from the current principal, the
 * connection and the installation's trusted manifest; never accepted from an
 * app verbatim. Resource is connector-defined and meaningful only inside this
 * connection; `operations` are the manifest-declared ones for its provider. */
export const connectorScopeSchema = z.object({
  // Null for a user-owned installation, which only a user's own connection serves.
  organizationId: identifier.nullable(),
  installationId: identifier,
  // The acting member; null only for organization-owned connections in
  // unattended work. A user-owned connection serves only its own user.
  userId: identifier.nullable(),
  connectionId: identifier,
  resource: identifier,
  operations: z.array(z.string().min(1).max(128)).max(100),
}).strict();
export type ConnectorScope = z.infer<typeof connectorScopeSchema>;
export type ConnectorCredentials = Readonly<Record<string, string>>;
export type ConnectorOperationContext = {
  connection: ConnectorConnection;
  scope: ConnectorScope;
  credentials: ConnectorCredentials;
};
export type ConnectorAdmission = {
  input: z.ZodType;
  execute(input: unknown, credentials: ConnectorCredentials): Promise<unknown>;
};

/** A workspace checkout receipt, not a shared forge operation API. Providers
 * derive it from their authoritative mutation result and verified resource. */
export const checkoutReceipt = z.object({
  repository: z.string().min(1).max(512), repositoryId: z.string().min(1).max(128),
  branch: z.string().min(1).max(256), parentSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type CheckoutReceipt = z.infer<typeof checkoutReceipt>;
export const connectorCheckoutResult = z.object({ result: z.unknown(), effect: z.object({ kind: z.literal("checkout"), receipt: checkoutReceipt }).strict() }).strict();

/** Who may start an operation. `member`: only a member's own interactive
 * request, which the platform marks on the call; deliveries, schedules,
 * workflow phases and agents are refused. Absent: any caller the platform admits. */
export type ConnectorInitiation = "member";

export type ConnectorOperation = {
  input: z.ZodType;
  initiation?: ConnectorInitiation;
  effect?: { kind: "checkout"; receipt(input: unknown, result: unknown, context: ConnectorOperationContext): Promise<CheckoutReceipt> };
  execute(input: unknown, context: ConnectorOperationContext): Promise<unknown>;
};

/** Cryptographically verified, stable workload identity. Rotating JWT metadata is
 * deliberately excluded so a freshly minted token retains the same principal. */
export const connectorWorkloadIdentitySchema = z.object({
  issuer: z.string().url().max(1024),
  subject: z.string().min(1).max(2048),
  claims: z.record(z.string().min(1).max(128), z.string().max(2048))
    .refine(claims => !["jti", "iat", "exp", "nbf"].some(key => Object.hasOwn(claims, key)), "Rotating token metadata is not workload identity"),
}).strict();
export type ConnectorWorkloadIdentity = z.infer<typeof connectorWorkloadIdentitySchema>;

/** Base provider interface, not a shared forge API. Providers declare their own
 * event vocabulary and operation schemas; the platform only matches envelopes. */
export interface RuntimeConnector {
  descriptor: ConnectorDescriptor;
  /** The connection's own stored secret this connector's operations need. The
   * platform's credential adapter for this provider decrypts (and refreshes) it
   * inside the platform and lends it to one execute call as
   * `credentials.accessToken`; results never carry it back. Absent, operations
   * receive only operator-bound slots and secret-bearing connections are refused. */
  connectionCredential?: "oauth2-access-token";
  config: z.ZodType;
  events: Readonly<Record<string, z.ZodType>>;
  /** Pure projection only: no credentials, command execution, or network I/O.
   * Host must supply a previously authenticated provider event. */
  records?: (event: ConnectorEvent) => ConnectorRecord[];
  operations: Readonly<Record<string, ConnectorOperation>>;
  /** Control-plane setup/identity only; never reachable through an app operation. */
  admissions?: Readonly<Record<string, ConnectorAdmission>>;
  workload?: {
    issuer: string;
    verify(input: { token: string; audience: string }): Promise<ConnectorWorkloadIdentity>;
  };
  verifyWebhook: ((request: Request, credentials: ConnectorCredentials) => Promise<ConnectorDelivery>) | null;
  /** For a connector its descriptor says organizations own: the operations a
   * person's own account connection (owner kind `user`) may also run, for that
   * person only, with that connection's config. Its one resource is the
   * account itself (the connection's `externalId`); `coversResource` is not
   * consulted. Each named operation is also listed in the descriptor. */
  account?: { operations: readonly string[]; config: z.ZodType };
  coversResource(connection: ConnectorConnection, resource: string, credentials: ConnectorCredentials): Promise<boolean>;
}

export const connectorDeliverySchema = z.object({
    deliveryId: identifier,
    dedupeKey: identifier.optional(),
    externalAccountId: identifier,
    events: z.array(connectorEventSchema).max(100),
  }).strict();

export function validateDelivery(connector: RuntimeConnector, delivery: ConnectorDelivery) {
  const parsed = connectorDeliverySchema.parse(delivery);
  return {
    ...parsed,
    events: parsed.events.map((event) => {
      const schema = connector.events[event.type];
      if (!schema) throw new Error("Connector returned an undeclared event");
      return { ...event, payload: schema.parse(event.payload) };
    }),
  };
}

/** Recheck the connection and provider coverage immediately before execution.
 * The host authenticates this call and reloads tenant/connection state before entry. */
/** `operation` is the one about to run; without it only the descriptor's own ownership is accepted. */
export async function authorizeConnector(connector: RuntimeConnector, context: ConnectorOperationContext, operation?: string) {
  const connection = connectorConnectionSchema.parse(context.connection);
  const scope = connectorScopeSchema.parse(context.scope);
  if (connection.provider !== connector.descriptor.id || connection.status !== "active" || connection.id !== scope.connectionId)
    throw new Response("Connector connection denied", { status: 403 });
  const owner = connection.owner;
  // A person's own account connection of an organization-owned connector runs only its account operations.
  const account = owner.kind === "user" && connector.descriptor.authentication.ownership === "organization" &&
    operation !== undefined && connector.account?.operations.includes(operation) ? connector.account : null;
  if (!account && owner.kind !== connector.descriptor.authentication.ownership)
    throw new Response("Connector ownership denied", { status: 403 });
  if (owner.id !== (owner.kind === "organization" ? scope.organizationId : scope.userId))
    throw new Response("Connector owner denied", { status: 403 });
  const config = (account?.config ?? connector.config).safeParse(connection.config);
  if (!config.success) throw new Response("Invalid connection configuration", { status: 422 });
  const checked = { ...connection, config: config.data as Record<string, unknown> };
  const covered = account ? scope.resource === connection.externalId
    : await connector.coversResource(checked, scope.resource, context.credentials);
  if (!covered) throw new Response("Connector resource denied", { status: 403 });
  return { ...context, connection: checked, scope };
}

export async function executeConnector(connector: RuntimeConnector, operation: string, input: unknown, context: ConnectorOperationContext, effect?: "checkout", initiation?: ConnectorInitiation) {
  const handler = connector.operations[operation];
  if (!handler || !connector.descriptor.operations.includes(operation) || !context.scope.operations.includes(operation))
    throw new Response("Connector operation denied", { status: 403 });
  if (handler.initiation && handler.initiation !== initiation)
    throw new Response("Connector operation needs the member's own request", { status: 403 });
  if (effect && handler.effect?.kind !== effect) throw new Response("Connector effect denied", { status: 403 });
  const parsedInput = handler.input.safeParse(input);
  if (!parsedInput.success) throw new Response("Invalid connector input", { status: 400 });
  const authorized = await authorizeConnector(connector, context, operation);
  const result = await handler.execute(parsedInput.data, authorized);
  if (!effect) return result;
  const receipt = checkoutReceipt.parse(await handler.effect!.receipt(parsedInput.data, result, authorized));
  return { result, effect: { kind: effect, receipt } };
}


export async function admitConnector(connector: RuntimeConnector, operation: string, input: unknown, credentials: ConnectorCredentials) {
  const admission = connector.admissions?.[operation];
  if (!admission) throw new Response("Connector admission unavailable", { status: 404 });
  const parsed = admission.input.safeParse(input);
  if (!parsed.success) throw new Response("Invalid connector admission", { status: 400 });
  return admission.execute(parsed.data, credentials);
}
