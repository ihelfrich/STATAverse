import { test, expect } from "@playwright/test";

// The problems testers found in the Console in the eighth pass: work that
// could be lost (a do-file replaced by one of the same name, the data and
// results thrown away by Stop, two windows overwriting each other's saved
// do-files), a block typed at the command line, and the page at phone width.

async function ready(page) {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
}
async function type(page, command) {
  const line = page.locator("#console-command");
  await expect(line).toBeEnabled();
  await line.fill(command);
  await line.press("Enter");
  await expect(line).toBeEnabled();
}
async function runFile(page, text, ran) {
  await page.locator("#console-source").fill(text);
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText(ran);
}
const lastRecord = (page) =>
  page.locator("#console-output .console-record").last();
const tabs = (page) =>
  page.locator("#console-tabs .console-tab").allTextContents();

test("a do-file added with the name of one open keeps both", async ({
  page,
}) => {
  await ready(page);
  const mine =
    "* my precious analysis\nsysuse study, clear\nregress score hours\n";
  await page.locator("#console-source").fill(mine);
  await page.locator("#console-file").setInputFiles({
    name: "main.do",
    mimeType: "text/plain",
    buffer: Buffer.from('display "uploaded main"\n'),
  });
  await expect(page.locator("#console-status")).toContainText("main_2.do");
  expect(await tabs(page)).toEqual(["main.do", "main_2.do"]);
  await expect(page.locator("#console-source")).toHaveValue(
    'display "uploaded main"\n',
  );
  await page
    .locator("#console-tabs .console-tab", { hasText: /^main\.do$/ })
    .click();
  await expect(page.locator("#console-source")).toHaveValue(mine);
  // After a reload both are still there.
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  expect(await tabs(page)).toEqual(["main.do", "main_2.do"]);
  // The same file added again, unchanged, opens the copy already there.
  await page.locator("#console-file").setInputFiles({
    name: "main_2.do",
    mimeType: "text/plain",
    buffer: Buffer.from('display "uploaded main"\n'),
  });
  await expect(page.locator("#console-status")).toContainText("main_2.do");
  expect(await tabs(page)).toEqual(["main.do", "main_2.do"]);
});

test("a deleted do-file can be brought back", async ({ page }) => {
  await ready(page);
  await page.locator("#console-source").fill('display "first file"\n');
  await page.locator("#console-more > summary").click();
  await page.locator("#console-tab-new").click();
  await page.locator("#console-source").fill("* precious work\ndisplay 2+2\n");
  await page.locator("#console-more > summary").click();
  await page.locator("#console-tab-delete").click();
  await expect(page.locator("#console-status")).toContainText(
    "part.do was deleted",
  );
  expect(await tabs(page)).toEqual(["main.do"]);
  await page
    .locator("#console-status")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(page.locator("#console-source")).toHaveValue(
    "* precious work\ndisplay 2+2\n",
  );
  expect(await tabs(page)).toEqual(["main.do", "part.do"]);
});

test("Stop keeps the data in memory and what the run printed", async ({
  page,
}) => {
  await ready(page);
  await type(page, "clear");
  await type(page, "set obs 5000");
  await type(page, "set seed 7");
  await type(page, "generate score = rnormal(50,10)");
  await type(page, "local kept = 42");
  await runFile(
    page,
    'display "before the loop"\nsummarize score\ngenerate k = 1\nforvalues i = 1/400000 {\n  quietly replace k = k + 1 in 1\n}\ndisplay "after"\n',
    "Running",
  );
  // What ran before the loop is shown while the loop goes on.
  await expect(page.locator("#console-output")).toContainText(
    "before the loop",
    { timeout: 10000 },
  );
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+.");
  await expect(page.locator("#console-status")).toContainText(
    "as they were before the command that was stopped",
    { timeout: 20000 },
  );
  const results = page.locator("#console-output");
  await expect(results).toContainText("before the loop");
  await expect(results).toContainText("5,000");
  await expect(lastRecord(page)).toContainText("--Break--");
  await expect(lastRecord(page)).toContainText("r(1);");
  await expect(results).not.toContainText('display "after"\nafter');
  await expect(page.locator("#console-memory")).toContainText(
    "5,000 observations",
  );
  // The data, the variable made before the loop and the command line's
  // locals are all there; the loop itself did not take effect.
  await type(page, "summarize score k");
  await expect(lastRecord(page)).toContainText("5,000");
  await type(page, "display k[1] + `kept'");
  await expect(lastRecord(page)).toContainText("43");
});

test("a block typed at the command line runs when it is closed", async ({
  page,
}) => {
  await ready(page);
  await type(page, "display 1");
  await type(page, "foreach v in a b {");
  await expect(page.locator("#console-status")).toContainText("}");
  await type(page, 'display "`v\'"');
  await type(page, "}");
  const block = lastRecord(page);
  await expect(block).toContainText(". foreach v in a b {");
  await expect(block).toContainText('2. display "`v\'"');
  await expect(block).toContainText("a\nb");
  // A } with nothing open is an error shown in Results.
  await type(page, "}");
  await expect(lastRecord(page)).toContainText("} without a matching {");
  await expect(lastRecord(page)).toContainText("r(198);");
});

test("two windows do not overwrite each other's do-files", async ({
  context,
}) => {
  const b = await context.newPage();
  await ready(b);
  const a = await context.newPage();
  await ready(a);
  await a.locator("#console-source").fill("* EDITED IN A\ndisplay 1\n");
  await a.locator("#console-more > summary").click();
  await a.locator("#console-tab-new").click();
  await a.locator("#console-source").fill("display 2\n");
  // B learns of A's work.
  await expect
    .poll(async () => b.locator("#console-tabs .console-tab").allTextContents())
    .toEqual(["main.do", "part.do"]);
  await expect(b.locator("#console-source")).toHaveValue(
    "* EDITED IN A\ndisplay 1\n",
  );
  await b.locator("#console-source").press("End");
  await b.locator("#console-source").type("x");
  const c = await context.newPage();
  await ready(c);
  expect(
    await c.locator("#console-tabs .console-tab").allTextContents(),
  ).toEqual(["main.do", "part.do"]);
  await c.locator("#console-tabs .console-tab", { hasText: "part.do" }).click();
  await expect(c.locator("#console-source")).toHaveValue("display 2\n");
});

test("at phone width the More menu and a hint fit the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator("#console-more > summary").click();
  const box = await page.locator(".console-menu-panel").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await type(page, "sysuse study, clear");
  await type(page, "regress score hours, robst");
  const fix = lastRecord(page).getByRole("button", { name: /^Try / });
  const results = await page.locator("#console-output").boundingBox(),
    button = await fix.boundingBox();
  expect(button.x + button.width).toBeLessThanOrEqual(
    results.x + results.width,
  );
});
