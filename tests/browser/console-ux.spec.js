import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";

// The Console as three students meet it: one who has never used Stata, one
// who adds a messy CSV and tries a regression, and one who comes back to
// finish a do-file. Each improvement of the seventh pass has a test here.

async function ready(page) {
  await page.addInitScript(() => {
    // Copying is checked without the system clipboard.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copied = text;
        },
      },
    });
  });
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
async function drawer(page, id) {
  const box = page.locator(`#drawer-${id}`);
  if ((await box.getAttribute("open")) === null)
    await box.locator("> summary").click();
}
const lastRecord = (page) =>
  page.locator("#console-output .console-record").last();
/** No serious or critical violation, WCAG 2.2 AA rules included. */
async function audit(page) {
  const scan = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
  const bad = scan.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact),
  );
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`),
  ).toEqual([]);
}
async function noSideScroll(page) {
  const { wide, view } = await page.evaluate(() => ({
    wide: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(wide).toBeLessThanOrEqual(view);
}

test("a mistyped command suggests the nearest command that runs here", async ({
  page,
}) => {
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "summarise score");
  const record = lastRecord(page);
  // Stata's message and return code are unchanged; the hint is beside them.
  await expect(record.locator(".console-lines")).toHaveText(
    "command summarise is unrecognized\nr(199);\n",
  );
  const hint = record.locator(".console-hint");
  await expect(hint).toContainText("Did you mean summarize?");
  // Try puts the corrected command at the command line.
  await hint.getByRole("button", { name: /^Try summarize score/ }).click();
  await expect(page.locator("#console-command")).toHaveValue("summarize score");
  await expect(page.locator("#console-command")).toBeFocused();
  // help opens the command's entry in the Commands list, with Stata's help.
  await hint.getByRole("button", { name: "help summarize" }).click();
  await expect(page.locator("#drawer-commands")).toHaveAttribute("open", "");
  const entry = page.locator("#console-commands li:visible");
  await expect(entry).toHaveCount(1);
  await expect(entry.locator(".console-help-card")).toContainText(
    "Means, standard deviations",
  );
  await expect(entry.getByRole("link")).toHaveAttribute(
    "href",
    "https://www.stata.com/help.cgi?summarize",
  );
  await expect(entry.getByRole("button")).toBeFocused();

  // A community package names what to use instead.
  await type(page, "esttab");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "community-contributed package",
  );
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "estimates",
  );
  // The fox's tip that help works is now true.
  await type(page, "help regress");
  await expect(lastRecord(page).locator(".console-lines")).toHaveCount(0);
  await expect(lastRecord(page).locator(".console-help-card")).toContainText(
    "regress y x1 x2",
  );
  await type(page, "help regres");
  await expect(lastRecord(page).locator(".console-help-card")).toContainText(
    "Linear regression",
  );
  await type(page, "help tabluate");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "Did you mean tabulate?",
  );
  await audit(page);
});

test("common mistakes carry a plain hint: names, =, options, taken names", async ({
  page,
}) => {
  await ready(page);
  await type(page, "summarize score");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "There is no data in memory",
  );
  await type(page, "sysuse study, clear");
  await type(page, "summarize Score");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "case-sensitive: the variable is called score",
  );
  await type(page, "count if group = 1");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "To compare two values, write ==",
  );
  await expect(
    lastRecord(page).getByRole("button", { name: /^Try count if group == 1/ }),
  ).toBeVisible();
  await type(page, "regress score hours, robsut");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "Did you mean robust?",
  );
  await type(page, "generate score = 1");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "replace score",
  );
  await type(page, "sysuse auto");
  await expect(lastRecord(page).locator(".console-hint")).toContainText(
    "belong to StataCorp",
  );
  // The Commands list finds a command by what it does.
  await drawer(page, "commands");
  await page.locator("#console-filter").fill("odds ratios");
  await expect(page.locator("#console-commands li:visible")).toHaveText([
    "logistic",
  ]);
  await page.locator("#console-filter").fill("reghdfe");
  await expect(page.locator("#console-found")).toContainText(
    "No command here is called reghdfe",
  );
  await expect(page.locator("#console-found")).toContainText("areg");
});

test("a messy CSV: the hint says which columns are text and how to fix them", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#console-file").setInputFiles({
    name: "survey.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Student ID,Hours,Score,Group\n1,2,55,A\n2,3,NA,B\n3,4,61,A\n4,5,70,B\n",
    ),
  });
  await expect(page.locator("#console-memory")).toContainText(
    "4 observations, 4 variables",
  );
  await type(page, "regress score hours");
  const hint = lastRecord(page).locator(".console-hint");
  await expect(hint).toContainText("score is stored as text");
  await expect(hint).toContainText("force");
  await hint
    .getByRole("button", { name: /^Try destring score, replace/ })
    .click();
  // The command the button offers is the one run, as a student would.
  await expect(page.locator("#console-command")).toHaveValue(
    "destring score, replace force",
  );
  await page.locator("#console-command").press("Enter");
  await expect(lastRecord(page)).toContainText("(1 missing value generated)");
  await type(page, "regress score hours");
  await expect(lastRecord(page)).toContainText("Number of obs   =         3");
  await expect(lastRecord(page).locator(".console-hint")).toHaveCount(0);
});

test("the Variables list can be searched and sorted, and shows value labels", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      'sysuse study, clear\nlabel define yes 0 "no" 1 "yes"\ngenerate passed = score >= 60 if score < .\nlabel values passed yes',
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 4");
  await drawer(page, "variables");
  const rows = page.locator(
    "#console-variable-table tbody tr:not(.console-label-row):visible",
  );
  await expect(rows).toHaveCount(6);
  await page.locator("#console-variable-filter").fill("study");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("hours");
  await expect(page.locator("#console-variable-found")).toHaveText(
    "1 of 6 variables.",
  );
  await page.locator("#console-variable-filter").fill("");
  // Sorting by Name, by keyboard; the heading says how it is sorted.
  const name = page.locator('#console-variable-table th[data-key="name"]');
  await name.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await expect(rows.first().locator("td").first()).toHaveText("attendance");
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first().locator("td").first()).toHaveText("score");
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "none");
  await expect(rows.first().locator("td").first()).toHaveText("id");
  // A value label opens to show what its values stand for.
  const toggle = page.getByRole("button", { name: "yes", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".console-label-row:visible")).toHaveText(
    "yes: 0 = no; 1 = yes",
  );
  await audit(page);
});

test("browse and edit open a data browser that sorts, finds and changes values", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      'sysuse study, clear\nlabel define yes 0 "no" 1 "yes"\ngenerate passed = score >= 60 if score < .\nlabel values passed yes',
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 4");
  await type(page, "browse");
  const browser = page.locator("#drawer-browse");
  await expect(browser).toHaveAttribute("open", "");
  // Stata's browse prints nothing; the runtime's note is not shown.
  await expect(lastRecord(page).locator(".console-lines")).toHaveCount(0);
  const body = page.locator("#browse-table tbody tr");
  await expect(body).toHaveCount(24);
  await expect(page.locator("#browse-range")).toHaveText("Rows 1–24 of 24");
  await expect(page.locator("#browse-table thead th")).toHaveCount(7);
  // Value labels, in blue, or the numbers under them.
  await expect(body.first().locator("td").last()).toHaveText("no");
  await expect(body.first().locator("td").last()).toHaveClass(/is-labelled/);
  await page.locator("#browse-labels").click();
  await expect(body.first().locator("td").last()).toHaveText("0");
  await page.locator("#browse-labels").click();
  // Sorting the view leaves the data's order alone.
  const score = page.locator("#browse-table thead th", { hasText: "score" });
  await score.getByRole("button").click();
  await expect(score).toHaveAttribute("aria-sort", "ascending");
  await expect(body.first().locator("th")).not.toHaveText("1");
  await score.getByRole("button").click();
  await expect(score).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("#console-memory")).not.toContainText("sorted by");
  // Finding a value.
  await page.locator("#browse-find").fill("yes");
  await expect(page.locator("#browse-range")).toHaveText(
    /^Rows 1–\d+ of \d+ \(of 24 observations\)$/,
  );
  await page.locator("#browse-find").fill("");
  // browse with a varlist and if, as in Stata.
  await type(page, "browse id score if score > 80");
  await expect(page.locator("#browse-table thead th")).toHaveCount(3);
  await expect(page.locator("#browse-where")).toHaveText(
    "Showing browse id score if score > 80",
  );
  await page.locator("#browse-all").click();
  await expect(page.locator("#browse-table thead th")).toHaveCount(7);
  // edit: a change is a replace command, run and shown in Results.
  await type(page, "edit");
  await expect(page.locator("#browse-edit")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Back to the data's own order.
  await score.getByRole("button").click();
  await expect(score).toHaveAttribute("aria-sort", "none");
  const cell = body.nth(2).locator("td").nth(3);
  await cell.getByRole("button").click();
  const input = cell.locator("input");
  await expect(input).toBeFocused();
  await input.fill("99");
  await input.press("Enter");
  await expect(lastRecord(page).locator(".console-command")).toHaveText(
    ". replace score = 99 in 3",
  );
  await expect(cell).toHaveText("99");
  await expect(cell.getByRole("button")).toBeFocused();
  // Escape leaves a value as it was; a word in a number column is refused.
  await cell.getByRole("button").click();
  await cell.locator("input").fill("lots");
  await cell.locator("input").press("Enter");
  await expect(page.locator("#browse-note")).toHaveText(
    "score is numeric: type a number, or . for missing.",
  );
  await cell.locator("input").press("Escape");
  await expect(cell).toHaveText("99");
  await audit(page);
  await noSideScroll(page);
});

test("the browser pages through 10,000 observations quickly", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      'clear\nset seed 7\nset obs 10000\ngenerate id = _n\ngenerate x = runiform()\ngenerate s = cond(x < .5, "low", "high")',
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 6");
  await page.locator("#console-browse").click();
  await expect(page.locator("#browse-range")).toHaveText(
    "Rows 1–100 of 10,000",
  );
  await page.locator("#browse-next").click();
  await expect(page.locator("#browse-range")).toHaveText(
    "Rows 101–200 of 10,000",
  );
  await page.locator("#browse-go").fill("9950");
  await page.locator("#browse-go").press("Enter");
  await expect(page.locator("#browse-range")).toHaveText(
    "Rows 9,901–10,000 of 10,000",
  );
  await expect(page.locator("#browse-next")).toBeDisabled();
  const started = Date.now();
  const x = page.locator("#browse-table thead th", { hasText: "x" });
  await x.getByRole("button").click();
  await expect(x).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("#browse-range")).toHaveText(
    "Rows 1–100 of 10,000",
  );
  await page.locator("#browse-find").fill("low");
  await expect(page.locator("#browse-range")).toHaveText(
    /of 10,000 observations\)$/,
  );
  expect(Date.now() - started).toBeLessThan(2000);
});

test("results can be copied per command and whole, and downloaded", async ({
  page,
}) => {
  await ready(page);
  await expect(page.locator("#console-copy-all")).toBeHidden();
  await type(page, "display 6 * 7");
  await type(page, "summarise x");
  const first = page.locator("#console-output .console-record").first();
  // The tools show on pointing and on keyboard focus.
  await first.hover();
  const copy = first.getByRole("button", {
    name: /^Copy the results of display/,
  });
  await copy.click();
  expect(await page.evaluate(() => window.copied)).toBe(
    ". display 6 * 7\n42\n",
  );
  await expect(page.locator("#console-status")).toHaveText(
    "The command and its results were copied.",
  );
  await page.locator("#console-copy-all").click();
  // The whole log, as Stata prints it: hints are not part of it.
  expect(await page.evaluate(() => window.copied)).toBe(
    ". display 6 * 7\n42\n\n. summarise x\ncommand summarise is unrecognized\nr(199);\n",
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#console-save-log").click(),
  ]);
  expect(download.suggestedFilename()).toBe("results.log");
  expect(await fs.readFile(await download.path(), "utf8")).toContain(
    "command summarise is unrecognized",
  );
  // A graph can be saved from its record.
  await type(page, "sysuse study, clear");
  await type(page, "scatter score hours");
  await lastRecord(page).hover();
  const [graph] = await Promise.all([
    page.waitForEvent("download"),
    lastRecord(page)
      .getByRole("button", { name: /^Save graph/ })
      .click(),
  ]);
  expect(graph.suggestedFilename()).toBe("graph.svg");
  expect(await fs.readFile(await graph.path(), "utf8")).toMatch(/^<svg/);
  // Clearing the session takes the copy buttons away with the results.
  await page.locator("#console-more > summary").click();
  await page.locator("#console-reset").click();
  await expect(page.locator("#console-copy-all")).toBeHidden();
});

test("a long run shows how far it has got, and Ctrl or ⌘ + . stops it", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      "clear\nset obs 200000\nforvalues i = 1/3000 {\n  generate double v`i' = sqrt(_n) * `i'\n}",
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText("Running…");
  const progress = page.locator("#console-progress");
  await expect(progress).toBeVisible();
  await expect(page.locator("#console-progress-text")).toContainText(
    /commands run, \d+\.\d s\. Stop, or Ctrl or ⌘ \+ \., ends the run\./,
  );
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator("#console-output")).toContainText("--Break--");
  await expect(progress).toBeHidden();
  await expect(page.locator("#console-status")).toContainText(
    "as they do after Break in Stata",
    { timeout: 30000 },
  );
  // A short run does not flash the progress line.
  await type(page, "display 1");
  await expect(progress).toBeHidden();
});

test("the returning student finds the do-file, and the page passes axe and fits a phone", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill("sysuse study, clear\nsummarize score\nregres score hours");
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator("#console-source")).toHaveValue(
    "sysuse study, clear\nsummarize score\nregres score hours",
  );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 3");
  // From a result back to its line, by keyboard.
  const goTo = page
    .locator("#console-output .console-record")
    .nth(1)
    .getByRole("button", { name: /^Go to line/ });
  await goTo.focus();
  await expect(goTo).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#console-source")).toBeFocused();
  expect(
    await page
      .locator("#console-source")
      .evaluate(
        (area) => area.value.slice(0, area.selectionStart).split("\n").length,
      ),
  ).toBe(2);
  await audit(page);
  await noSideScroll(page);
  for (const id of ["variables", "browse", "data", "commands", "about"])
    await drawer(page, id);
  await page.locator("#console-filter").fill("regress");
  await page
    .locator("#console-commands li:visible")
    .first()
    .getByRole("button")
    .click();
  await audit(page);
  await noSideScroll(page);
  // Every new control is big enough to tap.
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".console-keep button, .console-tool, .browse-pages button, #browse-go, .console-sort, .browse-sort, .console-help-name",
      ),
    ]
      .filter((node) => node.checkVisibility())
      .map((node) => [node.textContent.trim(), node.getBoundingClientRect()])
      .filter(([, box]) => box.height < 24 && box.width < 24)
      .map(([text]) => text),
  );
  expect(small).toEqual([]);
});
