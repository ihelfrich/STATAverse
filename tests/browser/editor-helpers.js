import { expect } from "@playwright/test";
// CodeMirror owns a document model and asynchronously observes contenteditable
// DOM changes. Select-all plus native insertion follows the student input path;
// raw Playwright fill can append to a pending DOM update under load.
export async function replaceEditor(page, text) {
  const editor = page.locator("#command-editor");
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text, { useInnerText: true });
}
