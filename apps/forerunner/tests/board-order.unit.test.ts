import assert from "node:assert/strict";
import test from "node:test";
import { boardOrder } from "../src/scripts/board-order";
const rows = [
	{ id: "first", category: "stone" as const, revision: 2 },
	{ id: "hidden-completed", category: "stone" as const, revision: 9 },
	{ id: "last", category: "stone" as const, revision: 3 },
	{ id: "child", category: "pebble" as const, revision: 4 },
];
test("drag order includes the complete category and its current revisions without moving children", () => {
	assert.deepEqual(boardOrder(rows, "last", "first"), [
		{ id: "last", revision: 3 },
		{ id: "first", revision: 2 },
		{ id: "hidden-completed", revision: 9 },
	]);
	assert.deepEqual(
		rows.map((row) => row.id),
		["first", "hidden-completed", "last", "child"],
	);
	assert.equal(boardOrder(rows, "child", "first"), null);
	assert.equal(boardOrder(rows, "missing", "first"), null);
	assert.equal(boardOrder(rows, "first", "first"), null);
});
