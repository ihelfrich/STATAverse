import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { replaceEditor } from "./editor-helpers.js";
for (const fallback of [false, true])
  test(`capture, quiet output, _rc, replay and export through ${fallback ? "fallback" : "worker"}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw new Error("Test blocked worker");
          }
        };
      });
    await page.goto("/Learn/");
    await page.locator("#free-mode").click();
    await replaceEditor(
      page,
      "capture drop temporary\ngenerate double temporary=_rc\nquietly summarize temporary",
    );
    await page.locator("#run").click();
    await expect(page.locator("#run")).toBeEnabled();
    await page.locator("#tab-history").click();
    await expect(page.locator("#command-history")).toContainText(
      "Captured r(111)",
    );
    await expect(page.locator("#command-history")).toContainText(
      "Output suppressed",
    );
    await replaceEditor(
      page,
      "capture noisily {\n  generate double started=1\n  confirm variable absent\n  generate double skipped=1\n}\ndisplay _rc",
    );
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText("Execution continued");
    await expect(page.locator("#results")).toContainText("111");
    await page.locator("#tab-data").click();
    await expect(page.locator('[data-variable="started"]')).toBeVisible();
    await expect(page.locator('[data-variable="skipped"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#run")).toBeEnabled();
    await replaceEditor(page, "display _rc");
    await page.locator("#run").click();
    await expect(page.locator("#results .result-card").first()).toContainText(
      "111",
    );
    await page.locator("#undo").click();
    await page.locator("#undo").click();
    await page.locator("#undo").click();
    await expect(page.locator('[data-variable="started"]')).toHaveCount(0);
    await page.locator("#export-open").click();
    const wait = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download complete Stata project (.zip)" })
      .click();
    const download = await wait;
    const zip = unzipSync(await fs.readFile(await download.path()));
    const source = strFromU8(zip["analysis.do"]);
    expect(source).toContain("capture drop temporary");
    expect(source).toContain("quietly summarize temporary");
  });
test("quiet-only work leaves a clear history link and an uncaptured error still stops execution", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "capture confirm variable absent");
  await page.locator("#run").click();
  await page.locator("#tab-results").click();
  await expect(page.locator("#results")).toContainText("No output to display");
  await expect(page.locator("#results")).not.toContainText("not found");
  await replaceEditor(page, "quietly drop absent\ngenerate double skipped=1");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("r(111)");
  await expect(page.locator('[data-variable="skipped"]')).toHaveCount(0);
});
