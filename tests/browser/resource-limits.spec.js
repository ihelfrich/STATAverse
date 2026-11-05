import { test, expect } from "@playwright/test";

test("large text fails without data loss and history clearly labels shortened previews", async ({
  page,
}) => {
  // Native selection and insertion respect CodeMirror's document model. A raw
  // contenteditable fill can race its DOM observer after the long-line error.
  const replaceCommand = async (text) => {
    const editor = page.locator("#command-editor");
    await editor.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await expect(editor).toHaveText(text);
  };
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceCommand(`generate note = "${"a".repeat(8000)}"`);
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await replaceCommand("replace note = note + note");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText(
    "concatenation would exceed",
  );
  await replaceCommand('replace note = "short"');
  await page.locator("#run").click();
  await page.locator("#tab-history").click();
  await page.getByText("Inspect 24 changed values", { exact: true }).click();
  await expect(page.locator(".change-details")).toContainText(
    "shortened to 160 characters",
  );
  await expect(page.locator(".change-details tbody tr").first()).toContainText(
    "short",
  );
  await page.reload();
  await page.locator("#tab-data").click();
  await expect(page.locator("#data-table tbody tr").first()).toContainText(
    "short",
  );
  await expect(page.locator("#storage-warning")).not.toBeVisible();
});

test("an older saved transformation that exceeds new limits preserves its original backup", async ({
  page,
}) => {
  const history = [
    `generate note = "${"a".repeat(8000)}"`,
    "replace note = note + note",
    "count",
  ];
  const original = JSON.stringify({
    version: 3,
    mode: "free",
    activeDataset: "study",
    current: "first-commands",
    lessons: {},
    imports: {},
    free: {
      study: {
        step: 0,
        history,
        code: "count",
        note: "Retain the original work",
        completed: [],
      },
    },
  });
  await page.addInitScript(
    (value) => localStorage.setItem("stataverse:practice:v2", value),
    original,
  );
  await page.goto("/Learn/");
  await expect(page.locator("#storage-warning")).toContainText(
    "original saved history has been left unchanged",
  );
  await expect(page.locator("#results")).toContainText(
    "concatenation would exceed",
  );
  await page.locator("#run").click();
  expect(
    await page.evaluate(() => localStorage.getItem("stataverse:practice:v2")),
  ).toBe(original);
});
