import { test, expect } from "@playwright/test";
import { screenshotPath } from "../../tools/receipts.mjs";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { replaceEditor } from "./editor-helpers.js";
import { PROGRAMMING_LESSONS } from "../../src/programming-lessons.js";

test("loops expose substitutions, survive reload and export the original program", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  const source =
    "* Powers from the same source\nlocal prefix study\nforvalues p = 1/3 {\n generate double `prefix'`p' = hours^`p'\n}";
  await replaceEditor(page, source);
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("8 variables");
  await page.locator("#tab-results").click();
  const cards = page.locator("#results .result-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toContainText("generate double study3 = hours^3");
  await cards
    .first()
    .getByText("Original do-file line", { exact: true })
    .click();
  await expect(cards.first().locator("details")).toContainText(
    "generate double `prefix'`p' = hours^`p'",
  );
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page.locator("#free-mode").click();
  await expect(page.locator("#command-editor")).toHaveText(source, {
    useInnerText: true,
  });
  await expect(page.locator("#dataset-count")).toContainText("8 variables");
  await page.locator("#export-open").click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download complete Stata project (.zip)",
      exact: true,
    })
    .click();
  const files = unzipSync(await fs.readFile(await (await pending).path()));
  expect(strFromU8(files["editor-draft.do"])).toBe(source);
  const analysis = strFromU8(files["analysis.do"]);
  expect(analysis).toContain("generate double study3 = hours^3");
  expect(analysis).not.toContain("`prefix'");
  await page.locator("#export-dialog [data-close]").click();
  await page.locator("#undo").click();
  await expect(page.locator("#dataset-count")).toContainText("7 variables");
});

test("run current executes an enclosing block and errors mark the original loop line", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(
    page,
    "forvalues p = 1/2 {\n generate double power`p' = hours^`p'\n}\nclear",
  );
  const editor = page.locator("#command-editor");
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await page.locator("#run-line").click();
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 7 variables",
  );
  await expect(page.locator("#editor-position")).toContainText("Line 4");
  await replaceEditor(
    page,
    "forvalues p = 1/2 {\n generate double repeated = `p'\n}\nclear",
  );
  await page.locator("#run").click();
  await expect(page.locator("#results .result-card").first()).toContainText(
    "Line 2",
  );
  await expect(page.locator("#results .result-card").first()).toContainText(
    "r(110)",
  );
  await expect(page.locator(".cm-execution-error")).toHaveCount(1);
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 8 variables",
  );
});

test("local scope and empty-loop limits have usable results", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "local n 3");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText(
    "Local n defined for this run",
  );
  await replaceEditor(page, "generate double scope = `n'");
  await page.locator("#run").click();
  await expect(page.locator("#results .result-card").first()).toContainText(
    "r(198)",
  );
  await expect(page.locator("#results .result-card").first()).toContainText(
    "Undefined local: n",
  );
  await replaceEditor(page, "forvalues i = 3/1 {\n clear\n}");
  await page.locator("#run").click();
  await expect(page.locator("#results .result-card").first()).toContainText(
    "No data commands ran",
  );
  await replaceEditor(
    page,
    "forvalues i = 1/1000 {\n forvalues j = 1/1000 {\n }\n}",
  );
  await page.locator("#run").click();
  await expect(page.locator("#results .result-card").first()).toContainText(
    "1,000-operation limit",
  );
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 5 variables",
  );
});

test("all programming lesson steps can be completed with specific feedback", async ({
  page,
}, info) => {
  await page.goto("/Learn/#macros-loops");
  for (const [i, step] of PROGRAMMING_LESSONS[0].steps.entries()) {
    await expect(page.locator("#lesson-title")).toHaveText(step.title);
    await page.locator("#insert-example").click();
    await page.locator("#run").click();
    await expect(page.locator("#exercise-check")).toContainText(
      "expected result",
    );
    await page
      .locator(
        `input[name="interpretation"][value="${(step.correct + 1) % 3}"]`,
      )
      .check();
    await page.locator("#check-answer").click();
    await expect(page.locator("#next-step")).toBeDisabled();
    await page
      .locator(`input[name="interpretation"][value="${step.correct}"]`)
      .check();
    await page.locator("#check-answer").click();
    await expect(page.locator("#next-step")).toBeEnabled();
    if (i === 2) {
      await page.locator("#tab-results").click();
      await page.screenshot({
        path: screenshotPath(`programming-${info.project.name}.png`),
      });
    }
    await page.locator("#next-step").click();
  }
  await expect(page.locator(".completed-panel")).toBeVisible();
});

test("long loops retain lightweight history after older full output is released", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "forvalues i = 1/250 {\n display `i'\n}");
  await page.locator("#run").click();
  await expect(page.locator("#result-count")).toHaveText("200");
  await expect(page.locator("#history-count")).toHaveText("250");
  await page.locator("#tab-history").click();
  await expect(page.locator("#command-history")).toContainText("display 1");
  await page.reload();
  await page.locator("#free-mode").click();
  await expect(page.locator("#history-count")).toHaveText("250");
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
});
