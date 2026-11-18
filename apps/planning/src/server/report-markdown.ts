/** Human report body; the exact machine-readable capture remains in collapsed provenance. */
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const label = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g," ").replace(/[\\`*_{}\[\]<>]/g, "\\$&");
function questions(value: unknown, context = ""): string[] {
  return rows(value).flatMap(item => Array.isArray(item.questions) ? item.questions.filter(q=>typeof q==="string").map(q=>`- **${context ? `${label(context)} · ` : ""}${label(item.title)}:** ${label(q)}`) : []);
}
function sourceLink(value: unknown, scope?: string) {
  const ref=record(value);
  const address=typeof ref.slug==="string"?ref.slug:typeof ref.documentId==="string"?ref.documentId:null;
  if(!address)return "Report unavailable";
  const path=scope ? `/o/${encodeURIComponent(scope)}/wiki-map/p/${encodeURIComponent(address)}` : `./${encodeURIComponent(address)}`;
  return `[Read report](${path}${typeof ref.revision === "number" ? `?revision=${ref.revision}` : ""}) · revision ${label(ref.revision)}`;
}
function githubLink(title:unknown,value:unknown){
  try {const url=new URL(String(value));if(url.protocol==="https:"&&url.hostname==="github.com")return `[${label(title)}](${url.href.replace(/\(/g,"%28").replace(/\)/g,"%29")})`;}catch{}
  return label(title);
}
function repositoryWork(value:unknown):string {
  const evidence=record(value);
  const lines=rows(evidence.repositories).flatMap(repo=>[
    ...rows(repo.pullRequests).map(pull=>`- ${githubLink(`#${pull.number} ${pull.title}`,pull.url)} — merged in ${label(repo.repository)}${repo.scope==="repository-wide"&&Boolean(repo.path||repo.ref)?"; project path/ref attribution is unverified":""}.`),
    ...rows(repo.directCommits).map(commit=>`- ${githubLink(commit.headline,commit.url)} — direct commit in ${label(repo.repository)}.`),
    ...(Number(repo.omittedPullRequestCount)>0?[`- ${label(repo.repository)}: ${label(repo.omittedPullRequestCount)} additional merged pull request observations are outside this bounded preview.`]:[]),
    ...(Number(repo.omittedDirectCommitCount)>0?[`- ${label(repo.repository)}: ${label(repo.omittedDirectCommitCount)} additional direct commit observations are outside this bounded preview.`]:[]),
    ...(Array.isArray(repo.unknowns)?repo.unknowns.map(reason=>`- ${label(repo.repository)}: ${label(reason)}`):[]),
  ]);
  if(Number(evidence.omittedRepositoryCount)>0)lines.push(`- ${label(evidence.omittedRepositoryCount)} additional repositories are outside this bounded preview; open the revision-pinned source report for their observations.`);
  if(evidence.complete===true && !rows(evidence.repositories).length && !Number(evidence.observedRepositoryCount))lines.push("- No GitHub repository is configured; repository activity was not observed.");
  if(evidence.complete===false && !lines.length)lines.push("- Repository evidence is unavailable or incomplete; merged work is unknown.");
  return lines.join("\n");
}
function projectSummary(child:Record<string,unknown>,scope?:string){
  const summary=record(child.summary),work=repositoryWork(summary.repositoryEvidence);
  return `- **${label(summary.name ?? child.projectId)}** — ${label(child.status)}. ${label(summary.summary)} ${sourceLink(child.report,scope)}${work?`\n${work.split("\n").map(line=>`  ${line}`).join("\n")}`:""}`;
}
export function reportMarkdown(content:Record<string,unknown>):string {
  const parts:string[]=[];
  const pending=questions(content.decisions);
  const dependencies=rows(content.dependencies ?? content.personalProjects);
  for(const child of dependencies)pending.push(...questions(record(child.summary).decisions, String(record(child.summary).name ?? child.projectId)));
  const organizations=rows(content.organizations);
  for(const org of organizations)for(const child of rows(org.dependencies))pending.push(...questions(record(child.summary).decisions, `${org.organizationSlug ?? record(org.organization).name ?? "Organization"} · ${record(child.summary).name ?? child.projectId}`));
  parts.push("## Needs your attention",pending.length?[...new Set(pending)].join("\n"):"No pending intake questions were captured. Check source coverage below before treating this as a complete decision list.");
  if(content.decisionsTruncated || dependencies.some(child=>record(child.summary).decisionsTruncated) || organizations.some(org=>rows(org.dependencies).some(child=>record(child.summary).decisionsTruncated)))parts.push("Some intake decisions were omitted from this bounded capture. Open Planning to inspect the remaining requests.");
  const changed=record(content.changes);
  if(Array.isArray(changed.issues))parts.push("## Observed work",rows(changed.issues).length?rows(changed.issues).map(row=>`- ${label(row.title)} — ${label(row.currentStatus)}`).join("\n"):"No issue changes were observable in the reporting window.");
  if(content.repositoryEvidence)parts.push("## Repository work",repositoryWork(content.repositoryEvidence)||"No merged pull requests or direct commits were captured. Consult source coverage before treating this as complete activity.");
  if(dependencies.length)parts.push("## Project reports",dependencies.map(child=>projectSummary(child)).join("\n"));
  if(organizations.length)parts.push("## Organization reports",organizations.map(org=>{const organization=record(org.organization ?? {slug:org.organizationSlug,name:org.organizationSlug});const scope=typeof organization.slug==="string"?organization.slug:undefined;return `### ${label(organization.name ?? organization.slug)}\n\n${label(org.status)} · ${sourceLink(org.reference,scope)}\n\n${typeof org.summary==="string"?`${label(org.summary)}\n\n`:""}${org.projectDetailPreviewsOmitted?"":rows(org.dependencies).map(child=>projectSummary(child,scope)).join("\n")}`;}).join("\n"));
  if(content.goalContext){
    const context=record(content.goalContext),goals=rows(context.goals);
    parts.push("## Personal goals",goals.length?goals.map(goal=>`- **${label(goal.title)}** — ${label(record(goal.observation).reason??"Measured progress is unknown; inspect the captured source references for metric definitions.")}${rows(goal.metrics).length?` Metric definitions: ${rows(goal.metrics).map(metric=>label(metric.title)).join(", ")}.`:""}`).join("\n"):context.complete?"No active personal goals were found in the captured Wiki source.":"Personal goals could not be read; progress is unknown.");
    parts.push("## Standup","Standup status is unavailable. This report has no saved standup evidence.");
  }
  parts.push("## Next action",pending.length?"Answer the questions above in the Planning conversation. Decisions are saved against their current record revision; eligible work can then continue.":"Review the captured outcomes and evidence. Describe the next customer outcome in your Planning conversation when you want to start work.");
  if(typeof content.coverage==="string")parts.push("## Coverage",content.coverage);
  if(record(content.completeness).history==="limited")parts.push("Historical coverage is limited: overwritten transitions and deleted records may be missing. This is not proof of complete activity or KPI progress.");
  return parts.join("\n\n");
}
