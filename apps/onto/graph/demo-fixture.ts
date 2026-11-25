const id = (i: number) => `72000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const node = (i: number, typeId: string, title: string, slug: string, body: string) =>
  ({ id: id(i), typeId, title, slug, body });
const edge = (i: number, typeId: string, fromId: string, toId: string, body: string, properties = {}) =>
  ({ id: id(i), typeId, fromId, toId, body, properties });

export const demoExample = {
  nodes: [
    { ...node(50, "onto:KnowledgeGraph", "Project context", "project-context", "Follow project participants, dependencies, and their providers."),
      summary: "Explore a project and its connected context.",
      properties: { root_type: "Project", pattern: JSON.stringify({ relationships: ["belongs_to_unit", "uses", { type: "participant", direction: "incoming" }, "developed_by"], max_depth: 2 }) } },
    node(1, "planning:Project", "Meze", "mezi", "A project exploring health data, in Life Sciences."),
    node(2, "onto:BusinessUnit", "Life Sciences", "life-sciences", "Projects improving everyday health."),
    node(3, "onto:Product", "Apple Health", "apple-health", "Apple's health app. Separate from the HealthKit framework."),
    node(4, "onto:Organization", "Apple", "apple", "Developer of Apple Health."),
    node(5, "onto:Person", "Project lead", "project-lead", "A human participant."),
    node(6, "planning:Project", "Other project", "other-project", "No graph attached."),
  ],
  edges: [
    edge(101, "planning:belongs_to_unit", "onto:Project:mezi", "onto:BusinessUnit:life-sciences", "Current project grouping"),
    edge(102, "onto:uses", "onto:Project:mezi", "onto:Product:apple-health", "Proposed integration; no working connector is asserted.", { status: "proposed" }),
    edge(103, "onto:developed_by", "onto:Product:apple-health", "onto:Organization:apple", "Apple develops the Health app."),
    edge(104, "onto:participant", "onto:Person:project-lead", "onto:Project:mezi", "Project participation does not grant access."),
    edge(105, "onto:lens_for", "onto:KnowledgeGraph:project-context", "onto:Project:mezi", "Project context starts at Meze."),
  ],
};
