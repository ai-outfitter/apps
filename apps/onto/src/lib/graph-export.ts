import type { Graph } from "./graph";

const quote = (s: string) => JSON.stringify(s);

export function graphBundle(graph: Graph) {
  const types = new Map(graph.types.map((t) => [t.id, t]));
  // Names are readable hints; IDs, including each endpoint, remain canonical.
  const path = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    return node
      ? `Nodes/${node.title.replace(/[\\/:*?"<>|#^[\]\r\n]/g, "-")}--${id}`
      : `Types/${types.get(id)?.name ?? "Type"}--${id}`;
  };
  const notes = [
    ...graph.types.map((t) => ({
      path: `${path(t.id)}.md`,
      markdown: `---\nid: ${quote(t.id)}\nrecord: type\nrevision: ${t.revision}\ncategory: ${t.category}\nname: ${quote(t.name)}\n---\n\n# ${t.title}\n\n${t.body}\n\nProperties and classification:\n\n\`\`\`json\n${JSON.stringify({ properties: t.properties }, null, 2)}\n\`\`\`\n`,
    })),
    ...graph.nodes.map((n) => {
      const relations = graph.edges.filter(
        (e) => !e.archived && e.fromId === n.id,
      );
      const grouped = new Map<string, string[]>();
      for (const e of relations) {
        const name = types.get(e.typeId)?.name ?? "related";
        grouped.set(name, [
          ...(grouped.get(name) ?? []),
          `[[${path(e.toId)}]]`,
        ]);
      }
      const yaml = [...grouped]
        .map(
          ([name, targets]) =>
            `${name}:\n${targets.map((t) => `  - ${quote(t)}`).join("\n")}`,
        )
        .join("\n");
      return {
        path: `${path(n.id)}.md`,
        markdown: `---\nid: ${quote(n.id)}\nrecord: node\ntype_id: ${quote(n.typeId)}\ntype: ${quote(types.get(n.typeId)?.name ?? "Entity")}\nrevision: ${n.revision}\n${yaml}\n---\n\n# ${n.title}\n\n${n.summary}\n\n${n.body}\n`,
      };
    }),
    ...graph.edges.map((e) => ({
      path: `Relationships/${e.id}.md`,
      markdown: `---\nid: ${quote(e.id)}\nrecord: edge\ntype_id: ${quote(e.typeId)}\nrevision: ${e.revision}\nsource_id: ${quote(e.fromId)}\ntarget_id: ${quote(e.toId)}\nsource: ${quote(`[[${path(e.fromId)}]]`)}\ntarget: ${quote(`[[${path(e.toId)}]]`)}\n${Object.entries(
        e.properties,
      )
        .map(([k, v]) => `property_${k}: ${JSON.stringify(v)}`)
        .join(
          "\n",
        )}\n---\n\n# ${types.get(e.typeId)?.title ?? "Relationship"}\n\n${e.body}\n`,
    })),
  ];
  return {
    format: "outfitter-wiki-graph-v1",
    notes,
    graph,
    interoperability:
      "Markdown is an export. Stable IDs resolve links; arbitrary Markdown import is not implemented. The graph records are the editable source of truth.",
  };
}
