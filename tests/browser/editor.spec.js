import { replaceEditor } from "./editor-helpers.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const platform of ["MacIntel", "Win32"])
  test(`comment shortcuts preserve selected text, undo, execution and saved drafts (${platform})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", { get: () => value });
    }, platform);
    const mod = platform === "MacIntel" ? "Meta" : "Control";
    await page.goto("/Learn/");
    await page.locator("#free-mode").click();
    const editor = page.locator("#command-editor");
    const source = "generate double minutes = hours * 60\nsummarize minutes";
    await replaceEditor(page, source);
    await editor.press(`${mod}+A`);
    await editor.press(`${mod}+/`);
    const commented =
      "// generate double minutes = hours * 60\n// summarize minutes";
    await expect(editor).toHaveText(commented, { useInnerText: true });
    await editor.press(`${mod}+/`);
    await expect(editor).toHaveText(source, { useInnerText: true });
    await editor.press(`${mod}+z`);
    await expect(editor).toHaveText(commented, { useInnerText: true });
    await editor.press(`${mod}+Shift+z`);
    await expect(editor).toHaveText(source, { useInnerText: true });
    const blockKey =
      platform === "MacIntel" ? "Control+Shift+A" : "Alt+Shift+A";
    await editor.press(blockKey);
    await expect(editor).toContainText("/*");
    await expect(editor).toContainText("*/");
    await editor.press(blockKey);
    await expect(editor).toHaveText(source, { useInnerText: true });
    await editor.press(`${mod}+Enter`);
    await expect(page.locator("#dataset-count")).toContainText("6 variables");
    await replaceEditor(page, "clear\ncount");
    await editor.press(`${mod}+Home`);
    await editor.press(`${mod}+/`);
    await expect(editor).toHaveText("// clear\ncount", { useInnerText: true });
    await editor.press(`${mod}+Shift+Enter`);
    await expect(page.locator("#results")).toContainText("24 of 24");
    await expect(page.locator("#dataset-count")).toContainText(
      "24 observations",
    );
    await page.reload();
    await expect(editor).toHaveText("// clear\ncount", { useInnerText: true });
  });

test("editing shortcuts and their reference work without trapping keyboard focus", async ({
  page,
}) => {
  await page.goto("/Learn/");
  const editor = page.locator("#command-editor");
  await replaceEditor(page, "count\nsummarize hours");
  await editor.press("ControlOrMeta+A");
  await editor.press("ControlOrMeta+]");
  await expect(editor).toHaveText("  count\n  summarize hours", {
    useInnerText: true,
  });
  await editor.press("ControlOrMeta+[");
  await expect(editor).toHaveText("count\nsummarize hours", {
    useInnerText: true,
  });
  await editor.press("ControlOrMeta+Home");
  await editor.press("Alt+ArrowDown");
  await expect(editor).toHaveText("summarize hours\ncount", {
    useInnerText: true,
  });
  await editor.press("ControlOrMeta+f");
  await page.locator('.cm-search input[name="search"]').fill("summarize");
  await page.locator('.cm-search input[name="replace"]').fill("describe");
  await page.locator('.cm-search button[name="replaceAll"]').click();
  await expect(editor).toHaveText("describe hours\ncount", {
    useInnerText: true,
  });
  await page.locator('.cm-search input[name="search"]').press("Escape");
  await editor.press("Tab");
  await expect(editor).not.toBeFocused();
  await page.locator(".editor-shortcuts summary").click();
  await expect(page.locator(".editor-shortcuts")).toContainText(
    "Comment / uncomment",
  );
  await expect(page.locator(".editor-shortcuts")).toContainText(
    "Undo button restores",
  );
  expect(
    (await new AxeBuilder({ page }).include(".editor-section").analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

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
