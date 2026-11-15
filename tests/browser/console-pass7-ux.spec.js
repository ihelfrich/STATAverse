import { test, expect } from "@playwright/test";

// The problems a tester found in the Console's hints, help and data
// browser in the seventh pass, each as the tester met it. What Stata does
// in the same place was recorded from Stata 19 (see tools/output-cases.txt,
// cases pass7-ux-*).

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
const hintOf = (page) => lastRecord(page).locator(".console-hint");

test("a messy CSV: the Try button runs a destring that works", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#console-file").setInputFiles({
    name: "survey.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'id,income,score\n1,"1,200",55\n2,"2,500",NA\n3,800,61\n4,"1,050",70\n',
    ),
  });
  await expect(page.locator("#console-memory")).toContainText(
    "4 observations, 3 variables",
  );
  await type(page, "regress score income");
  await expect(hintOf(page)).toContainText(
    "score and income are stored as text but hold numbers",
  );
  // The command the button offers is the one that is run, not one typed.
  await hintOf(page)
    .getByRole("button", { name: /^Try destring score income/ })
    .click();
  const line = page.locator("#console-command");
  await expect(line).toHaveValue(
    'destring score income, replace ignore(",") force',
  );
  await line.press("Enter");
  await expect(lastRecord(page)).toContainText(
    "income: character , removed; replaced as int",
  );
  await type(page, "regress score income");
  await expect(lastRecord(page)).toContainText("Number of obs   =         3");
  await expect(hintOf(page)).toHaveCount(0);

  // Words are not numbers: no destring is offered, and force is not urged.
  await type(page, 'generate str6 sex = cond(mod(_n,2),"male","female")');
  await type(page, "generate male = (sex == 1)");
  await expect(hintOf(page)).toContainText('sex == "male"');
  await expect(hintOf(page)).toContainText("encode sex");
  await expect(hintOf(page)).not.toContainText("force");
  await expect(hintOf(page).getByRole("button", { name: /^Try/ })).toHaveCount(
    0,
  );
});

test("editing a string cell stores exactly what was typed", async ({
  page,
}) => {
  await ready(page);
  await runFile(page, 'clear\nset obs 6\ngenerate str10 name = "abc"', "Ran 3");
  await type(page, "edit");
  const cell = (obs) =>
    page
      .locator("#browse-table tbody tr")
      .nth(obs - 1)
      .locator("td")
      .first();
  for (const [obs, text] of [
    [2, "US$abc"],
    [3, "it's `ok'"],
    [4, 'say "hi" $x \\`y\''],
  ]) {
    await cell(obs).getByRole("button").click();
    const input = cell(obs).locator("input");
    await input.fill(text);
    await input.press("Enter");
    await expect(cell(obs)).toHaveText(text);
  }
  await expect(
    page.locator("#console-output .console-command").filter({
      hasText: "in 2",
    }),
  ).toHaveText('. replace name = "US" + char(36) + "abc" in 2');
});

test("browse with a macro or with nolabel opens on the data", async ({
  page,
}) => {
  await ready(page);
  await runFile(
    page,
    'clear\nset obs 5\ngenerate id = _n\ngenerate treat = mod(_n, 2)\ngenerate score = 10 * _n\nlabel define yn 0 "no" 1 "yes"\nlabel values treat yn',
    "Ran 7",
  );
  await type(page, "local v id score");
  await type(page, "browse `v'");
  await expect(page.locator("#browse-note")).toHaveText("");
  await expect(page.locator("#browse-table thead th")).toHaveCount(3);
  await expect(page.locator("#browse-where")).toHaveText(
    "Showing browse id score",
  );
  await type(page, "browse, nolabel");
  await expect(page.locator("#browse-note")).toHaveText("");
  await expect(page.locator("#browse-table thead th")).toHaveCount(4);
  await expect(page.locator("#browse-labels")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    page.locator("#browse-table tbody tr").first().locator("td").nth(1),
  ).toHaveText("1");
  await type(page, "browse id treat, nolabel");
  await expect(page.locator("#browse-table thead th")).toHaveCount(3);
  await type(page, "browse treat");
  await expect(
    page.locator("#browse-table tbody tr").first().locator("td").first(),
  ).toHaveText("yes");
  // A name not in memory, or an option browse lacks, is an error, as in
  // Stata.
  await type(page, "browse nosuch");
  await expect(lastRecord(page).locator(".console-lines")).toHaveText(
    "variable nosuch not found\nr(111);\n",
  );
  await type(page, "browse id, foo");
  await expect(lastRecord(page).locator(".console-lines")).toHaveText(
    "option foo not allowed\nr(198);\n",
  );
});

test("help on a topic, or help alone, links to Stata's help", async ({
  page,
}) => {
  await ready(page);
  await type(page, "help datetime");
  const card = lastRecord(page).locator(".console-help-card");
  await expect(card.getByRole("link")).toHaveAttribute(
    "href",
    "https://www.stata.com/help.cgi?datetime",
  );
  await expect(card).toContainText("datetime is not a command that runs here");
  await expect(lastRecord(page).locator(".console-hint")).toHaveCount(0);
  await type(page, "help functions");
  await expect(
    lastRecord(page).locator(".console-help-card").getByRole("link"),
  ).toHaveAttribute("href", "https://www.stata.com/help.cgi?functions");
  await type(page, "help");
  const contents = lastRecord(page).locator(".console-help-card");
  await expect(contents.getByRole("link")).toHaveAttribute(
    "href",
    "https://www.stata.com/help.cgi?contents",
  );
  await contents
    .getByRole("button", { name: "Open the Commands list" })
    .click();
  await expect(page.locator("#drawer-commands")).toHaveAttribute("open", "");
});

test("each return code's hint fits the message it is under", async ({
  page,
}) => {
  await ready(page);
  await type(page, "count if x > 1");
  await expect(hintOf(page)).toContainText("There is no data in memory");
  await runFile(
    page,
    'clear\nset obs 4\ngenerate id = _n\ngenerate income = 100 * _n\ngenerate str6 sex = cond(mod(_n,2),"male","female")',
    "Ran 5",
  );
  // r(101): what the command does not take, not factor notation.
  await type(page, "describe if income > 1");
  await expect(hintOf(page)).toContainText(
    "describe does not take an if condition",
  );
  await expect(hintOf(page)).not.toContainText("factor");
  await type(page, "list income [fw=id]");
  await expect(hintOf(page)).toContainText("list does not take weights");
  await type(page, "describe in 1/2");
  await expect(lastRecord(page).locator(".console-lines")).toHaveText(
    "in range not allowed\nr(101);\n",
  );
  // r(100) for an open bracket: close it.
  await type(page, "tabstat income, stat(mean) by(sex");
  await expect(hintOf(page)).toContainText("is not closed");
  await hintOf(page).getByRole("button", { name: /^Try/ }).click();
  await expect(page.locator("#console-command")).toHaveValue(
    "tabstat income, stat(mean) by(sex)",
  );
  await page.locator("#console-command").press("Enter");
  await expect(lastRecord(page).locator(".console-error")).toHaveCount(0);
  // An option is suggested only from those the command takes.
  await type(page, "tabulate sex, detial");
  await expect(hintOf(page)).not.toContainText("detail");
  await expect(hintOf(page).getByRole("button", { name: /^Try/ })).toHaveCount(
    0,
  );
  await type(page, "summarize income, rbust");
  await expect(hintOf(page)).not.toContainText("robust");
  await type(page, "summarize income, detial");
  await expect(hintOf(page)).toContainText("Did you mean detail?");
  // A name in an expression: the same suggestions as in a varlist.
  await type(page, "replace income = Income + 1");
  await expect(hintOf(page)).toContainText("the variable is called income");
  await expect(
    hintOf(page).getByRole("button", { name: /^Try replace income = income/ }),
  ).toBeVisible();
  await type(page, "generate y = incme * 2");
  await expect(hintOf(page)).toContainText("Did you mean income?");
});

test("an error inside a loop offers no Try of the loop's first line", async ({
  page,
}) => {
  await ready(page);
  await runFile(
    page,
    "clear\nset obs 3\ngenerate income = _n\nforeach v in incme {\n  summarize `v'\n}",
    "Stopped at an error",
  );
  await expect(hintOf(page)).toContainText("Did you mean income?");
  await expect(hintOf(page).getByRole("button", { name: /^Try/ })).toHaveCount(
    0,
  );
});

test("the editor: Escape returns to the cell, a float reads as shown", async ({
  page,
}) => {
  await ready(page);
  await runFile(
    page,
    "clear\nset obs 3\ngenerate float x = 4.1\ngenerate double y = 4.1",
    "Ran 4",
  );
  await type(page, "edit");
  const cells = page.locator("#browse-table tbody tr").first().locator("td");
  const before = await page.locator("#console-output .console-record").count();
  await cells.first().getByRole("button").focus();
  await page.keyboard.press("Enter");
  const input = cells.first().locator("input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("4.1");
  await page.keyboard.press("Escape");
  await expect(cells.first().getByRole("button")).toBeFocused();
  // Enter on the unchanged value runs nothing.
  await page.keyboard.press("Enter");
  await expect(cells.first().locator("input")).toHaveValue("4.1");
  await page.keyboard.press("Enter");
  await expect(cells.first().getByRole("button")).toBeFocused();
  expect(await page.locator("#console-output .console-record").count()).toBe(
    before,
  );
  await cells.nth(1).getByRole("button").click();
  await expect(cells.nth(1).locator("input")).toHaveValue("4.1");
});

test("Go to row past the end shows the last page and says so", async ({
  page,
}) => {
  await ready(page);
  await runFile(page, "clear\nset obs 300\ngenerate id = _n", "Ran 3");
  await type(page, "browse");
  await page.locator("#browse-go").fill("9999");
  await page.locator("#browse-go").press("Tab");
  await expect(page.locator("#browse-range")).toHaveText("Rows 201–300 of 300");
  await expect(page.locator("#browse-note")).toHaveText(
    "There are only 300 rows; the last page is shown.",
  );
  await page.locator("#browse-prev").click();
  await expect(page.locator("#browse-range")).toHaveText("Rows 101–200 of 300");
  await expect(page.locator("#browse-note")).toHaveText("");
});

test("a selection's progress counts lines as the gutter does", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Run selection is a desktop path");
  await ready(page);
  const comments = Array.from({ length: 30 }, (_, k) => `* note ${k + 1}`);
  const source = page.locator("#console-source");
  await source.fill(
    [
      ...comments,
      "clear",
      "set obs 200000",
      "forvalues i = 1/3000 {",
      "  generate double v`i' = sqrt(_n) * `i'",
      "}",
    ].join("\n"),
  );
  await source.evaluate((area) => {
    const start = area.value.indexOf("clear");
    area.focus();
    area.setSelectionRange(start, area.value.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#console-run-selection").click();
  await expect(page.locator("#console-progress-text")).toContainText(
    "At line 34 (the selection is lines 31–35)",
  );
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator("#console-progress")).toBeHidden();
});

test("on a phone the Variables list shows type, format and value label", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "A phone's layout");
  await ready(page);
  await runFile(
    page,
    'clear\nset obs 3\ngenerate household_income_last_year = 1000 * _n\nlabel variable household_income_last_year "Household income in the last calendar year, all sources"\ngenerate employment_status = mod(_n, 2)\nlabel define emp 0 "Not employed" 1 "Employed"\nlabel values employment_status emp',
    "Ran 7",
  );
  const drawer = page.locator("#drawer-variables");
  if ((await drawer.getAttribute("open")) === null)
    await drawer.locator("> summary").click();
  const box = await page
    .locator("#console-variable-table")
    .evaluate((table) => {
      const scroll = table.closest(".console-scroll");
      return { table: table.scrollWidth, box: scroll.clientWidth };
    });
  expect(box.table).toBeLessThanOrEqual(box.box);
  const toggle = page.getByRole("button", { name: "emp", exact: true });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await page
    .locator("#drawer-variables")
    .screenshot({ path: test.info().outputPath("variables-phone.png") });
  await toggle.click();
  await expect(page.locator(".console-label-row:visible")).toContainText(
    "0 = Not employed",
  );
  await expect(
    page.locator("#console-variable-table tbody td", { hasText: "float" }),
  ).toHaveCount(2);
  for (const cell of await page
    .locator("#console-variable-table tbody tr:not([hidden]) td")
    .all()) {
    const { right, edge } = await cell.evaluate((node) => ({
      right: node.getBoundingClientRect().right,
      edge: node.closest(".console-scroll").getBoundingClientRect().right,
    }));
    expect(right).toBeLessThanOrEqual(edge + 1);
  }
});
