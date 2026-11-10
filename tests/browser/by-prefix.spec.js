import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { replaceEditor } from "./editor-helpers.js";
for (const fallback of [false, true])
  test(`bysort, subscripts and string functions run, replay and export through ${fallback ? "fallback" : "worker"}`, async ({
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
      "bysort group (id): generate double position = _n\nby group: generate double previous = hours[_n-1]\ngenerate initial = upper(substr(group, 1, 1))\ncount if position == 1",
    );
    await page.locator("#run").click();
    await expect(page.locator("#run")).toBeEnabled();
    await expect(page.locator("#results")).not.toContainText("not supported");
    await page.locator("#tab-data").click();
    for (const name of ["position", "previous", "initial"])
      await expect(page.locator(`[data-variable="${name}"]`)).toBeVisible();
    await page.reload();
    await expect(page.locator("#run")).toBeEnabled();
    await page.locator("#tab-data").click();
    await expect(page.locator('[data-variable="previous"]')).toBeVisible();
    await replaceEditor(
      page,
      "sort hours\nby group: generate double unsorted = 1",
    );
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText("not sorted");
    await expect(page.locator("#results")).toContainText("bysort");
    await page.locator("#tab-data").click();
    await expect(page.locator('[data-variable="unsorted"]')).toHaveCount(0);
    await replaceEditor(page, "bysort group: summarize score hours");
    await page.locator("#run").click();
    await expect(
      page.getByRole("region", { name: "Summary statistics by group" }),
    ).toBeVisible();
    await replaceEditor(page, "bysort group: tabulate score");
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText(
      "by with tabulate is not supported",
    );
    await page.locator("#export-open").click();
    const wait = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download complete Stata project (.zip)" })
      .click();
    const zip = unzipSync(await fs.readFile(await (await wait).path()));
    const source = strFromU8(zip["analysis.do"]);
    expect(source).toContain(
      "bysort group (id): generate double position = _n",
    );
    expect(source).toContain("by group: generate double previous");
  });
