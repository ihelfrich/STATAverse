import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { replaceEditor } from "./editor-helpers.js";
for (const fallback of [false, true])
  test(`factor interactions run, explain, replay and export through ${fallback ? "fallback" : "worker"}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw new Error("Worker blocked for regression test");
          }
        };
      });
    await page.goto("/Learn/");
    await page.locator("#free-mode").click();
    await replaceEditor(page, "reg hours attendance##score");
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText(
      "This model uses all available degrees of freedom",
    );
    await expect(page.locator("#results")).not.toContainText("not found");
    await expect(page.locator("#dataset-count")).toContainText("5 variables");
    await replaceEditor(
      page,
      "reg hours c.attendance##c.score, robust\npredict double fitted",
    );
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText("Created fitted");
    await page.locator("#tab-results").click();
    const coefficient = page.locator(
      '[data-coefficient="c.attendance#c.score"]',
    );
    await coefficient.click();
    await expect(
      page.locator(
        `[data-annotation="${await coefficient.getAttribute("data-result")}"]`,
      ),
    ).toContainText("attendance multiplied by score");
    await page.locator("#tab-data").click();
    await expect(page.locator('[data-variable="fitted"]')).toBeVisible();
    await page.reload();
    await expect(page.locator("#run")).toBeEnabled();
    await expect(page.locator('[data-variable="fitted"]')).toBeVisible();
    await page.locator("#undo").click();
    await expect(page.locator('[data-variable="fitted"]')).toHaveCount(0);
    await replaceEditor(page, "predict double fitted");
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText("Created fitted");
    await page.locator("#export-open").click();
    const waiting = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download complete Stata project (.zip)" })
      .click();
    const download = await waiting;
    const archive = unzipSync(await fs.readFile(await download.path()));
    expect(strFromU8(archive["analysis.do"])).toContain(
      "reg hours c.attendance##c.score, robust",
    );
    expect(strFromU8(archive["analysis.do"])).toContain(
      "predict double fitted",
    );
  });
test("an invalid categorical measurement points to the continuous syntax", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(
    page,
    "generate double ratio=hours/3\nreg score attendance##ratio",
  );
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText(
    "nonnegative integer values",
  );
  await expect(page.locator("#results")).toContainText("c.ratio");
  await replaceEditor(page, "reg score c.attendance##c.ratio");
  await page.locator("#run").click();
  await expect(
    page.locator('[data-coefficient="c.attendance#c.ratio"]'),
  ).toBeVisible();
});
