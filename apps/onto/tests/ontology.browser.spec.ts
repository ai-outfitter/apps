import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appWorker as initializedAppWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import {
  ids,
  definitions,
  people,
  marriage,
  create,
  claimBody,
} from "./fixtures/relators";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const origin = "https://wiki.outfitter.example";
test("review an assertion, explicitly confirm it, and follow a derived spouse view", async ({
  page,
}, info) => {
  const app = await initializedAppWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  try {
    const response = await app.call("/api/internal/actions/v1/call", owner, {
      method: "POST",
      body: {
        action: "graph.apply",
        input: {
          requestKey: "browser-fixture",
          operations: [
            ...definitions(),
            ...people(),
            ...marriage(),
            create("$claim", "graph-node", {
              id: ids.claim,
              typeId: ids.assertion,
              title: "Review a relationship claim",
              slug: "test-claim",
              body: JSON.stringify(claimBody()),
            }),
          ],
        },
      },
    });
    expect(response.status, await response.text()).toBe(200);
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      await fulfillFrom(
        route,
        await app.call(url.pathname + url.search, owner, {
          method: request.method(),
          ...(request.postData() ? { body: request.postDataJSON() } : {}),
        }),
      );
    });
    await test.step("review uncertainty, source evidence and the exact subject", async () => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`${origin}/test-assertions/${ids.claim}`);
      await expect(
        page.getByRole("heading", { name: "Assertion and evidence" }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText("Not confirmed");
      await expect(page.getByText("Alex", { exact: true })).toBeVisible();
      await expect(page.getByText("Cristina", { exact: true })).toBeVisible();
      await expect(
        page
          .locator("p")
          .filter({ hasText: /calendar title alone establishes no marriage/ }),
      ).toBeVisible();
      await info.attach("assertion-review-desktop", {
        body: await page.screenshot({
          fullPage: true,
          path: info.outputPath("assertion-review-desktop.png"),
        }),
        contentType: "image/png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await info.attach("assertion-review-mobile", {
        body: await page.screenshot({
          fullPage: true,
          path: info.outputPath("assertion-review-mobile.png"),
        }),
        contentType: "image/png",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
    await test.step("dismissal records nothing; explicit confirmation records the member", async () => {
      page.once("dialog", (dialog) => dialog.dismiss());
      await page
        .getByRole("button", { name: "Confirm assertion", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("Not confirmed");
      expect(
        await app.database
          .prepare("SELECT assertionId FROM graph_assertion_confirmations")
          .first(),
      ).toBeNull();
      const amendment = await app.call("/api/internal/actions/v1/call", owner, {
        method: "POST",
        body: {
          action: "graph.apply",
          input: {
            requestKey: "changed-during-review",
            operations: [
              {
                operation: "update",
                ref: "$participant",
                type: "graph-edge",
                id: ids.secondSpouse,
                revision: 1,
                attributes: { toId: ids.nicholas },
              },
            ],
          },
        },
      });
      expect(amendment.status).toBe(200);
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("button", { name: "Confirm assertion", exact: true })
        .click();
      await expect(page.locator("#notice")).toContainText(
        "Assertion or subject changed",
      );
      expect(
        await app.database
          .prepare("SELECT assertionId FROM graph_assertion_confirmations")
          .first(),
      ).toBeNull();
      await page.reload();
      await expect(page.getByText("Nicholas", { exact: true })).toBeVisible();
      await expect(page.getByText("Cristina", { exact: true })).toHaveCount(0);
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("button", { name: "Confirm assertion", exact: true })
        .click();
      await expect(page.getByRole("status")).toHaveText(
        "Confirmed by a member for this assertion and subject.",
      );
      await expect(
        page.getByRole("button", { name: "Confirm assertion", exact: true }),
      ).toHaveCount(0);
    });
    await test.step("the existing Connections view exposes the derived relation and its source", async () => {
      await page.goto(`${origin}/people/${ids.alex}/connections`);
      const relationships = page.locator(".graph-relations");
      await expect(relationships).toContainText("spouse of");
      await expect(relationships).toContainText("↔");
      await expect(relationships).toContainText("derived from");
      await expect(
        relationships.getByRole("link", { name: "Synthetic marriage" }),
      ).toHaveCount(2);
      await info.attach("derived-spouse-connections-mobile", {
        body: await page.screenshot({
          fullPage: true,
          path: info.outputPath("derived-spouse-connections-mobile.png"),
        }),
        contentType: "image/png",
      });
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("record pages show declared measurement fields and multiline formulas", async ({page}, info) => {
  const app=await appWorker("wiki-map",appArtifact(new URL("..",import.meta.url),"operational"));
  try {
    const initialized=await app.call("/api/internal/app-initialize",owner,{method:"POST",body:{}});
    expect(initialized.status,await initialized.text()).toBe(200);
    const id="a0000000-0000-4000-8000-000000000987";
    const formula="CASE\n  WHEN addressed_at_epoch <= triggered_at_epoch + threshold * 3600 THEN 'met'\n  ELSE 'breached'\nEND";
    const created=await app.call("/api/internal/actions/v1/call",owner,{method:"POST",body:{action:"graph.apply",input:{requestKey:"measurement-fields",operations:[create("$type","graph-type",{id:"a0000000-0000-4000-8000-000000000986",name:"MeasurementDisplay",title:"Measurement display",body:"Test display fields",category:"node",properties:[{name:"threshold",type:"number",description:"Threshold"},{name:"formula",type:"string",description:"Formula"},{name:"formula_language",type:"string",description:"Formula language"}]}),create("$control","graph-node",{id,typeId:"a0000000-0000-4000-8000-000000000986",title:"Measured response control",properties:{threshold:8,formula,formula_language:"SQL expression; definition only"}})]}}});
    expect(created.status,await created.text()).toBe(200);
    await page.route(`${origin}/**`,async route=>{
      const request=route.request(),url=new URL(request.url());
      await fulfillFrom(route,await app.call(url.pathname+url.search,owner,{method:request.method(),...(request.postData()?{body:request.postDataJSON()}: {})}));
    });
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      await page.goto(`${origin}/measurement-displays/${id}`);
      await page.getByRole("tab",{name:"Technical",exact:true}).click();
      const fields=page.locator("section").filter({has:page.getByRole("heading",{name:"Record properties",exact:true})});
      await expect(fields.getByText("Threshold",{exact:true})).toBeVisible();
      await expect(fields.locator("dd").filter({hasText:/^8$/})).toBeVisible();
      await expect(fields.locator("dd").filter({hasText:"CASE"})).toHaveText(formula);
      await expect(fields.getByText("SQL expression; definition only",{exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await page.screenshot({path:info.outputPath(`measurement-fields-${width}.png`),fullPage:true});
    }
  } finally {await page.unrouteAll({behavior:"wait"});await app.dispose();}
});
