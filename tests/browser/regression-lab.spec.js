import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs/promises";

test("regression lab connects original and residualized observations with actual estimates", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/Labs/");
  await expect(page.locator("#coefficient-comparison tbody tr")).toHaveCount(2);
  const original = await page.locator("#coefficient-comparison").textContent();
  await page.locator("#parameter-rho").fill("0");
  await expect(page.locator("#coefficient-comparison")).not.toHaveText(
    original,
  );
  await page.locator("#raw-plot [data-observation='17']").click();
  await expect(page.locator("#selected-observation")).toHaveValue("17");
  await expect(
    page.locator("#partial-plot [data-observation='17']"),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator("#raw-plot [data-observation='17']").press("ArrowRight");
  await expect(page.locator("#selected-observation")).toHaveValue("18");
  await expect(page.locator("#raw-plot [data-observation='18']")).toBeFocused();
  await page.locator("#lab-tab-partial").click();
  await expect(page.locator("#residual-steps")).toContainText("Observation 18");
  const slopes = await page.locator("#fwl-equality strong").allTextContents();
  expect(slopes[0]).toBe(slopes[1]);
  await expect(page.locator("#partial-table tbody tr")).toHaveCount(100);
  expect(errors).toEqual([]);
});

test("lab exposes sensitivity without deleting observations and exports modified data", async ({
  page,
}) => {
  await page.goto("/Labs/");
  await page.locator("#lab-tab-influence").click();
  await page.locator("#influence-observation").fill("37");
  await page.locator("#influence-observation").press("Tab");
  const original = await page
    .locator("#deletion-comparison tbody")
    .textContent();
  await page.locator("#modify-x").fill("6");
  await page.locator("#modify-y").fill("-12");
  await expect(page.locator("#modified-warning")).toBeVisible();
  await expect(page.locator("#deletion-comparison tbody")).not.toHaveText(
    original,
  );
  const downloadWait = page.waitForEvent("download");
  await page.locator("#export-lab").click();
  const download = await downloadWait;
  const files = unzipSync(await fs.readFile(await download.path()));
  const config = JSON.parse(strFromU8(files["experiment.json"]));
  expect(config.perturbation).toEqual({ id: 37, dx: 6, dy: -12 });
  expect(
    strFromU8(files["regression-lab.csv"]).trim().split("\n"),
  ).toHaveLength(101);
  expect(strFromU8(files["analysis.do"])).toContain("avplot x");
  expect(strFromU8(files["analysis.do"])).toContain(
    "Observation 37 was manually modified",
  );
  await page.locator("#remove-modification").click();
  await expect(page.locator("#deletion-comparison tbody")).toHaveText(original);
});

test("lab invalid seeds are rejected and robust inference retains coefficients", async ({
  page,
}) => {
  await page.goto("/Labs/");
  const coefficients = await page
    .locator("#coefficient-comparison tbody tr td:nth-child(2)")
    .allTextContents();
  await page.locator("#robust-covariance").check();
  expect(
    await page
      .locator("#coefficient-comparison tbody tr td:nth-child(2)")
      .allTextContents(),
  ).toEqual(coefficients);
  await expect(page.locator("#coefficient-comparison")).toContainText(
    "HC1 robust",
  );
  await page.locator("#random-seed").fill("-1");
  await page.locator("#random-seed").press("Tab");
  await expect(page.locator("#lab-error")).toContainText("Change not applied");
  await page.locator("#reset-experiment").click();
  await expect(page.locator("#lab-error")).toBeHidden();
  await expect(page.locator("#random-seed")).toHaveValue("2026");
});

test("all analysis views are accessible, bounded on mobile and usable offline", async ({
  page,
  context,
}) => {
  await page.goto("/Labs/");
  await page.locator("#scenario").selectOption("reversal");
  await expect(page.locator("#scenario-description")).toContainText(
    "negative unadjusted slope",
  );
  for (const name of ["overview", "partial", "influence", "stata"]) {
    await page.locator(`#lab-tab-${name}`).click();
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      audit.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      name,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      name,
    ).toBe(true);
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.locator("#parameter-beta").fill("0");
  await expect(page.locator("#experiment-reading")).toContainText(
    "direct effect is 0",
  );
  await context.setOffline(false);
});
