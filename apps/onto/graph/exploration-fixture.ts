const id = (i: number) => `74000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const node = (i: number, typeName: string, title: string, slug: string, website: string | null = null) => ({
  id: id(i), typeId: `${typeName === "Project" ? "planning" : "onto"}:${typeName}`, slug, title, website,
});
const edge = (i: number, typeName: string, from: string, to: string) => ({
  id: id(100 + i), typeId: `onto:${typeName}`, fromId: from, toId: to,
});

const nodes = [
  node(1, "Organization", "Fernway", "fernway"),
  node(2, "Offering", "Fernway home kit", "fernway-home-kit"),
  node(3, "Offering", "Fernway for growers", "fernway-for-growers"),
  node(4, "Product", "FW-1 soil sensor", "fw-1"),
  node(5, "Project", "FW-1 firmware", "fw-1-firmware"),
  node(6, "Project", "FW-1 enclosure", "fw-1-enclosure"),
  node(7, "Repository", "fernway/fw1-firmware", "fw1-firmware", "https://github.com/fernway/fw1-firmware"),
  node(8, "Organization", "Loam Labs", "loam-labs"),
  node(9, "Product", "Loam soil probe", "loam-soil-probe"),
];
const edges = [
  edge(1, "offered_by", "onto:Offering:fernway-home-kit", "onto:Organization:fernway"),
  edge(2, "offered_by", "onto:Offering:fernway-for-growers", "onto:Organization:fernway"),
  edge(3, "packages_product", "onto:Offering:fernway-home-kit", "onto:Product:fw-1"),
  edge(4, "packages_product", "onto:Offering:fernway-for-growers", "onto:Product:fw-1"),
  edge(5, "produces", "onto:Project:fw-1-firmware", "onto:Product:fw-1"),
  edge(6, "produces", "onto:Project:fw-1-enclosure", "onto:Product:fw-1"),
  edge(7, "source_in", "onto:Project:fw-1-firmware", "onto:Repository:fw1-firmware"),
  edge(8, "alternative_for", "onto:Product:loam-soil-probe", "onto:Offering:fernway-home-kit"),
  edge(9, "developed_by", "onto:Product:loam-soil-probe", "onto:Organization:loam-labs"),
];

export const explorationGraph = { nodes, edges };
