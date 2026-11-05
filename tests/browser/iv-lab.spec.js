import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { ivSample, ivCSV, ivDoFile } from "../../src/labs/iv-model.js";
import { fmt } from "../../src/render.js";
test.use({ serviceWorkers: "block" });
async function controls(page) {
  const summary = page.locator("#iv-controls-disclosure > summary");
  if (
    (await summary.isVisible()) &&
    (await page.locator("#iv-controls-disclosure").getAttribute("open")) ===
      null
  )
    await summary.click();
}
async function advanced(page) {
  await controls(page);
  if ((await page.locator(".iv-settings").getAttribute("open")) === null)
    await page.locator(".iv-settings summary").click();
}
test("IV stages use one sample, linked records and visible fit lines", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  const s = ivSample();
  await expect(page.locator("#iv-stages")).toContainText(fmt(s.iv.b, 3));
  await expect(page.locator("#iv-comparison")).toContainText(fmt(s.ols.b, 3));
  expect(
    await page
      .locator("#iv-scatter .lab-fit")
      .evaluate((el) => getComputedStyle(el).stroke),
  ).not.toBe("none");
  await page.locator('#iv-scatter [data-observation="1"]').press("ArrowRight");
  await expect(page.locator("#iv-record")).toHaveValue("2");
  await page.locator("#iv-view").selectOption("reduced");
  await expect(
    page.locator('#iv-scatter [data-observation="2"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#iv-record-values")).toContainText(
    fmt(s.rows[1].y, 3),
  );
  await page.locator("#iv-view").selectOption("structural");
  await expect(page.locator("#iv-scatter .lab-fit")).toHaveCount(2);
  await page.locator("#iv-panel-stages .iv-explanation summary").click();
  await expect(page.locator("#iv-naive")).toContainText(fmt(s.naive.se, 3));
});
test("weak and invalid instruments retain unbounded sets and explicit assumptions", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  await controls(page);
  await page.locator("#iv-scenario").selectOption("weak");
  await page.locator("#iv-tab-uncertainty").click();
  await expect(page.locator("#iv-set")).toHaveText("All real values");
  await page.locator("#iv-window").selectOption("100");
  await expect(page.locator("#iv-set")).toHaveText("All real values");
  await page.locator("#iv-panel-uncertainty .iv-explanation summary").click();
  await page.locator("#iv-disconnected").click();
  await expect(page.locator("#iv-set")).toContainText("∪");
  await expect(page.locator("#iv-set")).toContainText("∞");
  await page.locator("#iv-candidate").fill("2");
  await expect(page.locator("#iv-ar-result")).toContainText("Rejected");
  await page.locator("#iv-candidate").fill("10");
  await expect(page.locator("#iv-ar-result")).toContainText("Not rejected");
  await controls(page);
  await page.locator("#iv-scenario").selectOption("invalid");
  await expect(page.locator("#iv-assumptions")).toContainText("violated");
  await expect(page.locator("#iv-ar-method")).toContainText(
    "no valid-instrument coverage guarantee",
  );
});
test("invalid inputs retain labeled last results and block exports until repaired", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  await advanced(page);
  await page.locator("#iv-n").fill("");
  await expect(page.locator("#iv-status")).toContainText("last valid settings");
  await expect(page.locator("#export-iv")).toBeDisabled();
  await expect(page.locator("#iv-new-sample")).toBeDisabled();
  await page.locator("#reset-iv").click();
  await expect(page.locator("#export-iv")).toBeEnabled();
  await page.locator("#iv-tab-uncertainty").click();
  await page.locator("#iv-candidate").fill("");
  await expect(page.locator("#iv-ar-result")).toContainText(
    "Enter a finite candidate",
  );
  await expect(page.locator("#export-iv")).toBeDisabled();
  await page.locator("#iv-test-truth").click();
  await expect(page.locator("#export-iv")).toBeEnabled();
});
test("large samples render a bounded number of selectable records", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  await advanced(page);
  await page.locator("#iv-n").fill("2000");
  await expect(page.locator("#iv-assumptions")).toContainText("n = 2000");
  await expect(page.locator("#iv-scatter .lab-point")).toHaveCount(300);
  await page.locator("#iv-record").fill("2000");
  await page.locator("#iv-record").press("Tab");
  await expect(
    page.locator('#iv-scatter [data-observation="2000"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#iv-plot-note")).toContainText(
    "every calculation uses all 2000",
  );
});
test("guided comparisons check answers against the specified experiment", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  for (const [id, answer] of [
    ["ratio", "1.001"],
    ["weak", "all values"],
    ["invalid", "1.8"],
    ["residual", "observed x"],
  ]) {
    await page.locator("#iv-task").selectOption(id);
    await page.locator("#iv-task-load").click();
    await page.locator("#iv-answer").fill("wrong");
    await page.locator("#iv-answer-form button").click();
    await expect(page.locator("#iv-feedback")).toHaveAttribute(
      "data-correct",
      "false",
    );
    await page.locator("#iv-answer").fill(answer);
    await page.locator("#iv-answer-form button").click();
    await expect(page.locator("#iv-feedback")).toHaveAttribute(
      "data-correct",
      "true",
    );
  }
  await controls(page);
  await page.locator("#iv-new-sample").click();
  await page.locator("#iv-answer-form button").click();
  await expect(page.locator("#iv-feedback")).toContainText(
    "different settings",
  );
});
test("export preserves the exact sample, inference options and null candidate", async ({
  page,
}) => {
  await page.goto("/Labs/IV/");
  await advanced(page);
  await page.locator("#iv-robust").selectOption("true");
  await page.locator("#iv-confidence").selectOption("0.9");
  await page.locator("#iv-tab-uncertainty").click();
  await page.locator("#iv-candidate").fill("1.5");
  const downloading = page.waitForEvent("download");
  await page.locator("#export-iv").click();
  const download = await downloading;
  const files = unzipSync(await fs.readFile(await download.path()));
  const s = ivSample({ robust: true, confidence: 0.9 });
  const actualCSV = strFromU8(files["iv-sample.csv"]).trim().split("\n");
  const expectedCSV = ivCSV(s).trim().split("\n");
  expect(actualCSV[0]).toBe(expectedCSV[0]);
  expect(actualCSV.length).toBe(expectedCSV.length);
  // Math.log/cos may differ by a few final bits between Node and Chrome.
  // The CSV retains the browser's complete values rather than rounded displays.
  actualCSV.slice(1).forEach((line, i) =>
    line
      .split(",")
      .map(Number)
      .forEach((v, j) =>
        expect(
          Math.abs(v - Number(expectedCSV[i + 1].split(",")[j])),
        ).toBeLessThan(2e-13),
      ),
  );
  expect(strFromU8(files["analysis.do"])).toBe(ivDoFile(s, 1.5));
  expect(JSON.parse(strFromU8(files["settings.json"])).candidate).toBe(1.5);
});
test("IV views fit narrow screens, support keyboard tabs and pass accessibility checks", async ({
  page,
}, testInfo) => {
  await page.goto("/Labs/IV/");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#iv-tab-stages").press("ArrowRight");
  await expect(page.locator("#iv-tab-uncertainty")).toBeFocused();
  await expect(page.locator("#iv-panel-uncertainty")).toBeVisible();
  for (const view of ["stages", "uncertainty", "method"]) {
    await page.locator(`#iv-tab-${view}`).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  }
  await page.locator("#iv-tab-uncertainty").click();
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#iv-stages").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `docs/verification/screenshots/iv-uncertainty-${testInfo.project.name}.png`,
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
