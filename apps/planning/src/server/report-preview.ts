const object=(value:unknown):Record<string,any>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,any>:{};
const rows=(value:unknown):Record<string,any>[]=>Array.isArray(value)?value.map(object):[];
const ref=(value:unknown)=>{const source=object(value);return source.documentId?{installationId:source.installationId,app:source.app,scope:source.scope,documentId:source.documentId,revision:source.revision,slug:source.slug}:null;};
/** A report stores bounded observations; exact child document revisions remain the full handoff. */
export function reportPreview(input:Record<string,unknown>,level:"project"|"organization"|"personal"){
 const content=structuredClone(input) as Record<string,any>;
 let issueObservations=6;
 let observations=level==="project"?12:6;
 const evidence=(value:unknown)=>{
  const source=object(value),repositories=rows(source.repositories);
  const previews=repositories.slice(0,level==="project"?5:2).map(repo=>{
   const pulls=rows(repo.pullRequests),commits=rows(repo.directCommits);
   const keptPulls=pulls.slice(0,Math.min(observations,level==="project"?3:1));observations-=keptPulls.length;
   const keptCommits=commits.slice(0,Math.min(observations,level==="project"?3:1));observations-=keptCommits.length;
   return {repository:repo.repository,path:repo.path,ref:repo.ref,scope:repo.scope,complete:repo.complete,
    pullRequests:keptPulls.map(pull=>({number:pull.number,title:pull.title,url:pull.url,mergedAt:pull.mergedAt})),
    directCommits:keptCommits.map(commit=>({headline:commit.headline,url:commit.url,committedAt:commit.committedAt})),
    observedPullRequestCount:repo.observedPullRequestCount??pulls.length,retainedPullRequestCount:keptPulls.length,omittedPullRequestCount:(repo.observedPullRequestCount??pulls.length)-keptPulls.length,
    observedDirectCommitCount:repo.observedDirectCommitCount??commits.length,retainedDirectCommitCount:keptCommits.length,omittedDirectCommitCount:(repo.observedDirectCommitCount??commits.length)-keptCommits.length,
    unknowns:repo.unknowns,error:repo.error,method:repo.method};
  });
  return {complete:source.complete,errors:source.errors,coverage:source.coverage,observedRepositoryCount:source.observedRepositoryCount??repositories.length,omittedRepositoryCount:(source.observedRepositoryCount??repositories.length)-previews.length,repositories:previews};
 };
 const decisions=(value:unknown)=>rows(value).filter(item=>Array.isArray(item.questions)&&item.questions.length).map(item=>({intakeId:item.intakeId,revision:item.revision,title:item.title,questions:item.questions}));
 const children=(value:unknown,referencesOnly=false)=>rows(value).map(child=>{
  const summary=object(child.summary),completed=rows(summary.completedIssues),shownCompleted=referencesOnly?[]:completed.slice(0,issueObservations);
  issueObservations-=shownCompleted.length;
  return {projectId:child.projectId,status:child.status,report:ref(child.report),summary:{name:summary.name,counts:summary.counts,history:summary.history,completedIssues:shownCompleted,omittedIssueObservations:Number(summary.omittedIssueObservations??0)+completed.length-shownCompleted.length,summary:referencesOnly?undefined:summary.summary,decisions:decisions(summary.decisions),decisionsTruncated:summary.decisionsTruncated,
   ...(!referencesOnly&&summary.repositoryEvidence?{repositoryEvidence:evidence(summary.repositoryEvidence)}:{})}};
 });
 if(content.repositoryEvidence)content.repositoryEvidence=evidence(content.repositoryEvidence);
 if(level!=="project"){
  if(content.dependencies)content.dependencies=children(content.dependencies);
  if(content.personalProjects)content.personalProjects=children(content.personalProjects);
  if(content.organizations)content.organizations=rows(content.organizations).map(org=>{
   const projects=rows(org.dependencies),totalProjects=Number(org.projectSummaryCount??projects.length),incompleteProjects=Number(org.projectIncompleteCount??projects.filter(child=>child.status!=="complete").length);
   const selected=level==="personal"?projects.filter((child,index)=>index<3||decisions(object(child.summary).decisions).length||object(child.summary).decisionsTruncated):projects;
   return {organizationSlug:org.organizationSlug,owner:org.owner,planningInstallationId:org.planningInstallationId,reference:ref(org.reference),status:org.status,period:org.period,inputDigest:org.inputDigest,reason:org.reason,
    summary:typeof org.summary==="string"?org.summary.slice(0,1600):`${totalProjects} project reports, ${selected.length} direct project references in this preview (${totalProjects-selected.length} additional references remain in the source note); ${incompleteProjects} incomplete. Repository work and bounded observation counts remain in the revision-pinned organization note.`,
    projectSummaryCount:totalProjects,projectIncompleteCount:incompleteProjects,projectReferencesOmitted:totalProjects-selected.length,projectDetailPreviewsOmitted:level==="personal"?totalProjects:0,
    dependencies:children(selected,level==="personal")};
  });
 }
 if(level==="personal"&&content.goalContext){
  const goals=object(content.goalContext);
  content.goalContext={owner:goals.owner,capturedAt:goals.capturedAt,complete:goals.complete,errors:goals.errors,
   source:goals.source?{installationId:object(goals.source).installationId,digest:object(goals.source).digest}:null,
   references:goals.references,completeness:goals.completeness,standup:goals.standup,
   goals:rows(goals.goals).map(goal=>({title:goal.title,ref:goal.ref,observation:{status:object(goal.observation).status,value:null}})),
   representation:{kind:"definition-summary",authoredBodiesAndCalculationProseOmitted:true}};
 }
 content.representation={kind:"bounded-report-preview",repositoryObservationPreviews:true,sourceRevisionReferences:true};
 return JSON.parse(JSON.stringify(content)) as Record<string,unknown>;
}
export function boundedReportMarkdown(markdown:string,maximum=6000){
 if(markdown.length<=maximum)return markdown;
 const boundary=markdown.lastIndexOf("\n\n",maximum);
 return `${markdown.slice(0,boundary>0?boundary:maximum)}\n\n## Additional source detail\n\nThis readable preview is bounded. Open the referenced project or organization report for remaining questions and evidence; retained and omitted observation counts are in the captured source below.`;
}
