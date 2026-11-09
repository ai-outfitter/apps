/**
 * The stable key of the outside record a node stands for, as `<host>/<table>:<id>`.
 * Slugs are readable and can change; a key never does, so an import never
 * creates a record twice. Only the platform and imports set keys.
 */
export const platformHost = "ai-outfitter.com";
type AppRecord = { installationId: string; type: string; id: string };
const app = new RegExp(`^${platformHost.replaceAll(".", "\\.")}/apps/([A-Za-z0-9][A-Za-z0-9_-]*)/([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9_-]*)$`);
const user = `${platformHost}/users:`;
const organization = `${platformHost}/organizations:`;

/** Another app's record, such as a Planning project. */
export const appRecordKey = (ref: AppRecord) => `${platformHost}/apps/${ref.installationId}/${ref.type}:${ref.id}`;
export function appRecordRef(key: string | null | undefined): AppRecord | null {
  const match = key ? app.exec(key) : null;
  return match ? { installationId: match[1], type: match[2], id: match[3] } : null;
}
/** An Outfitter user or agent principal, held by an OutfitterUser node. */
export const userKey = (principalId: string) => user + principalId;
export const userPrincipal = (key: string | null | undefined) => key?.startsWith(user) ? key.slice(user.length) : null;
/** An Outfitter organization, held by an OutfitterOrganization node. */
export const organizationKey = (organizationId: string) => organization + organizationId;
