/** Read-only owner inventory and complete archive capture. Never provisions or imports. */
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { oauthClient, validateOrigin } from "./wiki-transfer.mjs";

export function ownerInventory(identity, organizations, installations) {
  if (
    !identity.user?.id ||
    !Array.isArray(organizations) ||
    !Array.isArray(installations)
  )
    throw Error("Invalid account inventory");
  const owners = [
    { kind: "user", id: identity.user.id, slug: null },
    ...organizations.map((o) => ({
      kind: "organization",
      id: o.id,
      slug: o.slug,
    })),
  ];
  if (new Set(owners.map((o) => `${o.kind}:${o.id}`)).size !== owners.length)
    throw Error("Duplicate owner in inventory");
  const rows = owners.map((owner) => {
    const apps = installations.filter(
      (app) => app.owner?.kind === owner.kind && app.owner.id === owner.id,
    );
    const wikis = apps.filter((app) => app.template === "wiki-map");
    const onto = apps.filter((app) =>
      ["onto", "outfitter/onto"].includes(app.template),
    );
    return {
      owner,
      wikis,
      onto,
      blockers: [
        ...(wikis.length > 1 ? ["ambiguous-source"] : []),
        ...(onto.length !== 1
          ? [onto.length ? "ambiguous-destination" : "onto-not-provisioned"]
          : []),
        ...(!wikis.length ? ["no-legacy-wiki-to-audit"] : []),
        "migration-not-verified",
      ],
    };
  });
  for (const app of installations) {
    if (
      !app.owner ||
      !owners.some((o) => o.kind === app.owner.kind && o.id === app.owner.id)
    )
      throw Error("Installation owner is outside the verified inventory");
    if (
      (app.organizationId ?? null) !==
      (app.owner.kind === "organization" ? app.owner.id : null)
    )
      throw Error("Installation organization does not match its owner");
  }
  return rows;
}

export async function captureArchive(
  api,
  installation,
  save,
  maxPages = 10000,
) {
  const base = `/api/app-installations/${encodeURIComponent(installation.installationId)}/data/export`;
  const seen = new Set();
  let cursor;
  const pages = [];
  do {
    const query = new URLSearchParams();
    if (installation.organizationId)
      query.set("organizationId", installation.organizationId);
    if (cursor) query.set("cursor", cursor);
    const page = await api(base + (query.size ? `?${query}` : ""));
    if (
      page.installationId !== installation.installationId ||
      (page.organizationId ?? null) !== (installation.organizationId ?? null)
    )
      throw Error("Archive owner/destination mismatch");
    if (
      page.archive?.source?.installationId !== installation.installationId ||
      page.archive?.source?.owner?.kind !== installation.owner.kind ||
      page.archive?.source?.owner?.id !== installation.owner.id
    )
      throw Error(
        "Archive source lineage does not match its installation owner",
      );
    if (!page.archive || !Object.hasOwn(page.archive, "cursor"))
      throw Error("Archive has no completeness cursor");
    pages.push(await save(page, pages.length));
    cursor = page.archive.cursor;
    if (cursor !== null && (typeof cursor !== "string" || !cursor))
      throw Error("Invalid archive cursor");
    if (cursor && (seen.has(cursor) || pages.length >= maxPages))
      throw Error("Archive pagination did not complete");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return pages;
}

async function privateDirectory(path) {
  // Private graph/account history must remain outside every Git checkout.
  const parent = await realpath(dirname(resolve(path)));
  let checkout;
  try {
    checkout = execFileSync(
      "git",
      ["-C", parent, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch (error) {
    if (error.status !== 128) throw error;
  }
  if (checkout) throw Error("Save private audit data outside Git checkouts");
  const output = join(parent, resolve(path).split("/").at(-1));
  await mkdir(output, { mode: 0o700 }); // Exclusive: never overwrite an earlier capture.
  return output;
}

export async function auditWikiCutover(
  origin,
  directory,
  { tokenFile = process.env.OUTFITTER_ACCESS_TOKEN_FILE, request = fetch } = {},
) {
  validateOrigin(origin);
  const api = await oauthClient(origin, tokenFile, request);
  const identity = await api("/api/whoami");
  for (const scope of ["apps", "organizations", "wiki_transfer"])
    if (!identity.scopes?.includes(scope))
      throw Error(`Reconnect with ${scope} consent`);
  const organizations = await api("/api/organizations");
  const installations = await api("/api/app-installations?allMemberships=true");
  const owners = ownerInventory(identity, organizations, installations);
  const output = await privateDirectory(directory);
  const save = async (name, value) => {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await writeFile(join(output, name), bytes, { flag: "wx", mode: 0o600 });
    return {
      file: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  await save("identity.local.json", identity);
  await save("organizations.local.json", organizations);
  await save("installations.local.json", installations);
  const report = {
    format: "outfitter-wiki-onto-audit-v1",
    origin,
    capturedAt: new Date().toISOString(),
    userId: identity.user.id,
    complete: false,
    limitations: [
      "Only the authenticated account and its currently visible memberships are included.",
      "Archive pages are sequential reads; freeze writes and capture again before cutover.",
      "Binary assets and cross-installation references need separate verification.",
    ],
    owners,
  };
  for (const owner of owners) {
    owner.archives = [];
    for (const installation of [...owner.wikis, ...owner.onto]) {
      const entry = {
        installationId: installation.installationId,
        complete: false,
        pages: [],
      };
      owner.archives.push(entry);
      try {
        if (!installation.permissions?.includes("archive"))
          throw Error(
            "Complete archive unavailable; redeploy or obtain owner/admin access",
          );
        await captureArchive(api, installation, async (page, index) => {
          const saved = await save(
            `archive-${encodeURIComponent(installation.installationId)}-${index}.local.json`,
            page,
          );
          entry.pages.push(saved);
          return saved;
        });
        entry.complete = true;
      } catch (error) {
        entry.error = error.message;
        owner.blockers.push("source-or-destination-archive-incomplete");
      }
    }
  }
  report.complete = owners.every((o) => o.archives.every((a) => a.complete));
  await save("audit.local.json", report);
  return {
    directory: output,
    owners: owners.length,
    archivesComplete: report.complete,
    readyForCutover: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [origin, directory, ...extra] = process.argv.slice(2);
  if (!origin || !directory || extra.length)
    throw Error(
      "Usage: node scripts/audit-wiki-cutover.mjs <main-origin> <new-private-directory>; set OUTFITTER_ACCESS_TOKEN_FILE",
    );
  auditWikiCutover(origin, directory)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
