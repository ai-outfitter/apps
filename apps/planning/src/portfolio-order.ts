/** Move one visible item while retaining the complete authorized order, including unseen items. */
export function movePortfolioItem(items: readonly string[], source: string, target: string) {
  const from=items.indexOf(source),to=items.indexOf(target);
  if(from<0 || to<0 || from===to)return null;
  const moved=[...items];moved.splice(to,0,...moved.splice(from,1));return moved;
}
