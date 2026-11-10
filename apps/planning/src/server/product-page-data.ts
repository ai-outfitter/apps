import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { stableGraphId, defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { productContextQuery as query } from "../../queries/product-context";

export function weeklyPeriod(at: string | Date = new Date()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid reporting date");
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const start = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 7);
  return { start, end: date.toISOString().slice(0, 10) };
}
type RecordRef = {
  id: string;
  title: string;
  revision: number;
  summary?: string;
};
type Product = RecordRef & { revisions: { from: RecordRef | null }[] };
type Project = RecordRef & {
  owners: { to: { id: string; __typename: string } | null }[];
  products: { to: { id: string; __typename: string } | null }[];
  goals: { to: RecordRef | null }[];
};
type Plan = RecordRef & { body: string };
type Answer = {
  organization: {
    id: string;
    title: string;
    slug: string | null;
    revision: number;
    developed: { from: Product | null; properties?: { rank?: unknown } | null }[];
    offerings: { from: { products: { to: Product | null }[] } | null }[];
    projects: { from: { products: { to: Product | null }[] } | null }[];
  } | null;
  projectRecords: { nodes: Project[]; pageInfo: { hasNextPage: boolean } };
  reports: {
    nodes: Plan[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
export type ProductPageData = Awaited<ReturnType<typeof readProductPage>>;

/** Organization binding is verified before traversal. Wiki tenancy alone is not ownership. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: organization binding, pagination bounds and incomplete-read refusal guard this one evidence capture.
export async function readProductPage(
  host: WorkflowHost<any>,
  identity: AppIdentity,
  at?: string | null,
) {
  const period = weeklyPeriod(at ?? new Date());
  if (!identity.organizationId)
    throw new Response("An organization scope is required", { status: 400 });
  const wiki = await defaultWiki(host);
  const db = await appDataContext(host).apps.installation(wiki.installationId);
  const types = await db
    .collection("types")
    .list({ where: { name: "Organization", archived: false }, limit: 2 });
  if (types.length !== 1)
    throw new Response("Organization definition unavailable", { status: 409 });
  const bound: string[] = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const page = await db.collection("nodes").list({
      where: { typeId: types[0].ref.id, archived: false },
      select: ["properties"],
      limit: 100,
      offset,
    });
    bound.push(
      ...page
        .filter(
          (node) =>
            (node.attributes.properties as Record<string, unknown>)
              ?.organization_id === identity.organizationId,
        )
        .map((node) => node.ref.id),
    );
    if (page.length < 100) break;
    if (offset === 9900)
      throw new Response("Organization lookup exceeds its bound", {
        status: 413,
      });
  }
  if (bound.length !== 1)
    throw new Response("Bind exactly one Wiki organization to this scope", {
      status: 409,
    });
  const plans: Plan[] = [];
  let after: string | null = null,
    data: Answer | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = (await host.call("actions.call", {
      installationId: wiki.installationId,
      action: "graph.graphql",
      readOnly: true,
      input: { query, variables: { root: bound[0], after }, maxBytes: 262144 },
    })) as {
      data?: Answer;
      errors?: { message: string }[];
      extensions?: { truncated?: boolean };
    };
    if (
      !result.data ||
      result.errors?.length ||
      result.extensions?.truncated ||
      result.data.projectRecords.pageInfo.hasNextPage
    )
      throw new Response(
        result.errors?.map((error) => error.message).join("; ") ||
          "Product context is incomplete",
        { status: 502 },
      );
    data ??= result.data;
    plans.push(...result.data.reports.nodes);
    if (!result.data.reports.pageInfo.hasNextPage) break;
    after = result.data.reports.pageInfo.endCursor;
    if (!after || cursors.has(after) || page === 19)
      throw new Response("Report pagination is incomplete", { status: 413 });
    cursors.add(after);
  }
  if (!data?.organization)
    throw new Response("Bound organization unavailable", { status: 409 });
  const org = data.organization;
  if (!org.slug)
    throw new Response("Bound organization needs a slug", { status: 409 });
  const organization = { slug: org.slug, name: org.title };
  const candidates = [
    ...org.developed.map((edge) => edge.from),
    ...org.offerings.flatMap(
      (edge) => edge.from?.products?.map((item) => item.to) ?? [],
    ),
    ...org.projects.flatMap(
      (edge) => edge.from?.products?.map((item) => item.to) ?? [],
    ),
  ];
  const ranks = new Map(org.developed.flatMap(edge => edge.from && typeof edge.properties?.rank === "string" ? [[edge.from.id, edge.properties.rank] as const] : []));
  const products = [
    ...new Map(
      candidates
        .filter((item): item is Product => Boolean(item?.id))
        .map((item) => [item.id, item]),
    ).values(),
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: rank and title provide deterministic fallback ordering
  ].sort((a, b) => {
    const left = ranks.get(a.id), right = ranks.get(b.id);
    return left != null && right != null ? (left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)) : left != null ? -1 : right != null ? 1 : a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  }).map((item) => ({
    ...item,
    revisions: item.revisions.flatMap((edge) => (edge.from ? [edge.from] : [])),
    projects: data!.projectRecords.nodes
      .filter(
        (project) =>
          project.owners.some(
            (owner) =>
              owner.to?.__typename === "Organization" &&
              owner.to.id === bound[0],
          ) && project.products.some((edge) => edge.to?.id === item.id),
      )
      .map((project) => ({
        ...project,
        goals: project.goals.flatMap((goal) => (goal.to ? [goal.to] : [])),
      })),
  }));
  const reports: (Record<string, any> & RecordRef)[] = plans.flatMap((plan) => {
    let body: Record<string, any>;
    try {
      body = JSON.parse(plan.body);
    } catch {
      return [];
    }
    return body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      body.kind === "weekly_report" &&
      body.definition === "product-roadmap" &&
      body.organization_id === bound[0] &&
      body.period_start === period.start &&
      body.period_end === period.end
      ? [{ ...body, id: plan.id, revision: plan.revision, title: plan.title }]
      : [];
  });
  // A sealed report is authoritative independently of its mutable working copy.
  const sealTypes = await db.collection("types").list({
    where: { name: "WeeklyReportSeal", archived: false },
    limit: 2,
  });
  if (sealTypes.length > 1)
    throw new Response("Seal definition is ambiguous", { status: 409 });
  if (sealTypes.length) {
    const policy = sealTypes[0].attributes.ontology as
      { version?: number; immutable?: boolean } | undefined;
    if (policy?.version !== 2 || policy.immutable !== true)
      throw new Response("Report seal definition must be immutable", {
        status: 409,
      });
    const sealed = new Map<string, Record<string, any> & RecordRef>();
    for (let offset = 0; offset < 2000; offset += 100) {
      const rows = await db.collection("nodes").list({
        where: { typeId: sealTypes[0].ref.id, archived: false },
        limit: 100,
        offset,
      });
      for (const row of rows) {
        let seal: any;
        try {
          seal = JSON.parse(String(row.attributes.body));
        } catch {
          continue;
        }
        const report = seal?.report;
        if (
          seal?.kind !== "weekly_report_seal" ||
          report?.kind !== "weekly_report" ||
          report.organization_id !== bound[0] ||
          report.definition !== "product-roadmap" ||
          report.period_start !== period.start ||
          report.period_end !== period.end
        )
          continue;
        if (
          report.status !== "sealed" ||
          row.ref.id !==
            (await stableGraphId(
              "weekly-report-seal-v1",
              wiki.installationId,
              seal.report_id,
            ))
        )
          throw new Response("Report seal identity is invalid", {
            status: 409,
          });
        sealed.set(seal.report_id, {
          ...report,
          id: seal.report_id,
          revision: report.seal.report_revision ?? 0,
          seal_record_id: row.ref.id,
          seal_record_revision: row.revision,
          title: `product-roadmap ${period.start}`,
        });
      }
      if (rows.length < 100) break;
      if (offset === 1900)
        throw new Response("Seal lookup exceeds its bound", { status: 413 });
    }
    for (const [id, seal] of sealed) {
      const index = reports.findIndex((report) => report.id === id);
      if (index < 0) reports.push(seal);
      else reports[index] = seal;
    }
  }
  if (reports.some((report) => report.status === "sealed" && !report.seal))
    throw new Response("Sealed report evidence is missing", { status: 409 });
  if (reports.length > 1)
    throw new Response("Multiple reports match this organization and week", {
      status: 409,
    });
  return {
    id: `${organization.slug}:${period.start}`,
    name: `${organization.name} products`,
    slug: organization.slug,
    organizationSlug: organization.slug,
    periodStart: period.start,
    periodEnd: period.end,
    report: reports[0] ?? null,
    products,
    sourceContext: {
      wikiInstallationId: wiki.installationId,
      organizationId: bound[0],
      organizationRevision: org.revision,
      query,
      variables: { root: bound[0] },
      consistency: "live-paginated",
      complete: true,
    },
    markdown: "",
  };
}

/** The same page model rendered for MCP and products.md. No inference occurs on reads. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: render the report sections and linked product context in the same page order.
export function productPageMarkdown(page: Omit<ProductPageData, "markdown">) {
  const report = page.report;
  const lines = [
    `# ${page.name}`,
    `Week: ${page.periodStart} to ${page.periodEnd} (UTC, end exclusive)`,
    "",
    "## Weekly product roadmap",
    report
      ? `Status: ${report.status} · Revision ${report.revision} · Updated ${report.updated_at ?? "unknown"}`
      : "No report has been generated for this week.",
  ];
  if (report) {
    lines.push("", String(report.narrative ?? ""));
    for (const [title, key] of [
      ["Changes", "changes"],
      ["Proposed priorities", "proposed_priorities"],
      ["Open questions", "open_questions"],
    ]) {
      const value = report[key];
      if (value)
        lines.push(
          "",
          `### ${title}`,
          ...(Array.isArray(value)
            ? value.map((item) => `- ${item}`)
            : [String(value)]),
        );
    }
    const manifest = report.evidenceManifest;
    lines.push(
      "",
      `Source records: ${manifest?.records?.length ?? 0}. Evidence: ${manifest?.complete ? "captured; consistency checked at seal" : "incomplete"}.`,
    );
    if (report.seal)
      lines.push(
        `Sealed revision: ${report.seal.revision}. Cutoff: ${report.seal.cutoff}. Governance review: ${report.seal.control_id ? "configured; inspect Governance for its current status" : "not configured"}.`,
      );
    lines.push(
      "",
      "Generated recommendations require review. Sealing does not imply approval.",
    );
  }
  lines.push("", "## Products");
  for (const product of page.products) {
    lines.push("", `### ${product.title}`, product.summary ?? "");
    for (const revision of product.revisions)
      lines.push(`- Revision: ${revision.title}`);
    for (const project of product.projects) {
      lines.push(`- Project: ${project.title}`);
      for (const goal of project.goals) lines.push(`  - Goal: ${goal.title}`);
    }
  }
  if (!page.products.length) lines.push("No products recorded.");
  return lines.join("\n");
}
