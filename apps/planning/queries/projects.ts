/** Organization-rooted projects and Wiki goals: used by the page and available to MCP Viewer selections. */
export const projectsViewerQuery = `query PlanningProjects($slugs:[String!],$after:String,$states:[String!]) {
  viewer { orgs(slugs:$slugs) {
    slug
    projects(first:50,after:$after,states:$states) {
      nodes { id revision name slug githubRepository goals openIssues archived state rank
        useCases {id title summary revision} customerSegments {id title summary revision}
        userStories:userStoryRecords {id title summary revision} goalRecords {id title summary revision}
        readiness {stage priority missing signals}
      }
      pageInfo {endCursor hasNextPage}
    }
    organizationGoals(first:1) { nodes { id revision title summary truncated
      goals {id title summary revision metrics {id title summary}}
    } }
  } }
}`;
