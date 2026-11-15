import { test, expect } from "@playwright/test";

// Where the eighth pass's groups met in the Console page: files the session
// writes, data that would be replaced without asking, a file added with a
// name already there, the do-file echoed with its comments, lines in the
// error style, Tab in the editor, an example opened over the student's
// work, and a graph at phone width.

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
  await expect(page.locator("#console-status")).not.toHaveText("Running…");
}
const lastRecord = (page) =>
  page.locator("#console-output .console-record").last();
/** Answers the page's questions in turn, and keeps what they asked. */
function answering(page) {
  const asked = [];
  let answer = true;
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "beforeunload") return dialog.accept();
    asked.push(dialog.message());
    await (answer ? dialog.accept() : dialog.dismiss());
  });
  return {
    asked,
    set answer(value) {
      answer = value;
    },
  };
}

test("files save, export and log write stay through Clear session and a reload", async ({
  page,
}) => {
  const dialogs = answering(page);
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "keep in 1/5");
  await type(page, "save five, replace");
  await type(page, "export delimited using five.csv, replace");
  await type(page, "log using mylog, replace text");
  await type(page, "count");
  await type(page, "log close");
  // Changed data: Clear session asks, and No keeps everything.
  await type(page, "generate precious = 1");
  dialogs.answer = false;
  await page.locator("#console-more > summary").click();
  await page.locator("#console-reset").click();
  await expect.poll(() => dialogs.asked.length).toBe(1);
  expect(dialogs.asked[0]).toContain("changed since they were last saved");
  await type(page, "describe precious");
  await expect(lastRecord(page)).not.toContainText("r(111)");
  dialogs.answer = true;
  await page.locator("#console-more > summary").click();
  await page.locator("#console-reset").click();
  await expect(page.locator("#console-status")).toContainText(
    "The session was cleared",
  );
  await type(page, "use five, clear");
  await type(page, "count");
  await expect(lastRecord(page)).toContainText("5");
  await page.reload();
  await expect(page.locator("#console-status")).toContainText(
    "five.dta, five.csv, mylog.log",
  );
  await type(page, "import delimited five.csv, clear");
  await expect(lastRecord(page)).toContainText("5 obs");
  // A file added with a name already there asks; No keeps the old one.
  dialogs.answer = false;
  await page.locator("#console-file").setInputFiles({
    name: "five.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("z\n1\n"),
  });
  await expect(page.locator("#console-status")).toContainText(
    "five.csv was not added",
  );
  expect(dialogs.asked.at(-1)).toContain("the session wrote it");
  await type(page, "import delimited five.csv, clear");
  await expect(lastRecord(page)).toContainText("5 obs");
});

test("a Load button asks before it replaces changed data", async ({ page }) => {
  const dialogs = answering(page);
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "generate precious = 1");
  dialogs.answer = false;
  await page.locator("#drawer-data > summary").click();
  await page.getByRole("button", { name: "Load study" }).first().click();
  await expect.poll(() => dialogs.asked.length).toBe(1);
  await expect(page.locator("#console-status")).toContainText(
    "Nothing was replaced",
  );
  await type(page, "describe precious");
  await expect(lastRecord(page)).not.toContainText("r(111)");
});

test("Results keep the do-file's comments and continued lines, and show errors in red", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      'sysuse study, clear\n* Question 1\nregress score hours ///\n    attendance\n// Question 2\ndisplay as error "custom problem"\n',
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 3");
  const text = await page
    .locator("#console-output .console-record")
    .evaluateAll((blocks) => blocks.map((block) => block.text).join("\n"));
  expect(text).toContain(
    ". * Question 1\n. regress score hours ///\n>     attendance\n",
  );
  expect(text).toContain(
    '. // Question 2\n. display as error "custom problem"',
  );
  await expect(lastRecord(page).locator(".console-error")).toHaveText(
    "custom problem\n",
  );
});

test("Tab indents in the do-file editor, and an example opens beside the student's work", async ({
  page,
}) => {
  await ready(page);
  const source = page.locator("#console-source");
  await source.fill("foreach v in a b {\n");
  await source.focus();
  await source.evaluate((node) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.press("Tab");
  await page.keyboard.type('display "`v\'"');
  await expect(source).toHaveValue('foreach v in a b {\n    display "`v\'"');
  await expect(source).toBeFocused();
  // Escape, then Tab, leaves the editor.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(source).not.toBeFocused();
  const option = await page
    .locator("#console-example option")
    .nth(2)
    .getAttribute("value");
  await page.locator("#console-example").selectOption(option);
  await expect(page.locator("#console-status")).toContainText(
    "your do-file is unchanged",
  );
  await page
    .locator("#console-tabs .console-tab", { hasText: /^main\.do$/ })
    .click();
  await expect(source).toHaveValue('foreach v in a b {\n    display "`v\'"');
});

test("at phone width a graph fits Results, however long its command", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(
    page,
    'scatter score hours, title("Scores and hours for all of the students in the study")',
  );
  const graph = lastRecord(page).locator(".console-graph");
  await expect(graph).toBeVisible();
  const results = await page.locator("#console-output").boundingBox(),
    box = await graph.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(results.x + results.width);
});
