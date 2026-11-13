import { test, expect } from "@playwright/test";
import { screenshotPath } from "../../tools/receipts.mjs";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("merge traces matched and unmatched records, filters counts and retains a keyboard selection", async ({
  page,
}, testInfo) => {
  await page.goto("/Labs/Data/");
  await expect(page.locator("#output-table tbody tr")).toHaveCount(8);
  expect(
    await page
      .locator("#output-table .data-table-wrap")
      .evaluate((node) => node.scrollHeight <= node.clientHeight),
  ).toBe(true);
  await expect(page.locator("#result-summary")).toHaveText("8 rows retained");
  await page
    .getByRole("button", { name: "Trace result row 7", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText("Master absent");
  await expect(page.locator("#trace-content")).toContainText("Using row 5");
  await expect(
    page.locator('[data-source="master"] .source-selected'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-source="using"] .source-selected'),
  ).toHaveAttribute("data-row", "5");
  await page
    .getByRole("button", { name: "Trace result row 7", exact: true })
    .press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Trace result row 8", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#trace-content")).toContainText("Master row 6");
  await expect(page.locator("#trace-content")).toContainText("Using absent");
  await expect(page.locator('#output-table button[tabindex="0"]')).toHaveCount(
    1,
  );
  await page.locator("#merge-keep").selectOption("matched");
  await expect(page.locator("#result-summary")).toHaveText(
    "6 rows retained · 2 excluded",
  );
  await expect(page.locator("#data-command")).toContainText("keep(3 4 5)");
  await expect(page.locator(".merge-count.excluded")).toHaveCount(2);
  await page.locator("#merge-keep").selectOption("all");
  await page.screenshot({
    path: screenshotPath(`data-merge-${testInfo.project.name}.png`),
    fullPage: true,
  });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await noOverflow(page);
});

test("invalid merge declarations highlight duplicates and cannot export an earlier valid result", async ({
  page,
}) => {
  await page.goto("/Labs/Data/");
  await page.locator("#merge-type").selectOption("1:1");
  await expect(page.locator("#operation-error")).toContainText("r(459)");
  await expect(page.locator("#operation-error")).toContainText(
    "key 1 occurs in rows 1, 2",
  );
  await expect(page.locator("#result-content")).toBeHidden();
  await expect(page.locator("#export-data")).toBeDisabled();
  await expect(
    page.locator('[data-source="master"] .source-problem'),
  ).toHaveCount(4);
  await page.locator("#merge-type").selectOption("m:1");
  await expect(page.locator("#export-data")).toBeEnabled();
  await page.locator("#merge-example").selectOption("terms");
  await page.locator('#merge-keys input[value="term"]').uncheck();
  await expect(page.locator("#operation-error")).toContainText(
    "master and using",
  );
  await page.locator('#merge-keys input[value="term"]').check();
  await expect(page.locator("#output-table tbody tr")).toHaveCount(6);
  await page.locator('#merge-keys input[value="term"]').uncheck();
  await page.locator('#merge-keys input[value="id"]').uncheck();
  await expect(page.locator("#operation-error")).toBeVisible();
  await page.locator("#reset-data").click();
  await expect(page.locator("#output-table tbody tr")).toHaveCount(8);
  await page.locator(".data-experiments summary").click();
  await page.locator("#merge-reverse").check();
  await expect(page.locator("#merge-type")).toHaveValue("1:m");
  await expect(page.locator("#output-table tbody tr")).toHaveCount(8);
  await page.locator("#merge-duplicate").check();
  await expect(page.locator("#operation-error")).toContainText("master table");
  await page.locator("#merge-duplicate").uncheck();
  await page.locator("#merge-missing").check();
  await expect(page.locator("#result-caution")).toContainText(
    "1 matched row has a missing key",
  );
  await expect(page.locator("#output-table tbody tr")).toHaveCount(9);
});

test("overlap rules expose conflicting and filled values and export the current operation", async ({
  page,
}) => {
  await page.goto("/Labs/Data/");
  await page.locator("#merge-example").selectOption("overlap");
  await page
    .getByRole("button", { name: "Trace result row 3", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText("region: West");
  await expect(page.locator("#trace-content")).toContainText("age: .");
  await page.locator("#merge-overlap").selectOption("update");
  await page
    .getByRole("button", { name: "Trace result row 3", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText("age: 35");
  await expect(page.locator("#trace-content")).toContainText("region: West");
  await expect(page.locator("#trace-content")).toContainText("_merge = 5");
  await page.locator("#merge-overlap").selectOption("replace");
  await page
    .getByRole("button", { name: "Trace result row 3", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText("region: North");
  await page.locator("#merge-keep").selectOption("matched");
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const files = unzipSync(await fs.readFile(await (await downloaded).path()));
  expect(Object.keys(files).sort()).toEqual([
    "README.txt",
    "analysis.do",
    "browser-result.csv",
    "master.csv",
    "settings.json",
    "using.csv",
  ]);
  expect(strFromU8(files["analysis.do"])).toContain(
    "update replace keep(3 4 5)",
  );
  expect(
    strFromU8(files["browser-result.csv"]).trim().split("\n"),
  ).toHaveLength(5);
  expect(JSON.parse(strFromU8(files["settings.json"])).options).toEqual({
    type: "1:1",
    keys: ["customer"],
    overlap: "replace",
    keep: "matched",
  });
});

test("reshape distinguishes source measurements, derived indexes and structural missing cells", async ({
  page,
}, testInfo) => {
  await page.goto("/Labs/Data/#reshape");
  await expect(page.locator("#group-stub-option")).toBeHidden();
  await expect(page.locator("#output-table tbody tr")).toHaveCount(6);
  await expect(page.locator("#result-explanation")).toContainText(
    "The number of students stays at 3",
  );
  const score = page.getByRole("button", {
    name: "Trace score, result row 4, value .",
    exact: true,
  });
  await score.click();
  await expect(page.locator("#trace-content")).toContainText(
    "source cell exists and its value is already missing",
  );
  await expect(
    page.locator('[data-source="source"] .cell-selected'),
  ).toHaveAttribute("data-column", "score2");
  await score.press("ArrowLeft");
  await expect(
    page.getByRole("button", {
      name: "Trace term, result row 4, value 2",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.locator("#trace-content")).toContainText("Column suffix 2");
  await page.locator("#reshape-issue").selectOption("gap");
  await page
    .getByRole("button", {
      name: "Trace hours, result row 2, value .",
      exact: true,
    })
    .click();
  await expect(page.locator("#trace-content")).toContainText("No source cell");
  await expect(page.locator("#result-explanation")).toContainText(
    "3 missing cells",
  );
  await page.locator('input[name="reshape-stub"][value="hours"]').uncheck();
  await expect(page.locator("#result-caution")).toContainText(
    "hours1 remain separate columns",
  );
  await page.locator("#reset-data").click();
  await page
    .getByRole("button", {
      name: "Trace score, result row 2, value 75",
      exact: true,
    })
    .click();
  await page.screenshot({
    path: screenshotPath(`data-reshape-${testInfo.project.name}.png`),
    fullPage: true,
  });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  await noOverflow(page);
});

test("wide reshape repairs varying attributes without discarding them and exports source data", async ({
  page,
}) => {
  await page.goto("/Labs/Data/#reshape");
  await page.locator("#reshape-direction").selectOption("wide");
  await expect(page.locator("#group-stub-option")).toBeVisible();
  await page.locator("#reshape-issue").selectOption("varying");
  await expect(page.locator("#operation-error")).toContainText(
    "group differs across source rows 1, 2",
  );
  await expect(page.locator("#export-data")).toBeDisabled();
  await page.locator('input[name="reshape-stub"][value="group"]').check();
  await expect(page.locator("#operation-error")).toBeHidden();
  await page
    .getByRole("button", {
      name: "Trace group2, result row 1, value B",
      exact: true,
    })
    .click();
  await expect(page.locator("#trace-content")).toContainText("Source row 2");
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const files = unzipSync(await fs.readFile(await (await downloaded).path()));
  expect(strFromU8(files["analysis.do"])).toContain(
    "reshape wide score hours group, i(id) j(term)",
  );
  expect(strFromU8(files["source.csv"]).trim().split("\n")).toHaveLength(7);
  await page.locator("#reshape-issue").selectOption("duplicate");
  await expect(page.locator("#operation-error")).toContainText(
    "index repeats within an identifier",
  );
  await expect(
    page.locator('[data-source="source"] .source-problem'),
  ).toHaveCount(2);
  await page.locator("#reshape-issue").selectOption("gap");
  await page
    .getByRole("button", {
      name: "Trace hours2, result row 2, value .",
      exact: true,
    })
    .click();
  await expect(page.locator("#trace-content")).toContainText(
    "student's record for the corresponding term is absent",
  );
  await page.locator("#reshape-direction").selectOption("long");
  await expect(page.locator("#group-stub-option")).toBeHidden();
  await expect(page.locator("#group-stub-option input")).not.toBeChecked();
  await expect(page.locator("#operation-error")).toBeHidden();
  await noOverflow(page);
});

test("a zero-row retained merge is a valid result with an empty export and no stale trace", async ({
  page,
}) => {
  await page.goto("/Labs/Data/");
  await page.locator("#merge-example").selectOption("overlap");
  await page.locator('#merge-keys input[value="region"]').check();
  await page.locator('#merge-keys input[value="age"]').check();
  await page.locator("#merge-keep").selectOption("matched");
  await expect(page.locator("#operation-error")).toBeHidden();
  await expect(page.locator("#result-summary")).toHaveText(
    "0 rows retained · 9 excluded",
  );
  await expect(page.locator("#trace-content")).toHaveText(
    "No rows satisfy the retention rule.",
  );
  await expect(page.locator("#output-table tbody tr")).toHaveCount(0);
  await expect(page.locator("#export-data")).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const files = unzipSync(await fs.readFile(await (await downloaded).path()));
  expect(
    strFromU8(files["browser-result.csv"]).trim().split("\n"),
  ).toHaveLength(1);
  await page.locator("#reset-data").click();
  await expect(page.locator("#trace-content")).toContainText("Master row 1");
});
