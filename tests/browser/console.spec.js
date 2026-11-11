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
