import type { Item } from "../server/schema";

/** Reorder the full category, including hidden completed items, with the revisions read by this board. */
export function boardOrder(
	records: Pick<Item, "id" | "category" | "revision">[],
	sourceId: string,
	targetId: string,
) {
	const source = records.find((item) => item.id === sourceId),
		target = records.find((item) => item.id === targetId);
	if (
		!source ||
		!target ||
		source.id === target.id ||
		source.category !== target.category
	)
		return null;
	const category = records.filter((item) => item.category === source.category);
	const from = category.indexOf(source),
		to = category.indexOf(target);
	category.splice(from, 1);
	category.splice(to, 0, source);
	return category.map(({ id, revision }) => ({ id, revision }));
}
