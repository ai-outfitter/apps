import { randomUUID } from "node:crypto";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import type { Object3D } from "three";
import { projectSlug } from "../src/lib/sections";
import { documents } from "../src/server/documents";

type Vector = [number, number, number];

// Tier 2: a field researcher inspects a modular sensor rig with a sealed purchased cartridge.
test("authored explosions move rendered occurrences and preserve installed state", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), "field");
  const member = { userId: "researcher", organizationId: "field", role: "member" };
  const origin = "https://workshop.outfitter.example";
  type Document = "UpdateWorkshopAssembly" | "WorkshopAssembly" | "ResolvedWorkshopAssembly" | "WorkshopPrint";
  async function graph(name: Document, variables: object) {
    const response = await app.call("/api/internal/actions/v1/call", member, {
      method: "POST",
      body: { action: name === "UpdateWorkshopAssembly" ? "graph.mutate" : "graph.graphql",
        input: { query: documentText(documents[name].document), variables } },
    });
    expect(response.ok).toBe(true);
    const { data, errors } = await response.json();
    expect(errors).toBeUndefined();
    return Object.values(data)[0];
  }
  async function create(name: string) {
    const reply = await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { name, example: "cube" } });
    expect(reply.ok).toBe(true);
    return await reply.json() as { id: string; name: string; revision: number };
  }
  try {
    const project = await create("Sensor rig");
    const source = await create("Purchased cartridge");
    const [root, mixed, legacy, cartridge, inner, part, bought, rigidRef, freeRef] = Array.from({ length: 9 }, () => randomUUID());
    const item = (id: string, name: string) => ({ id, name, number: name, revision: "A", kind: "assembly" });
    const use = (itemId: string, position: Vector = [0, 0, 0]) => ({ id: randomUUID(), itemId, position, quantity: 1 });
    const fixed = { fixed: true };
    const mixedUse = { ...use(mixed, [10, 0, 0]), rotation: 90, explode: { offset: [0, 0, 20] } };
    const legacyUse = use(legacy, [-50, 0, 0]);
    const rigidUse = { ...use(rigidRef, [0, 35, 0]), explode: { offset: [0, 0, -12], rigid: true } };
    const freeUse = { ...use(freeRef, [0, -35, 0]), explode: fixed };
    const moving = { ...use(bought, [-15, 0, 0]), explode: { offset: [16, 0, 0] } };
    const explicitZero = { ...use(part, [0, 0, 0]), explode: { offset: [0, 0, 0] } };
    const stationary = { ...use(bought, [15, 0, 0]), explode: fixed };
    const omitted = use(part, [30, 0, 0]);
    const staged = { ...use(part, [45, 0, 0]), explode: { offset: [0, 0, 24], step: 2 } };
    const autoLeft = use(part, [-20, 0, 0]);
    const autoRight = use(bought, [20, 0, 0]);
    const innerUse = { ...use(inner), explode: { offset: [0, 25, 0] } };
    const caseUse = use(bought, [-15, 0, 0]);
    const inside = { ...use(bought, [15, 0, 0]), explode: { offset: [0, 0, 30] } };
    const size: Vector = [10, 10, 10];
    const geometry = { version: 1, units: "mm", features: [{ kind: "box", mode: "add", origin: [0, 0, 0], size }] };
    const partItem = { ...item(part, "Printed bracket"), kind: "printed", geometry };
    const boughtItem = { ...item(bought, "Purchased sensor"), kind: "cots", geometry, priceKnown: true, unitCost: 12 };
    await graph("UpdateWorkshopAssembly", { projectId: source.id, expectedRevision: source.revision, assembly: {
      rootId: cartridge, items: [
        { ...item(cartridge, "Cartridge"), uses: [caseUse, innerUse] },
        { ...item(inner, "Internal frame"), uses: [inside] },
        boughtItem,
      ],
    } });
    const assembly = { rootId: root, items: [
      { ...item(root, "Rig"), uses: [mixedUse, legacyUse, rigidUse, freeUse] },
      { ...item(mixed, "Service bay"), uses: [moving, explicitZero, stationary, omitted, staged] },
      { ...item(legacy, "Legacy mount"), uses: [autoLeft, autoRight] },
      { ...item(rigidRef, "Sealed mount"), reference: { projectId: source.id } },
      { ...item(freeRef, "Unsealed mount"), reference: { projectId: source.id } },
      partItem, boughtItem,
    ] };
    await graph("UpdateWorkshopAssembly", { projectId: project.id, expectedRevision: project.revision, assembly });
    const location = { input: { projectId: project.id } };
    const saved = await graph("WorkshopAssembly", location.input);
    expect(saved).toMatchObject({ assembly });
    const resolved = await graph("ResolvedWorkshopAssembly", location);
    expect(resolved).toMatchObject({ assembly: { items: expect.arrayContaining([
      expect.objectContaining({ id: root, uses: expect.arrayContaining([
        expect.objectContaining({ id: rigidUse.id, explode: rigidUse.explode }),
        expect.objectContaining({ id: freeUse.id, explode: freeUse.explode }),
      ]) }),
      expect.objectContaining({ id: rigidRef, uses: expect.arrayContaining([
        expect.objectContaining({ id: innerUse.id, explode: innerUse.explode }),
      ]) }),
    ]) } });
    const print = await graph("WorkshopPrint", location);
    const writes: string[] = [];
    await page.route(origin + "/**", async route => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET") writes.push(request.method() + " " + url.pathname);
      await fulfillFrom(route, await app.call(url.pathname + url.search, member));
    });
    // The Three.js devtools hook exposes the actual scene without a Workshop test API.
    await page.addInitScript(() => {
      const hook = new EventTarget();
      Reflect.set(window, "__THREE_DEVTOOLS__", hook);
      hook.addEventListener("observe", event => {
        const object = (event as CustomEvent<Object3D>).detail;
        if (object.type === "Scene") Reflect.set(window, "workshopTestScene", object);
      });
    });
    await page.goto(origin + "/projects/" + projectSlug(project));
    await expect(page.locator("#assembly-viewer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await page.getByRole("button", { name: "Explode 0%" }).click();
    const range = page.getByRole("slider", { name: "Explode amount" });
    const snapshot = () => page.evaluate(() => {
      const scene: Object3D = Reflect.get(window, "workshopTestScene");
      scene.updateMatrixWorld(true);
      const nodes: Record<string, { matrix: number[]; visible: boolean }> = {};
      scene.traverse(node => {
        if (node.userData.path) nodes[node.userData.path] = { matrix: node.matrixWorld.toArray(), visible: node.visible };
      });
      return nodes;
    });
    const rest = await snapshot();
    expect(Object.keys(rest)).toHaveLength(11);
    const path = (...uses: { id: string }[]) => [root, ...uses.map(usage => usage.id + "#0")].join("/");
    const key = {
      moving: path(mixedUse, moving), zero: path(mixedUse, explicitZero),
      fixed: path(mixedUse, stationary), omitted: path(mixedUse, omitted), staged: path(mixedUse, staged),
      autoLeft: path(legacyUse, autoLeft), autoRight: path(legacyUse, autoRight),
      sealedCase: path(rigidUse, caseUse), sealedInner: path(rigidUse, innerUse, inside),
      freeCase: path(freeUse, caseUse), freeInner: path(freeUse, innerUse, inside),
    };
    const setAmount = (amount: number) => range.evaluate((element, value) => {
      (element as HTMLInputElement).value = String(value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, amount);
    const amounts = [0, 50, 100];
    const zero: Vector = [0, 0, 0];
    async function check(deltas: Record<string, Vector>, visible = Object.values(key)) {
      const nodes = await snapshot();
      expect(Object.keys(nodes).filter(id => nodes[id].visible).sort()).toEqual([...visible].sort());
      for (const id of Object.keys(nodes)) {
        const matrix = nodes[id].matrix;
        for (const [index, value] of rest[id].matrix.entries()) {
          const delta = (deltas[id] ?? zero)[index - 12] ?? 0;
          expect(matrix[index], `matrix ${id}[${index}]`).toBeCloseTo(value + delta, 8);
        }
      }
    }
    const outer = (amount: number): Record<string, Vector> => ({
      ...Object.fromEntries([key.moving, key.zero, key.fixed, key.omitted, key.staged].map(id => [id, [0, 0, amount / 5] as Vector])),
      [key.sealedCase]: [0, 0, -amount * 0.12], [key.sealedInner]: [0, 0, -amount * 0.12],
    });
    for (const amount of amounts) { await setAmount(amount); await check(outer(amount)); }

    const ready = () => expect(page.locator("#assembly-viewer")).toHaveAttribute("data-ready", "true", { timeout: 60000 });
    const open = async (target: ReturnType<typeof page.locator>) => { await target.click(); await ready(); };
    const enter = (name: string) => open(page.locator("#occurrence-list").getByRole("link", { name, exact: true }));
    const back = () => open(page.locator("#occurrence-crumbs a[data-parent]"));
    await enter("Service bay");
    for (const amount of amounts) {
      await setAmount(amount);
      await check({ [key.moving]: [0, amount ? 16 : 0, 0], [key.staged]: [0, 0, amount === 100 ? 24 : 0] },
        [key.moving, key.zero, key.fixed, key.omitted, key.staged]);
    }
    await back();
    await expect(range).toHaveValue("100");
    await expect(page.getByRole("link", { name: "Service bay", exact: true })).toHaveAttribute("aria-current", "true");
    await check(outer(100));

    // Reference resolution uses the source's label for each mount. Enter by its occurrence row.
    const enterPath = (id: string) => open(page.locator(`#occurrence-list a[data-focus="${id}"]`));
    await enterPath(path(rigidUse));
    for (const amount of amounts) { await setAmount(amount); await check({}, [key.sealedCase, key.sealedInner]); }
    await enter("Internal frame");
    for (const amount of amounts) { await setAmount(amount); await check({}, [key.sealedInner]); }
    await back();
    await expect(range).toHaveValue("100");
    await back();
    await check(outer(100));

    await enterPath(path(freeUse));
    for (const amount of amounts) {
      await setAmount(amount);
      await check({ [key.freeInner]: [0, amount * 0.25, 0] }, [key.freeCase, key.freeInner]);
    }
    await enter("Internal frame");
    for (const amount of amounts) {
      await setAmount(amount);
      await check({ [key.freeInner]: [0, 0, amount * 0.3] }, [key.freeInner]);
    }
    await back();
    await back();
    await enter("Legacy mount");
    // Equal heights retain assembly order; the second part clears the first by the 10 mm gap.
    for (const amount of amounts) {
      const spread = (size[2] + 10) * amount / 100;
      await setAmount(amount);
      await check({ [key.autoLeft]: zero, [key.autoRight]: [0, 0, spread] }, [key.autoLeft, key.autoRight]);
    }
    await back();
    await check(outer(100));
    await page.getByRole("button", { name: "Set to assembled" }).click();
    await check({});
    expect(new URL(page.url()).searchParams.has("explode")).toBe(false);
    expect(writes).toEqual([]);
    expect(await graph("WorkshopAssembly", location.input)).toEqual(saved);
    expect(await graph("ResolvedWorkshopAssembly", location)).toEqual(resolved);
    expect(await graph("WorkshopPrint", location)).toEqual(print);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
