import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The repository the box left on its default branch.
const root = import.meta.dirname;

test("index.mjs exports a working subtract", async () => {
  const { add, subtract } = await import(join(root, "index.mjs"));
  expect(add(2, 3)).toBe(5);
  expect(subtract(5, 3)).toBe(2);
  expect(subtract(-1, 4)).toBe(-5);
});

test("a node:test test covers subtract and npm test passes", () => {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.test\.m?js$/.test(file) && !file.includes("node_modules"));
  expect(files.some((file) => readFileSync(join(root, file), "utf8").includes("subtract"))).toBe(true);
  execFileSync("npm", ["test"], { cwd: root, stdio: "pipe" });
});
