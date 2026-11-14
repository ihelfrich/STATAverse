import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Controls that are not needed at first sit in the More menu and in drawers.
async function menu(page, selector) {
  const more = page.locator("#console-more");
  if ((await more.getAttribute("open")) === null)
    await more.locator("summary").click();
  if (selector) await page.locator(selector).click();
}
async function drawer(page, id) {
  const box = page.locator(`#drawer-${id}`);
  if ((await box.getAttribute("open")) === null)
    await box.locator("> summary").click();
}
// A map card shows its fields and actions once its title is selected.
async function openCard(card) {
  if (
    (await card.locator(".map-kind").getAttribute("aria-expanded")) !== "true"
  )
    await card.locator(".map-kind").click();
}
async function addAfter(card, kind) {
  await openCard(card);
  await card.locator(".map-add").selectOption(kind);
}

for (const fallback of [false, true])
  test(`the console runs a do-file on the new runtime through ${fallback ? "the page" : "a worker"}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw new Error("Test blocked worker");
          }
        };
      });
    await page.goto("/Console/");
    await expect(page.locator("body")).toHaveAttribute(
      "data-console-runner",
      fallback ? "page" : "worker",
    );
    await expect(page.locator("#console-status")).toHaveText("Ready.");
    const source = page.locator("#console-source");
    await expect(source).toHaveValue(/sysuse study, clear/);
    await page.locator("#console-run").click();
    const output = page.locator("#console-output");
    await expect(output).toContainText(". regress score hours attendance");
    await expect(output).toContainText("Number of obs   =");
    await expect(output).toContainText("F(  1,");
    const graph = output.locator("img.console-graph");
    await expect(graph).toHaveCount(1);
    await expect(graph).toHaveAttribute(
      "alt",
      /Graph of .* against Weekly study hours/,
    );
    expect(await graph.evaluate((image) => image.naturalWidth)).toBeGreaterThan(
      0,
    );
    await expect(page.locator("#console-memory")).toContainText(
      "24 observations, 6 variables",
    );
    await expect(
      page.locator("#console-variable-table tbody tr").last(),
    ).toContainText("passed");

    // An error stops the do-file, shows Stata's message and keeps the session.
    await source.fill("generate double z = hours / 2\ngenerate z = 1\ncount");
    await source.press("ControlOrMeta+Enter");
    await expect(output).toContainText("variable z already defined");
    await expect(output).toContainText("r(110);");
    await expect(page.locator("#console-status")).toContainText(
      "return code 110",
    );
    await expect(
      page.locator("#console-variable-table tbody tr").last(),
    ).toContainText("z");

    // Macros, loops and programs.
    await source.fill(
      "program define twice\n  args v\n  display \"`v' doubled is \" `v' * 2\nend\nforvalues i = 1/3 {\n  twice `i'\n}",
    );
    await page.locator("#console-run").click();
    await expect(output).toContainText("3 doubled is 6");

    // The text survives a reload; the session does not.
    await page.reload();
    await expect(page.locator("#console-status")).toHaveText("Ready.");
    await expect(source).toHaveValue(/program define twice/);
    await expect(page.locator("#console-memory")).toHaveText(
      "No data in memory.",
    );

    // Starting from a site dataset, and clearing the session.
    await drawer(page, "data");
    await page.getByRole("button", { name: "Load study" }).click();
    await expect(page.locator("#console-memory")).toContainText(
      "24 observations, 5 variables",
    );
    await source.fill("sysuse auto");
    await page.locator("#console-run").click();
    await expect(output).toContainText("This site's datasets are");
    await menu(page, "#console-reset");
    await expect(output).toHaveText("");

    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations.map((v) => v.id)).toEqual([]);
  });

test("a long do-file can be stopped, which clears the session", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page
    .locator("#console-source")
    .fill(
      "clear\nset obs 200000\nforvalues i = 1/3000 {\n  generate double v`i' = sqrt(_n) * `i'\n}",
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText("Running…");
  const stop = page.locator("#console-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.locator("#console-output")).toContainText("--Break--");
  await expect(page.locator("#console-status")).toContainText(
    "The session was cleared",
  );
  await expect(page.locator("#console-memory")).toHaveText(
    "No data in memory.",
  );
  await expect(stop).toBeHidden();
  // The new session works.
  await page.locator("#console-source").fill("display 6 * 7");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-output")).toContainText("42");
});

test("a worker that dies mid-run is replaced, and the next run works", async ({
  page,
}) => {
  // The worker is the real one, wrapped so that a do-file containing
  // __die__ ends it the way a crash would: an error event, then nothing.
  await page.route(/console-worker\.js/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("real")) return route.continue();
    url.searchParams.set("real", "1");
    return route.fulfill({
      contentType: "text/javascript",
      body: `await import(${JSON.stringify(url.href)});
const inner = self.onmessage;
self.onmessage = (event) => {
  if (event.data.kind === "run" && event.data.source.includes("__die__")) {
    self.close();
    throw new Error("worker died");
  }
  inner(event);
};`,
    });
  });
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator("body")).toHaveAttribute(
    "data-console-runner",
    "worker",
  );
  const source = page.locator("#console-source"),
    output = page.locator("#console-output");
  await source.fill("display 1 // __die__");
  await page.locator("#console-run").click();
  await expect(output).toContainText("The interpreter stopped unexpectedly");
  await expect(page.locator("#console-status")).toContainText(
    "The session was cleared",
  );
  await expect(page.locator("#console-run")).toBeEnabled();
  await source.fill("display 6 * 7");
  await page.locator("#console-run").click();
  await expect(output).toContainText("42");
});

test("a student's own CSV file can be added and imported", async ({ page }) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator("#console-files")).toContainText("study.csv");
  await page.locator("#console-file").setInputFiles({
    name: "my wages.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'Worker,Wage,Region\n1,21.5,"North, coastal"\n2,,South\n3,30,North\n',
    ),
  });
  // The file is loaded at once, with the command that did it in Results.
  await expect(page.locator("#console-status")).toContainText(
    "Added my wages.csv.",
  );
  await expect(page.locator("#console-output")).toContainText(
    '. import delimited using "my wages.csv", clear',
  );
  await expect(page.locator("#console-memory")).toContainText(
    "3 observations, 3 variables",
  );
  await expect(page.locator("#console-files")).toContainText("my wages.csv");
  await expect(page.locator("#console-own li")).toHaveCount(1);
  await page
    .locator("#console-source")
    .fill('import delimited using "my wages.csv", clear\nsummarize wage\nlist');
  await page.locator("#console-run").click();
  const output = page.locator("#console-output");
  await expect(output).toContainText("(3 vars, 3 obs)");
  await expect(output).toContainText("North, coastal");
  await expect(page.locator("#console-memory")).toContainText(
    "3 observations, 3 variables",
  );
  // The file survives clearing the session.
  await menu(page, "#console-reset");
  await expect(page.locator("#console-files")).toContainText("my wages.csv");
});

test("the console's command line, examples and editor tools work", async ({
  page,
}) => {
  await page.goto("/Console/");
  const status = page.locator("#console-status"),
    output = page.locator("#console-output"),
    source = page.locator("#console-source"),
    command = page.locator("#console-command");
  await expect(status).toHaveText("Ready.");

  // One command at a time, against the same session, with history.
  await command.fill("sysuse wages, clear");
  await command.press("Enter");
  await expect(output).toContainText(". sysuse wages, clear");
  await command.fill("display 6 * 7");
  await command.press("Enter");
  await expect(output).toContainText("42");
  await expect(page.locator("#console-memory")).toContainText(
    "30 observations",
  );
  await expect(command).toBeEnabled();
  await command.press("ArrowUp");
  await expect(command).toHaveValue("display 6 * 7");
  await command.press("ArrowUp");
  await expect(command).toHaveValue("sysuse wages, clear");
  await command.fill("");

  // An example replaces the do-file, and the editor paints and numbers it.
  await page.locator("#console-example").selectOption("iv");
  await expect(source).toHaveValue(/ivregress 2sls y \(x = z\)/);
  await expect(status).toContainText("Loaded");
  await expect(
    page.locator("#console-highlight .hl-command").first(),
  ).toHaveText("clear");
  expect(await page.locator("#console-highlight").textContent()).toBe(
    (await source.inputValue()) + "\n",
  );
  await expect(page.locator("#console-gutter")).toContainText("14");
  await page.locator("#console-run").click();
  await expect(output).toContainText("First-stage regression summary");
  await expect(status).toHaveAttribute("data-state", "done");

  // Only the selected lines run.
  await source.fill("display 111\ndisplay 222\ndisplay 333");
  await source.evaluate((area) => {
    area.focus();
    area.setSelectionRange(14, 18);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selection = page.locator("#console-run-selection");
  await expect(selection).toBeVisible();
  await menu(page, "#console-reset");
  await source.evaluate((area) => {
    area.focus();
    area.setSelectionRange(14, 18);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await selection.click();
  await expect(output).toContainText("222");
  await expect(output).not.toContainText("111");
  await expect(output).not.toContainText("333");

  // A variable's name goes into the do-file where the cursor is.
  await command.fill("sysuse study, clear");
  await command.press("Enter");
  await expect(page.locator("#console-memory")).toContainText(
    "24 observations",
  );
  await source.fill("summarize ");
  await page.locator(".console-name", { hasText: "attendance" }).click();
  await expect(source).toHaveValue("summarize attendance");

  // The classic colours are kept for the next visit.
  const scheme = page.locator("#console-scheme");
  await menu(page);
  await scheme.click();
  await expect(page.locator("#console-window")).toHaveAttribute(
    "data-scheme",
    "classic",
  );
  await expect(page.locator(".console-number").first()).toBeVisible();
  await expect(page.locator("#console-window")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  const classic = await new AxeBuilder({ page })
    .include("#console-window")
    .analyze();
  expect(classic.violations.map((v) => v.id)).toEqual([]);
  await page.reload();
  await expect(status).toHaveText("Ready.");
  await expect(scheme).toHaveAttribute("aria-pressed", "true");

  // The list of commands can be searched.
  await drawer(page, "commands");
  await page.locator("#console-filter").fill("marg");
  await expect(page.locator("#console-commands li:visible")).toHaveText([
    "margins",
    "marginsplot",
  ]);
  await page.locator("#console-filter").fill("reghdfe");
  await expect(page.locator("#console-found")).toContainText(
    "No command here is called reghdfe",
  );
});

test("results arrive at once when motion is reduced", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-output")).toContainText("F(  1,");
  await expect(page.locator(".console-record.is-arriving")).toHaveCount(0);
  const graph = page.locator("img.console-graph");
  expect(await graph.getAttribute("src")).not.toContain("keyframes");
});

test("the map builds do-files from linked steps and runs them step by step", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page.locator("#console-mode-map").click();
  await expect(page.locator("#console-map")).toBeVisible();
  await expect(page.locator(".console-code")).toBeHidden();
  const steps = page.locator(".map-step"),
    code = page.locator("#mapcode-view");
  await expect(steps).toHaveCount(7);
  await expect(page.locator(".map-link")).toHaveCount(6);
  await expect(steps.first().locator(".map-code")).toHaveText(
    "sysuse schools, clear",
  );
  // The do-file the map writes is beside it, a line for each command.
  await expect(code.locator(".mapcode-line")).toHaveCount(7);
  await expect(code).toContainText("main.do");
  // The dataset's variables are offered before anything has run.
  await expect(page.locator(".map-name")).toHaveCount(9);

  // Running the map marks each step and keeps each step's result on its card.
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 7 commands in/);
  await expect(page.locator('.map-step[data-state="done"]')).toHaveCount(7);
  await expect(page.locator("#console-output")).toContainText(
    ". regress posttest treated pretest ses, vce(cluster school)",
  );
  const firstModel = page.locator('.map-step[data-kind="model"]').first();
  await expect(firstModel.locator(".map-estimate").first()).toHaveText(
    /^-?[\d.]+$/,
  );
  await firstModel.locator(".map-peek").click();
  await expect(firstModel.locator(".map-output")).toContainText(
    "Std. err. adjusted for 24 clusters in school",
  );
  await firstModel.locator(".map-output-close").click();
  await expect(page.locator(".map-output")).toHaveCount(0);

  // A step added after a model can ask about that model; it starts open.
  const model = page.locator('.map-step[data-kind="model"]').last();
  await addAfter(model, "after");
  await expect(steps).toHaveCount(8);
  const fresh = page
    .locator(".map-step", { has: page.locator('[data-field="what"]:visible') })
    .last();
  await fresh.locator('[data-field="what"]').selectOption("estat ic");
  await expect(fresh.locator(".map-code")).toHaveText("estat ic");
  await expect(code.locator(".mapcode-line")).toHaveCount(8);
  await fresh.locator(".map-run").click();
  await expect(page.locator("#console-output")).toContainText(
    "Akaike's information criterion",
  );

  // A step that is not filled in says so and cannot be run alone.
  await addAfter(steps.first(), "generate");
  const empty = page.locator('.map-step[data-complete="false"]');
  await expect(empty).toHaveCount(1);
  await expect(empty.locator(".map-run")).toBeDisabled();
  // A variable chosen above the map goes to the field last used.
  await empty.locator('[data-field="expression"]').focus();
  await page.locator(".map-name", { hasText: /^pretest$/ }).click();
  await expect(empty.locator('[data-field="expression"]')).toHaveValue(
    "pretest",
  );
  await empty.locator('[data-field="name"]').fill("copy");
  await expect(
    page.locator(".map-code", { hasText: "generate copy = pretest" }),
  ).toHaveCount(1);
  // The line it wrote appears in the do-file, marked as just changed.
  await expect(
    code.locator(".mapcode-line", { hasText: "generate copy = pretest" }),
  ).toHaveCount(1);

  // Steps after "Start a do-file" go to a file of their own.
  const last = page.locator('.map-step[data-kind="generate"]');
  await addAfter(last, "file");
  const file = page.locator('.map-step[data-kind="file"]');
  await file.locator('[data-field="name"]').fill("checks");
  await addAfter(file, "look");
  await expect(code.locator(".mapcode-name")).toHaveText([
    "main.do",
    "checks.do",
  ]);
  await expect(code).toContainText('do "checks.do"');

  // The map is kept, and can be opened as do-files that run together.
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator(".map-step")).toHaveCount(11);
  await menu(page, "#map-export");
  await expect(page.locator("#console-map")).toBeHidden();
  await expect(page.locator(".console-tab")).toHaveText([
    "main.do",
    "checks.do",
  ]);
  await expect(page.locator("#console-source")).toHaveValue(
    /^sysuse schools, clear\n[^]*estat ic\ngenerate copy = pretest\ndo "checks.do"\n$/,
  );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran \d+ commands/);
  await expect(page.locator("#console-output")).toContainText(
    '. do "checks.do"',
  );

  // Another starting map replaces it; a failing step says why on its card.
  await page.locator("#console-mode-map").click();
  await page.locator("#map-starter").selectOption("trial");
  await expect(page.locator(".map-step")).toHaveCount(7);
  const keep = page.locator('.map-step[data-kind="keep"]');
  await openCard(keep);
  await keep.locator('[data-field="condition"]').fill("nothing == 1");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/return code 111/);
  await expect(keep).toHaveAttribute("data-state", "error");
  await expect(keep.locator(".map-problem")).toContainText("nothing not found");
  await expect(page.locator("#fox-says")).toContainText("r(111)");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("the fox gives a tip and can be hidden; datasets load from their cards", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  const fox = page.locator("#fox-seat .fox");
  await expect(fox).toBeVisible();
  await fox.click();
  await expect(page.locator("#fox-says")).not.toBeEmpty();
  await menu(page, "#console-fox");
  await expect(fox).toBeHidden();
  await expect(page.locator("#fox-says")).toBeEmpty();
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator("#fox-seat .fox")).toBeHidden();
  await expect(page.locator("#console-fox")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await expect(page.locator("#console-datasets li")).toHaveCount(9);
  await drawer(page, "data");
  await page.getByRole("button", { name: "Load trade" }).click();
  await expect(page.locator("#console-memory")).toContainText(
    "240 observations, 9 variables",
  );
  await expect(page.locator("#console-output")).toContainText(
    "Exporting country",
  );
  // The example menu is grouped, and every example is offered.
  await expect(page.locator("#console-example optgroup")).toHaveCount(4);
  await expect(page.locator("#console-example option")).toHaveCount(20);
  await page.locator("#console-example").selectOption("gravity");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran \d+ commands/);
  await expect(page.locator("#console-output")).toContainText(
    "Poisson regression",
  );
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a project has several do-files, a menu of patterns, and downloads as a folder", async ({
  page,
}) => {
  await page.goto("/Console/");
  const status = page.locator("#console-status"),
    source = page.locator("#console-source");
  await expect(status).toHaveText("Ready.");
  await expect(page.locator(".console-tab")).toHaveText(["main.do"]);
  await expect(page.locator("#console-tab-delete")).toBeDisabled();

  // A second file, named, that the first one runs.
  await menu(page, "#console-tab-new");
  await menu(page);
  await page.locator("#console-tab-name").fill("clean data");
  await page.locator("#console-tab-name").press("Enter");
  await expect(page.locator(".console-tab")).toHaveText([
    "main.do",
    "clean_data.do",
  ]);
  await source.fill("generate lwage = ln(wage)\n");
  await page.locator(".console-tab", { hasText: "main.do" }).click();
  await source.fill(
    'sysuse labor, clear\ndo "clean_data.do"\nsummarize lwage\n',
  );
  await page.locator("#console-run").click();
  await expect(status).toHaveText(/Ran \d+ commands/);
  await expect(page.locator("#console-output")).toContainText(
    ". generate lwage = ln(wage)",
  );
  await expect(page.locator("#console-memory")).toContainText("12 variables");

  // The Insert menu puts a pattern on its own line at the cursor.
  await source.press("ControlOrMeta+End");
  await menu(page);
  await page.locator("#console-insert").selectOption({
    label: "Average effects: margins, dydx(*)",
  });
  await expect(source).toHaveValue(/summarize lwage\nmargins, dydx\(\*\)\n$/);
  await expect(page.locator("#console-insert optgroup")).toHaveCount(6);

  // Both files are kept between visits.
  await page.reload();
  await expect(status).toHaveText("Ready.");
  await expect(page.locator(".console-tab")).toHaveText([
    "main.do",
    "clean_data.do",
  ]);

  // The project downloads as a zip: the do-files, the data and a note.
  const waiting = page.waitForEvent("download");
  await menu(page, "#console-download");
  const download = await waiting;
  expect(download.suggestedFilename()).toBe("stata-project.zip");
  const bytes = await (await download.createReadStream()).toArray(),
    text = Buffer.concat(bytes).toString("latin1");
  for (const name of [
    "stata-project/main.do",
    "stata-project/clean_data.do",
    "stata-project/data/labor.dta",
    "stata-project/README.txt",
  ])
    expect(text).toContain(name);
  // On the student's computer sysuse becomes use of the copy in data/.
  expect(text).toContain('use "data/labor.dta", clear');
  expect(text).not.toContain("sysuse labor");

  await page.locator(".console-tab", { hasText: "clean_data.do" }).click();
  await menu(page, "#console-tab-delete");
  await expect(page.locator(".console-tab")).toHaveText(["main.do"]);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a Stata .dta file and a do-file can be added, and a map started from the data", async ({
  page,
}) => {
  const fs = await import("node:fs");
  await page.goto("/Console/");
  const status = page.locator("#console-status");
  await expect(status).toHaveText("Ready.");
  await page.locator("#console-file").setInputFiles([
    {
      name: "fromstata.dta",
      mimeType: "application/octet-stream",
      buffer: fs.readFileSync("tests/fixtures/dta/fromstata118.dta"),
    },
    {
      name: "extra steps.do",
      mimeType: "text/plain",
      buffer: Buffer.from("describe\n"),
    },
  ]);
  await expect(status).toContainText(
    "Added fromstata.dta: 3 rows, 7 variables.",
  );
  await expect(status).toContainText("Opened extra_steps.do");
  await expect(page.locator("#console-output")).toContainText(
    '. use "fromstata.dta", clear',
  );
  await expect(page.locator("#console-output")).toContainText(
    "A double, with a long label",
  );
  await expect(page.locator("#console-memory")).toContainText(
    "3 observations, 7 variables",
  );
  await expect(page.locator(".console-tab")).toHaveText([
    "main.do",
    "extra_steps.do",
  ]);

  // A file that is not data is refused with a reason.
  await page.locator("#console-file").setInputFiles({
    name: "book.rds",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("X\n"),
  });
  await expect(status).toContainText("book.rds is an R file");
  await page.locator("#console-file").setInputFiles({
    name: "broken.dta",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a dataset at all"),
  });
  await expect(status).toContainText("this is not a Stata .dta file");
  await expect(page.locator("#console-own li")).toHaveCount(1);

  // A map can start from the file, and a download carries it.
  await drawer(page, "data");
  await page.getByRole("button", { name: "Start a map from it" }).click();
  await expect(page.locator(".map-step")).toHaveCount(1);
  await expect(page.locator(".map-code")).toHaveText(
    'use "fromstata.dta", clear',
  );
  await addAfter(page, "look");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 2 commands/);
  const waiting = page.waitForEvent("download");
  await menu(page, "#console-download");
  const bytes = await (await (await waiting).createReadStream()).toArray(),
    text = Buffer.concat(bytes).toString("latin1");
  expect(text).toContain("stata-project/fromstata.dta");
  expect(text).toContain('use "fromstata.dta", clear');

  await page.locator("#console-mode-write").click();
  await page.getByRole("button", { name: "Remove fromstata.dta" }).click();
  await expect(page.locator("#console-own li")).toHaveCount(0);
  await expect(page.locator("#console-files")).not.toContainText(
    "fromstata.dta",
  );
});

test("the first screen is the editor, Run and Results; the rest is one step away", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  // Run is in view without scrolling, on a laptop and on a phone.
  await expect(page.locator("#console-run")).toBeInViewport();
  await expect(page.locator("#console-source")).toBeInViewport();
  // Nothing below the work is open until it is asked for.
  for (const id of ["variables", "data", "commands", "about"])
    await expect(page.locator(`#drawer-${id}`)).not.toHaveAttribute("open");
  await expect(page.locator(".console-menu-panel")).toBeHidden();
  await expect(page.locator("#console-tabs-bar")).toBeHidden();
  await expect(page.locator("#console-run-selection")).toBeHidden();
  // The words a new visitor meets before doing anything are few.
  const words = await page.evaluate(() => {
    let count = 0;
    const walker = document.createTreeWalker(
      document.querySelector("main"),
      NodeFilter.SHOW_TEXT,
    );
    for (let node; (node = walker.nextNode());) {
      const parent = node.parentElement;
      if (
        parent.closest(
          "#console-source, #console-highlight, #console-gutter, option, .sr-only",
        ) ||
        !parent.checkVisibility()
      )
        continue;
      count += (node.textContent.trim().match(/\S+/g) ?? []).length;
    }
    return count;
  });
  expect(words).toBeLessThan(45);
  expect(words).toBeGreaterThan(5);

  // The menu opens, offers its groups, and closes on Escape and after a choice.
  await page.locator("#console-more > summary").click();
  await expect(page.locator(".console-menu-panel")).toBeVisible();
  await expect(page.locator(".console-menu-group:visible h3")).toHaveText([
    "Do-file",
    "Project",
    "View",
  ]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".console-menu-panel")).toBeHidden();
  await page.locator("#console-more > summary").click();
  await page.locator("#console-tab-new").click();
  await expect(page.locator(".console-menu-panel")).toBeHidden();
  // A second file brings the tabs.
  await expect(page.locator(".console-tab")).toHaveText(["main.do", "part.do"]);

  // Running opens the list of variables by itself, once.
  await page.locator(".console-tab", { hasText: "main.do" }).click();
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran \d+ commands/);
  await expect(page.locator("#drawer-variables")).toHaveAttribute("open", "");
  await expect(page.locator("#console-memory")).toContainText(
    "24 observations",
  );

  // In the map the first step is in view, and the menu offers the map's tools.
  await page.locator("#console-mode-map").click();
  await expect(page.locator(".map-step").first()).toBeInViewport();
  await expect(page.locator("#console-run")).toHaveText("Run map");
  await page.locator("#console-more > summary").click();
  await expect(page.locator(".console-menu-group:visible h3")).toHaveText([
    "Map",
    "Project",
    "View",
  ]);
  // A card shows one control until its title is selected.
  const card = page.locator(".map-step").nth(1);
  await page.keyboard.press("Escape");
  await expect(card.locator("button:visible, select:visible")).toHaveCount(1);
  await card.locator(".map-kind").click();
  await expect(card.locator(".map-run")).toBeVisible();
  // The data in memory downloads as a Stata dataset.
  const waiting = page.waitForEvent("download");
  await menu(page, "#console-download-data");
  expect((await waiting).suggestedFilename()).toBe("data.dta");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a line of the do-file and what it printed point at each other", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  const source = page.locator("#console-source"),
    lineOf = (pattern) =>
      source.evaluate(
        (node, text) =>
          node.value.split("\n").findIndex((line) => line.startsWith(text)) + 1,
        pattern,
      ),
    caretOn = (line) =>
      source.evaluate((node, to) => {
        let at = 0;
        for (let k = 1; k < to; k++) at = node.value.indexOf("\n", at) + 1;
        node.focus();
        node.setSelectionRange(at, at);
      }, line),
    ticks = () =>
      page
        .locator(".gutter-line[data-state]")
        .evaluateAll((nodes) => nodes.map((node) => Number(node.textContent)));
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 9");
  // Every line that ran is ticked in the gutter; comments and blanks are not.
  const regress = await lineOf("regress");
  expect(await ticks()).toHaveLength(9);
  expect(await ticks()).toContain(regress);
  // The caret on a line lights what that line printed.
  await caretOn(regress);
  const lit = page.locator(".console-record.is-linked");
  await expect(lit).toHaveCount(1);
  await expect(lit).toContainText(". regress score hours attendance");
  await expect(page.locator("#console-band")).toBeVisible();
  // Selecting a command in Results puts the caret on its line.
  await page
    .locator(".console-record.has-line .console-command", {
      hasText: "tabulate",
    })
    .click();
  await expect(source).toBeFocused();
  expect(
    await source.evaluate(
      (node) => node.value.slice(0, node.selectionStart).split("\n").length,
    ),
  ).toBe(await lineOf("tabulate"));
  // A line added above moves the ticks down with their lines.
  const before = await ticks();
  await source.evaluate((node) => node.setSelectionRange(0, 0));
  await page.keyboard.type("* a note\n");
  expect(await ticks()).toEqual(before.map((line) => line + 1));
  // Editing a line that ran removes its tick; the others stay.
  await caretOn((await lineOf("regress")) + 0);
  await page.keyboard.type(" ");
  expect(await ticks()).toHaveLength(8);
  // A run that stops marks the line that stopped it, and shows the error.
  await source.evaluate((node) => {
    node.setSelectionRange(node.value.length, node.value.length);
  });
  await page.keyboard.type("\nsummarize nosuchvar\ndisplay 1");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText(
    "return code 111",
  );
  const stopped = page.locator('.gutter-line[data-state="error"]');
  await expect(stopped).toHaveCount(1);
  expect(Number(await stopped.textContent())).toBe(
    await lineOf("summarize nosuchvar"),
  );
  await expect(page.locator("#console-fault")).toBeVisible();
  await expect(page.locator(".console-error").last()).toBeInViewport();
  // Table rules are drawn, and are still text.
  await expect(page.locator(".console-rule").first()).toHaveText(/^-{4,}/);
  // Clearing the session clears the marks.
  await menu(page, "#console-reset");
  await expect(page.locator(".gutter-line[data-state]")).toHaveCount(0);
  await expect(page.locator("#console-fault")).toBeHidden();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a map card and its results point at each other", async ({ page }) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page.locator("#console-mode-map").click();
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran");
  const model = page.locator('.map-step[data-kind="model"]').first();
  await model.hover();
  await expect(page.locator(".console-record.is-linked").first()).toContainText(
    ". regress",
  );
  await expect(page.locator(".map-port")).not.toHaveCount(0);
  // Selecting a command in Results finds its card.
  await page
    .locator(".console-record[data-step] .console-command", {
      hasText: "estimates store",
    })
    .first()
    .click();
  await expect(page.locator(".map-step.is-linked")).toContainText(
    "estimates store",
  );
});

test("the monospace is served by the site and keeps columns aligned", async ({
  page,
}) => {
  const remote = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") remote.push(request.url());
  });
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText("Ran 9");
  const measured = await page.evaluate(async () => {
    await document.fonts.ready;
    const output = document.getElementById("console-output"),
      per = (text) => {
        const span = document.createElement("span");
        span.textContent = text;
        output.append(span);
        const width = span.getBoundingClientRect().width / text.length;
        span.remove();
        return width;
      };
    return {
      loaded: [...document.fonts].some(
        (face) =>
          face.family.includes("STATAverse Mono") && face.status === "loaded",
      ),
      widths: ["iiii", "MMMM", "----+----", ">= != -> <=", "0123"].map(per),
    };
  });
  expect(measured.loaded).toBe(true);
  // Every character is as wide as every other; no ligature joins two.
  for (const width of measured.widths)
    expect(Math.abs(width - measured.widths[0])).toBeLessThan(0.01);
  // One copy of the font is fetched, not two.
  expect(remote).toHaveLength(1);
  for (const url of remote)
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
});
