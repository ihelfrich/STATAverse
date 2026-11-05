import { replaceEditor } from "./editor-helpers.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("run current follows logical commands, reports line errors and leaves later commands untouched", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  const editor = page.locator("#command-editor");
  await replaceEditor(
    page,
    "* Work through this file\ngen minutes = hours * ///\n 60\nreplace minutes = 0 in 1/2\nsummarize absent\nclear",
  );
  await editor.press("ControlOrMeta+Home");
  await page.locator("#run-line").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await expect(page.locator("#editor-position")).toContainText("Line 4");
  await page.locator("#run-line").click();
  await expect(page.locator(".changed-cell")).toHaveCount(2);
  await expect(page.locator("#editor-position")).toContainText("Line 5");
  await page.locator("#run-line").click();
  await expect(page.locator("#results")).toContainText("Line 5");
  await expect(page.locator(".cm-execution-error")).toHaveCount(1);
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
  await page.locator("#tab-history").click();
  await expect(page.locator("#command-history")).toContainText(
    "2 values changed",
  );
  await expect(page.locator("#command-history")).toContainText("Added minutes");
  await page.getByText("Inspect 2 changed values", { exact: true }).click();
  await expect(page.locator(".change-details table")).toContainText("120");
  await expect(page.locator(".change-details table")).toContainText("180");
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
});

test("a selected command runs without executing destructive surrounding commands", async ({
  page,
}) => {
  await page.goto("/Learn/");
  const editor = page.locator("#command-editor");
  await replaceEditor(page, "describe\ncount\nclear");
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await editor.press("Home");
  await editor.press("Shift+End");
  await expect(page.locator("#run-line")).toHaveText("Run selection");
  await editor.press("ControlOrMeta+Enter");
  await expect(page.locator("#result-count")).toHaveText("1");
  await expect(page.locator("#results")).toContainText("24 of 24");
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
  await expect(page.locator("#results")).toContainText("Line 2");
});

test("editor completion, keyboard exit, draft persistence and history reuse work", async ({
  page,
}) => {
  await page.goto("/Learn/");
  const editor = page.locator("#command-editor");
  await replaceEditor(page, "sum ho");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /hours/ })).toBeVisible();
  await page.getByRole("option", { name: /hours/ }).click();
  await expect(editor).toContainText("sum hours");
  await editor.press("Escape");
  await editor.press("Tab");
  await expect(editor).not.toBeFocused();
  await page.locator("#run").click();
  await replaceEditor(page, "* Preserve this comment\ncount");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("stataverse:practice:v2")).lessons[
            "first-commands"
          ].code,
      ),
    )
    .toContain("Preserve this comment");
  await page.reload();
  await expect(editor).toContainText("Preserve this comment");
  await page.locator("#tab-history").click();
  await page
    .getByRole("button", { name: "Load in editor", exact: true })
    .click();
  await expect(editor).toContainText("sum hours");
  await expect(page.locator("#history-count")).toHaveText("1");
});
