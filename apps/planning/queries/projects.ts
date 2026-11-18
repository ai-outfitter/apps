/** Directory-only fields: detailed story/context summaries belong on the project page. */
export const projectsViewerQuery = `query PlanningProjects($slugs:[String!],$after:String,$states:[String!]) {
  viewer { orgs(slugs:$slugs) {
    slug
    projects(first:20,after:$after,states:$states) {
      nodes { id revision name slug githubRepository goals openIssues archived state rank
        goalRecords {id title}
        readiness {stage priority missing signals}
      }
      pageInfo {endCursor hasNextPage}
    }
    organizationGoals(first:1) { nodes { id revision title summary truncated
      goals {id title summary revision metrics {id title summary}}
    } }
  } }
}`;
