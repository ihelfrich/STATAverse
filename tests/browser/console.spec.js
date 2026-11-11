import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
    await page.locator("#console-dataset").selectOption("study");
    await expect(page.locator("#console-memory")).toContainText(
      "24 observations, 5 variables",
    );
    await source.fill("sysuse auto");
    await page.locator("#console-run").click();
    await expect(output).toContainText("This site's datasets are");
    await page.locator("#console-reset").click();
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
  await expect(page.locator("#console-status")).toContainText(
    'import delimited using "my wages.csv", clear',
  );
  await expect(page.locator("#console-files")).toContainText("my wages.csv");
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
  await page.locator("#console-reset").click();
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
  await expect(selection).toBeEnabled();
  await page.locator("#console-reset").click();
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
  await source.fill("summarize ");
  await page.locator(".console-name", { hasText: "attendance" }).click();
  await expect(source).toHaveValue("summarize attendance");

  // The classic colours are kept for the next visit.
  const scheme = page.locator("#console-scheme");
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

test("the map builds a do-file from linked steps and runs it step by step", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await page.locator("#console-mode-map").click();
  await expect(page.locator("#console-map")).toBeVisible();
  await expect(page.locator(".console-code")).toBeHidden();
  const steps = page.locator(".map-step");
  await expect(steps).toHaveCount(7);
  await expect(page.locator(".map-link")).toHaveCount(6);
  await expect(steps.first().locator(".map-code")).toHaveText(
    "sysuse schools, clear",
  );

  // Running the map marks each step and prints its results.
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 7 commands in/);
  await expect(page.locator('.map-step[data-state="done"]')).toHaveCount(7);
  await expect(page.locator("#console-output")).toContainText(
    ". regress posttest treated pretest ses, vce(cluster school)",
  );
  // A model that ran shows its coefficients beside its variables.
  await expect(
    page.locator('.map-step[data-kind="model"] .map-estimate').first(),
  ).toHaveText(/^-?[\d.]+$/);

  // A step added after a model can ask about that model; it starts open.
  const model = page.locator('.map-step[data-kind="model"]').last();
  await model.locator(".map-add").selectOption("after");
  await expect(steps).toHaveCount(8);
  const fresh = page
    .locator(".map-step", { has: page.locator('[data-field="what"]:visible') })
    .last();
  await fresh.locator('[data-field="what"]').selectOption("estat ic");
  await expect(fresh.locator(".map-code")).toHaveText("estat ic");
  await fresh.locator(".map-run").click();
  await expect(page.locator("#console-output")).toContainText(
    "Akaike's information criterion",
  );

  // A step that is not filled in says so and cannot be run alone.
  await steps.first().locator(".map-add").selectOption("generate");
  const empty = page.locator('.map-step[data-complete="false"]');
  await expect(empty).toHaveCount(1);
  await expect(empty.locator(".map-run")).toBeDisabled();
  // A name selected in Variables goes to the field last used in the map.
  await empty.locator('[data-field="expression"]').focus();
  await page.locator(".console-name", { hasText: /^pretest$/ }).click();
  await expect(empty.locator('[data-field="expression"]')).toHaveValue(
    "pretest",
  );
  await empty.locator('[data-field="name"]').fill("copy");
  await expect(
    page.locator(".map-code", { hasText: "generate copy = pretest" }),
  ).toHaveCount(1);

  // The map is kept, and can be written out as a do-file.
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(page.locator(".map-step")).toHaveCount(9);
  await page.locator("#map-export").click();
  await expect(page.locator("#console-source")).toHaveValue(
    /^sysuse schools, clear\n[^]*estat ic\ngenerate copy = pretest\n$/,
  );
  await expect(page.locator("#console-source")).toHaveValue(/estat ic/);
  await expect(page.locator("#console-map")).toBeHidden();

  // Another starting map replaces it; a failing step is marked.
  await page.locator("#console-mode-map").click();
  await page.locator("#map-starter").selectOption("trial");
  await expect(page.locator(".map-step")).toHaveCount(7);
  await expect(page.locator(".map-code").nth(1)).toHaveText(
    "keep if smoker == 1",
  );
  const keep = page.locator('.map-step[data-kind="keep"]');
  await keep.locator(".map-edit").click();
  await keep.locator('[data-field="condition"]').fill("nothing == 1");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/return code 111/);
  await expect(keep).toHaveAttribute("data-state", "error");
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
  await page.locator("#console-fox").click();
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
