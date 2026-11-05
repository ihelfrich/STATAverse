import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

async function run(page, command) {
  await page.locator("#command-editor").fill(command);
  await page.locator("#run").click();
}

test("group statistics expose their calculation sample while retaining individual observations", async ({
  page,
}, testInfo) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await run(page, "egen double group_score = mean(score), by(group)");
  const result = page.locator("#results .result-card").first();
  await expect(result.locator("tbody tr")).toHaveCount(2);
  await expect(result.locator("tbody tr").first()).toContainText(
    "11 nonmissing",
  );
  await expect(result.locator("tbody tr").last()).toContainText(
    "12 nonmissing",
  );
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 6 variables",
  );
  await page.locator("#tab-data").click();
  await expect(page.locator("#dataset-unit")).toHaveText(
    "One fictional student",
  );
  await expect(page.locator("#data-table tbody tr")).toHaveCount(24);
  await page.locator("#tab-results").click();
  await result
    .getByRole("button", {
      name: "Inspect source rows for group A",
      exact: true,
    })
    .click();
  await expect(page.locator("#group-inspection")).toContainText(
    "12 selected source observations",
  );
  await expect(
    page.locator("#group-inspection .result-table").last().locator("tbody tr"),
  ).toHaveCount(12);
  await page.screenshot({
    path: `docs/verification/screenshots/group-inspection-${testInfo.project.name}.png`,
  });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    result.getByRole("button", {
      name: "Inspect source rows for group A",
      exact: true,
    }),
  ).toBeFocused();
  await run(page, "replace score = 0");
  await page.locator("#tab-results").click();
  await page
    .getByRole("button", {
      name: "Inspect source rows for group A",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator("#group-inspection .result-table")
      .last()
      .locator("tbody tr")
      .first(),
  ).toContainText("48");
});

test("collapse changes the displayed unit, survives reload and exports the actual grouped workflow", async ({
  page,
}, testInfo) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await run(
    page,
    "preserve\ncollapse (mean) mean_score=score (count) n_score=score, by(group)",
  );
  await expect(page.locator("#dataset-count")).toContainText(
    "2 observations · 3 variables",
  );
  await expect(page.locator("#dataset-unit")).toHaveText("One summary group");
  await page.locator("#tab-history").click();
  await expect(page.locator("#command-history")).toContainText(
    "24 observations replaced by 2 summary rows",
  );
  await page.reload();
  await expect(page.locator("#dataset-unit")).toHaveText("One summary group");
  await expect(page.locator("#preserve-status")).toContainText(
    "24 observations",
  );
  await page.locator("#export-open").click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download complete Stata project (.zip)" })
    .click();
  const download = await downloaded,
    files = unzipSync(await fs.readFile(await download.path()));
  expect(strFromU8(files["analysis.do"])).toContain(
    "collapse (mean) mean_score=score (count) n_score=score, by(group)",
  );
  expect(strFromU8(files["analysis.do"])).toContain("restore, not");
  expect(strFromU8(files["current-data.csv"]).trim().split("\n")).toHaveLength(
    3,
  );
  await page.locator("#export-dialog [data-close]").click();
  await page.locator("#tab-results").click();
  await page.screenshot({
    path: `docs/verification/screenshots/grouped-data-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await run(page, "restore");
  await expect(page.locator("#dataset-unit")).toHaveText(
    "One fictional student",
  );
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 5 variables",
  );
});

test("casewise collapse reports excluded rows and invalid output names leave the dataset intact", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await run(page, "collapse (mean) hours score (count) n=score, by(group) cw");
  await expect(page.locator("#results .result-card").first()).toContainText(
    "2 selected observations were excluded",
  );
  await expect(
    page.locator("#results .result-card").first().locator("tbody tr").first(),
  ).toContainText("10 nonmissing");
  await run(page, "collapse (mean) group=score, by(group)");
  await expect(page.locator("#results .result-card").first()).toContainText(
    "cannot replace a by() variable",
  );
  await expect(page.locator("#dataset-count")).toContainText(
    "2 observations · 4 variables",
  );
});
