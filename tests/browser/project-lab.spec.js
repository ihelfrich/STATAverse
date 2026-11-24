import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";

// The project lab: twelve guided steps on one Stata session in a worker,
// on the simulated panel or on a file the student opens.
test.describe.configure({ timeout: 120000 });

async function ready(page) {
  await page.goto("/Labs/Project/");
  await expect(page.locator("body")).toHaveAttribute(
    "data-project-ready",
    "true",
    { timeout: 60000 },
  );
  await expect(page.locator("#step-run")).toBeEnabled();
}
/** Waits until whatever is running has finished. */
const idle = (page) =>
  expect(page.locator("#step-run")).toBeEnabled({ timeout: 60000 });
/** Shows the three hints, then puts the worked lines in the editor. */
async function useWorked(page) {
  const hint = page.locator("#step-hint");
  while (await hint.isEnabled()) await hint.click();
  const worked = page.locator("#step-worked");
  if (await worked.isHidden())
    await page.locator("#step-worked-button").click();
  await page.locator("#step-worked-use").click();
}
async function runStep(page) {
  await page.locator("#step-run").click();
  await idle(page);
}
const step = (page, number) =>
  page.locator(`#project-steps button[data-step="${number - 1}"]`);
const overflow = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
async function typed(page, command) {
  await page.locator("#project-command").fill(command);
  await page.locator("#project-command").press("Enter");
  await idle(page);
}

test("every step completes with its worked lines, and the session comes back after a reload", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await ready(page);
  await expect(page.locator("#project-output")).toContainText(
    /The simulated panel is in memory: [\d,]+ firm-years, 19 variables/,
  );
  for (let number = 1; number <= 12; number++) {
    await expect(page.locator("#step-kicker")).toContainText(
      `Step ${number} of 12`,
    );
    await useWorked(page);
    await runStep(page);
    await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
    await expect(page.locator("#step-checks li.is-open")).toHaveCount(0);
    await expect(step(page, number)).toHaveAttribute("data-state", "checked");
    if (number < 12) await page.locator("#step-next").click();
  }
  await expect(page.locator("#project-step-count")).toHaveText(
    "12 of 12 steps done",
  );
  // What the lab shows beside the checks is read from the session.
  await step(page, 8).click();
  await expect(page.locator("#step-report")).toContainText("Where the rows go");
  await expect(page.locator("#step-report tbody tr")).toHaveCount(6);
  await step(page, 11).click();
  await expect(page.locator("#step-report tbody tr")).toHaveCount(5);
  await expect(page.locator("#step-report")).toContainText(
    "The chair coefficient, model by model",
  );
  await step(page, 12).click();
  // Stata's own output is in the Results pane.
  const output = page.locator("#project-output");
  await expect(output).toContainText("Average marginal effects");
  await expect(output).toContainText("Poisson regression");
  // The do-file holds all twelve steps under a header Stata can start from.
  const doFile = page.locator("#project-dofile");
  await expect(doFile).toContainText("clear all");
  await expect(doFile).toContainText('use "YOUR-FILE.dta", clear');
  await expect(doFile).toContainText(
    "*** 12. Whether a firm buys, and how much",
  );
  await expect(doFile).not.toContainText('use "panel.dta", clear');
  const download = page.waitForEvent("download");
  await page.locator("#project-download").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("panel-project.do");
  const text = await fs.readFile(await file.path(), "utf8");
  expect(text).toMatch(/^\* Firm-year panel/);
  expect(text).toContain(
    "est table baseline firm_fe all_fees date_screen uncapped",
  );

  // Progress on the simulated panel is kept, and the session is run again.
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute(
    "data-project-ready",
    "true",
    { timeout: 60000 },
  );
  await expect(page.locator("#project-output")).toContainText(
    "Your session is back",
  );
  await expect(page.locator("#project-step-count")).toHaveText(
    "12 of 12 steps done",
  );
  await step(page, 8).click();
  await expect(page.locator("#step-verdict")).toContainText(
    "complete in this session",
  );
  await typed(page, "count if baseline_sample");
  await expect(
    page.locator("#project-output .project-record").last(),
  ).toContainText(/\d,\d{3}/);
  expect(errors).toEqual([]);
});

test("blanks, hints in order, a wrong answer named in the data, an error, and the command line", async ({
  page,
}) => {
  await ready(page);
  // A scaffold run as it stands is not sent to Stata.
  await page.locator("#step-run").click();
  await expect(page.locator("#step-verdict")).toContainText(
    "Lines 5, 9 still have a blank",
  );
  await expect(page.locator("#project-output .project-record")).toHaveCount(0);
  // Hints come one at a time, and the worked version only after them.
  const worked = page.locator("#step-worked-button");
  await expect(worked).toBeDisabled();
  await page.locator("#step-hint").click();
  await expect(page.locator("#step-hints li")).toHaveCount(1);
  await expect(page.locator("#step-hints li").first()).toContainText("A nudge");
  await expect(worked).toBeDisabled();
  await page.locator("#step-hint").click();
  await page.locator("#step-hint").click();
  await expect(page.locator("#step-hints li")).toHaveCount(3);
  await expect(page.locator("#step-hints li").last()).toContainText(
    "xtset firmid fyear",
  );
  await expect(page.locator("#step-hint")).toBeDisabled();
  await expect(worked).toBeEnabled();

  // Step 6 from a session that holds the worked lines of steps 1 to 5.
  await step(page, 6).click();
  await expect(page.locator("#step-notice")).toContainText(
    "have not been run in this session",
  );
  await page.locator("#project-restart").click();
  await idle(page);
  await expect(page.locator("#step-notice")).toBeHidden();
  for (const number of [1, 5])
    await expect(step(page, number)).toHaveAttribute("data-state", "worked");
  const editor = page.locator("#step-editor"),
    scaffold = await editor.inputValue();

  // A line Stata cannot run: its own message, and nothing after it ran.
  await editor.fill(scaffold.replace("____", "lagged_assets"));
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-error/);
  await expect(page.locator("#step-verdict")).toContainText(
    "lagged_assets not found",
  );
  await expect(
    page.locator("#project-output .project-error-line").first(),
  ).toBeVisible();

  // The unfinished line: it runs, and the check says what it did to the data.
  await editor.fill(scaffold.replace("____", "lag_at"));
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-waiting/);
  const open = page.locator("#step-checks li.is-open");
  await expect(open).toHaveCount(1);
  await expect(open).toContainText(
    /has a value in [\d,]+ rows where oancf is missing/,
  );
  await expect(page.locator("#step-next")).toBeHidden();
  await expect(step(page, 6)).toHaveAttribute("data-state", "open");

  // The command line looks at the same session.
  await typed(page, "count if positive_cfo == 1 & oancf >= .");
  const last = page.locator("#project-output .project-record").last();
  await expect(last).toContainText(". count if positive_cfo == 1 & oancf >= .");
  await expect(last).toContainText(/\d,\d{3}/);
  await typed(page, "tab nosuchvariable");
  await expect(
    page.locator("#project-output .project-record").last(),
  ).toContainText("variable nosuchvariable not found");
  await page.locator("#project-command").press("ArrowUp");
  await expect(page.locator("#project-command")).toHaveValue(
    "tab nosuchvariable",
  );
  await page.locator("#project-command").fill("");

  // Corrected and run again: the step starts afresh, with no "already defined".
  await editor.fill(
    scaffold
      .replace("____", "lag_at")
      .replace(
        "gen positive_cfo = oancf > 0",
        "gen positive_cfo = oancf > 0 if oancf < .",
      ),
  );
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
  await expect(page.locator("#project-output")).not.toContainText(
    "already defined",
  );
  await expect(step(page, 6)).toHaveAttribute("data-state", "checked");

  // A typed command that changes the data goes into the do-file; a look does not.
  await typed(page, "gen double sales_bn = sale/1000");
  await typed(page, "summarize sales_bn");
  const doFile = page.locator("#project-dofile");
  await expect(doFile).toContainText(
    "* typed in the command line\ngen double sales_bn = sale/1000",
  );
  await expect(doFile).not.toContainText("summarize sales_bn");
  await expect(doFile).toContainText(
    "gen positive_cfo = oancf > 0 if oancf < .",
  );

  // The data themselves.
  await page.locator("#tab-variables").click();
  await expect(page.locator("#project-variables")).toContainText("sales_bn");
  await expect(page.locator("#project-memory")).toContainText(
    /observations, \d+ variables/,
  );
  await page.locator("#tab-variables").press("ArrowRight");
  await expect(page.locator("#tab-browse")).toBeFocused();
  await page.locator("#browse-where").fill("firmid fyear at if fyear == 2010");
  await page.locator("#browse-where").press("Enter");
  await expect(page.locator("#browse-grid thead th")).toHaveText([
    "Obs.",
    "firmid",
    "fyear",
    "at",
  ]);
  await expect(page.locator("#browse-grid tbody tr")).toHaveCount(50);
  await expect(page.locator("#browse-status")).toContainText(
    "that meet the condition",
  );
  await page.locator("#browse-next").click();
  await expect(page.locator("#browse-status")).toContainText("Rows 51 to 100");
  await page.locator("#browse-where").fill("nosuch");
  await page.locator("#browse-where").press("Enter");
  await expect(page.locator("#browse-status")).toContainText(
    "nosuch not found",
  );
});

test("restart from a step replays the worked lines, and running an earlier step undoes the later ones", async ({
  page,
}) => {
  await ready(page);
  await step(page, 4).click();
  await page.locator("#project-restart").click();
  await idle(page);
  await expect(page.locator("#project-output")).toContainText(
    "with the worked lines for steps 1 to 3 already run",
  );
  await expect(page.locator("#project-step-count")).toHaveText(
    "3 of 12 steps done",
  );
  await useWorked(page);
  await runStep(page);
  await expect(step(page, 4)).toHaveAttribute("data-state", "checked");
  // The lag came before the years were dropped: 2005 rows have one.
  await typed(page, "count if fyear == 2005 & lag_at < .");
  await expect(
    page.locator("#project-output .project-record").last(),
  ).toContainText(/\d,\d{3}/);

  // Back to step 2: the session returns to where that step began.
  await step(page, 2).click();
  await expect(page.locator("#project-restart-help")).toContainText(
    "runs the worked lines for step 1,",
  );
  await expect(page.locator("#step-notice")).toContainText(
    "steps 3, 4 will need to be run again",
  );
  await useWorked(page);
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
  await expect(step(page, 2)).toHaveAttribute("data-state", "checked");
  await expect(step(page, 3)).toHaveAttribute("data-state", "todo");
  await expect(step(page, 4)).toHaveAttribute("data-state", "todo");
  await page.locator("#tab-variables").click();
  await expect(page.locator("#project-variables")).toContainText("lag_at");
  await expect(page.locator("#project-variables")).not.toContainText("lnnas");
  await expect(page.locator("#project-dofile")).not.toContainText("*** 3.");
});

test("a run can be stopped, and the session is as it was before it", async ({
  page,
}) => {
  await ready(page);
  await step(page, 2).click();
  await page.locator("#project-restart").click();
  await idle(page);
  await page
    .locator("#step-editor")
    .fill(
      "gen lag_at = L.at\nforvalues i = 1/100000 {\n    quietly summarize at, detail\n}",
    );
  await page.locator("#step-run").click();
  const stop = page.locator("#step-stop");
  await expect(stop).toBeVisible();
  await expect(page.locator("#project-status")).toContainText("Running step 2");
  await stop.click();
  await idle(page);
  await expect(stop).toBeHidden();
  await expect(page.locator("#project-output")).toContainText(
    "Stopped. The session is as it was before step 2 was run.",
  );
  await page.locator("#tab-variables").click();
  await expect(page.locator("#project-variables")).toContainText("match_audit");
  await expect(page.locator("#project-variables")).not.toContainText("lag_at");
  await useWorked(page);
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
});

test("a CSV copy of the panel opens as the student's own file and is not kept", async ({
  page,
}) => {
  await ready(page);
  // Some progress on the simulated panel first, to come back to.
  await useWorked(page);
  await runStep(page);
  const download = page.waitForEvent("download");
  await page.locator("#project-csv").click();
  const csv = await download;
  expect(csv.suggestedFilename()).toBe("panel.csv");
  const path = await csv.path(),
    text = await fs.readFile(path, "utf8");
  expect(text.split("\n")[0]).toBe(
    "firmid,gvkey,conm,fyear,datadate,at,dltt,ni,sale,oancf,sich,titleann,non_audit_fees,audit_fees,total_fees,auditor_name,fiscal_ye,match_exec,match_audit",
  );
  await idle(page);

  // A kind of file the lab does not read is refused with what to do.
  await page.locator("#project-file").setInputFiles({
    name: "notes.xlsx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("x"),
  });
  await expect(page.locator("#project-file-message")).toContainText(
    "notes.xlsx is not a .dta or .csv file",
  );
  await expect(page.locator("#project-preflight")).toBeHidden();

  await page.locator("#project-file").setInputFiles({
    name: "my panel.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(text),
  });
  await idle(page);
  await expect(page.locator("#project-file-message")).toContainText(
    "my panel.csv",
  );
  await expect(page.locator("#project-source")).toContainText(
    /Your file my panel\.csv: [\d,]+ observations\. Read on this computer; not uploaded/,
  );
  // The preflight: every column found, and the two the CSV changed repaired.
  const preflight = page.locator("#project-preflight");
  await expect(preflight).toBeVisible();
  await expect(page.locator("#project-preflight-summary")).toContainText(
    "19 of the 19 expected columns are in your file. Every column the main analysis needs is there.",
  );
  await expect(page.locator("#project-preflight-rows tr.is-ok")).toHaveCount(
    19,
  );
  await expect(page.locator("#project-preflight-prep")).toContainText(
    "tostring fiscal_ye, replace format(%04.0f)",
  );
  await expect(page.locator("#project-preflight-prep")).toContainText(
    'generate long datadate_days = date(datadate, "DMY")',
  );
  // The steps start again, on this file, and its first step loads it by name.
  await expect(page.locator("#project-step-count")).toHaveText(
    "0 of 12 steps done",
  );
  await expect(page.locator("#step-editor")).toHaveValue(
    /^import delimited using "my panel\.csv", clear case\(preserve\) asdouble\n/,
  );
  await page.locator("#step-run").click();
  await expect(page.locator("#step-verdict")).toContainText(
    "still have a blank",
  );
  await useWorked(page);
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
  // The date screen, which reads both repaired columns, passes its checks.
  await step(page, 11).click();
  await page.locator("#project-restart").click();
  await idle(page);
  await useWorked(page);
  await runStep(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
  await expect(page.locator("#step-report")).toContainText("firm_fe");
  await expect(page.locator("#project-dofile")).toContainText(
    'import delimited using "my panel.csv", clear case(preserve) asdouble\n* the fee file\'s year-end as four characters, month then day\ntostring fiscal_ye',
  );
  await expect(page.locator("#project-dofile")).not.toContainText("YOUR-FILE");

  // Nothing about the opened file is in this browser's storage.
  const stored = await page.evaluate(() =>
    JSON.stringify(Object.entries(localStorage)),
  );
  expect(stored).not.toContain("my panel");
  expect(stored).not.toContain("import delimited");
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);

  // Back to the simulated panel, with the earlier work on it.
  await page.locator("#project-builtin").click();
  await idle(page);
  await expect(preflight).toBeHidden();
  await expect(page.locator("#project-step-count")).toHaveText(
    "1 of 12 steps done",
  );
  await expect(page.locator("#step-editor")).toHaveValue(
    /^use "panel\.dta", clear\n/,
  );
});

test("at 360 pixels the lab fits, its shortcuts work and it passes an accessibility scan", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await ready(page);
  expect(await overflow(page)).toBe(0);
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
  await expect(page.locator(".lab-mobile-nav")).toBeVisible();
  await page.locator('.lab-mobile-nav [data-jump="project-step"]').click();
  await expect(page.locator("#project-step")).toBeFocused();
  // By keyboard: the editor, then Ctrl+Enter.
  await useWorked(page);
  await page.locator("#step-editor").focus();
  await page.keyboard.press("Control+Enter");
  await idle(page);
  await expect(page.locator("#step-verdict")).toHaveClass(/is-done/);
  await expect(page.locator("#step-checks li.is-met").first()).toBeVisible();
  expect(await overflow(page)).toBe(0);
  await page.locator(".project-see-output").click();
  await expect(page.locator("#project-output")).toBeFocused();
  await expect(page.locator("#project-output")).toContainText(
    "Panel variable: firmid (unbalanced)",
  );
  await page.locator("#tab-browse").click();
  await expect(page.locator("#browse-grid tbody tr")).toHaveCount(50);
  expect(await overflow(page)).toBe(0);
  await page.locator('.lab-mobile-nav [data-jump="project-data-bar"]').click();
  await page.locator(".project-columns summary").click();
  await expect(page.locator("#project-expected tbody tr")).toHaveCount(19);
  expect(await overflow(page)).toBe(0);
  const withStep = await new AxeBuilder({ page }).analyze();
  expect(withStep.violations).toEqual([]);
});

test("the wide layout puts the step beside the session, with nothing cut off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const stepBox = await page.locator("#project-step").boundingBox(),
    results = await page.locator("#project-results").boundingBox();
  expect(results.x).toBeGreaterThan(stepBox.x + stepBox.width);
  expect(Math.abs(results.y - stepBox.y)).toBeLessThan(4);
  expect(await overflow(page)).toBe(0);
  await expect(page.locator(".lab-switcher a")).toHaveCount(6);
  await expect(page.locator('.lab-switcher a[aria-current="page"]')).toHaveText(
    "05 Panel project",
  );
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
});
