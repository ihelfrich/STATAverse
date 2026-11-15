import { test, expect } from "@playwright/test";

// Problems found in the re-check after release 492e426.

async function ready(page) {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
}
const commands = (page) =>
  page.locator("#console-output .console-record .console-command");

test("commands typed while one runs wait their turn and none is lost", async ({
  page,
}) => {
  await ready(page);
  const line = page.locator("#console-command");
  await line.fill("sysuse study, clear");
  await line.press("Enter");
  // Typed straight after Enter, as a quick typist does, while the first
  // command is still running.
  await line.pressSequentially("summarize nosuch");
  await line.press("Enter");
  await line.pressSequentially("count");
  await line.press("Enter");
  await expect(commands(page)).toHaveText([
    ". sysuse study, clear",
    ". summarize nosuch",
    ". count",
  ]);
  await expect(line).toBeFocused();
  await expect(line).toHaveValue("");
});

test("Stop drops the commands waiting behind the run", async ({ page }) => {
  await ready(page);
  const line = page.locator("#console-command");
  await page
    .locator("#console-source")
    .fill(
      "clear\nset obs 200000\ngenerate id = _n\nforvalues i = 1/3000 {\n  generate double v`i' = sqrt(_n) * `i'\n}",
    );
  await page.locator("#console-run").click();
  const stop = page.locator("#console-stop");
  await expect(stop).toBeVisible();
  await line.fill('display "after"');
  await line.press("Enter");
  await expect(page.locator("#console-status")).toContainText(
    "runs when this run ends",
  );
  await expect(page.locator("#console-progress-text")).toContainText(
    /line [45] of 6/,
    { timeout: 20000 },
  );
  await stop.click();
  await expect(page.locator("#console-status")).toContainText(
    "Stopped on line",
    {
      timeout: 30000,
    },
  );
  await page.locator("#console-source").fill("display 6 * 7");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-output")).toContainText("42");
  await expect(page.locator("#console-output")).not.toContainText(
    '. display "after"',
  );
});

// ----- the console group's findings -----

async function type(page, command) {
  const line = page.locator("#console-command");
  await expect(line).toBeEnabled();
  await line.fill(command);
  await line.press("Enter");
  await expect(page.locator("#console-status")).not.toHaveText("Running…");
}
async function menu(page) {
  const more = page.locator("#console-more");
  if ((await more.getAttribute("open")) === null)
    await more.locator("summary").click();
}
const csv = (name, text) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});

test("F14: a long error message is broken at the linesize as Stata breaks it", async ({
  page,
}) => {
  await ready(page);
  // Stata 19 at linesize 40: use prints a paragraph whose later lines are
  // indented by four, append a line cut after "> ".
  await type(page, "set linesize 40");
  await type(page, "capture noisily use nosuchfile_long_name_here.dta, clear");
  await expect(
    page
      .locator("#console-output .console-record")
      .last()
      .locator(".console-error"),
  ).toHaveText("file nosuchfile_long_name_here.dta not\n    found\n");
  await type(
    page,
    "capture noisily append using nosuchfile_long_name_here.dta",
  );
  await expect(
    page
      .locator("#console-output .console-record")
      .last()
      .locator(".console-error"),
  ).toHaveText("file nosuchfile_long_name_here.dta not f\n> ound\n");
  await type(page, "use nosuchfile_long_name_here.dta, clear");
  await expect(
    page
      .locator("#console-output .console-record")
      .last()
      .locator(".console-error"),
  ).toHaveText("file nosuchfile_long_name_here.dta not\n    found\nr(601);\n");
});

test("F154: a new graph is scrolled into view with its height", async ({
  page,
}) => {
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "summarize hours score");
  await type(page, "regress score hours");
  await type(page, "scatter score hours");
  const graph = page.locator("#console-output .console-graph").last();
  await expect(graph).toBeVisible();
  // The image has its height before it is decoded, and the newest record
  // (command and graph) fits in Results, so all of it is in view.
  const { top, bottom, paneTop, paneBottom } = await graph.evaluate((img) => {
    const r = img.getBoundingClientRect(),
      pane = document.getElementById("console-output").getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      paneTop: pane.top,
      paneBottom: pane.bottom,
    };
  });
  expect(top).toBeGreaterThanOrEqual(paneTop - 1);
  expect(bottom).toBeLessThanOrEqual(paneBottom + 1);
  expect(await graph.getAttribute("height")).toBe("460");
});

test("F155: a 79-column table fits in Results at 1280 pixels", async ({
  page,
}, info) => {
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "regress score hours attendance");
  const fit = await page.locator("#console-output").evaluate((out) => ({
    client: out.clientWidth,
    scroll: out.scrollWidth,
    size: getComputedStyle(out).fontSize,
  }));
  if (info.project.name === "desktop") {
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(parseFloat(fit.size)).toBeGreaterThanOrEqual(10.5);
  } else {
    // A phone keeps readable text and scrolls the table sideways.
    expect(fit.size).toBe("12px");
  }
  // The page itself never scrolls sideways.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("F156: of files added together, the first is loaded and named", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-file")
    .setInputFiles([
      csv("first.csv", "a,b\n1,2\n3,4\n"),
      csv("second.csv", "c\n5\n6\n7\n"),
    ]);
  await expect(page.locator("#console-status")).toContainText(
    "first.csv is in memory now",
  );
  await expect(page.locator("#console-memory")).toContainText(
    "2 observations, 2 variables",
  );
});

test("F161: Insert a command names the file the student added", async ({
  page,
}) => {
  await ready(page);
  const source = page.locator("#console-source");
  await source.fill("");
  await page
    .locator("#console-file")
    .setInputFiles(csv("grades.csv", "x\n1\n"));
  await expect(page.locator("#console-status")).toContainText("grades.csv");
  await menu(page);
  await page.locator("#console-insert").selectOption({
    label:
      'Read a CSV file you added: import delimited using "myfile.csv", clear',
  });
  await expect(source).toHaveValue(
    'import delimited using "grades.csv", clear\n',
  );
  // With no .dta added, the placeholder is selected to be typed over.
  await menu(page);
  await page.locator("#console-insert").selectOption({
    label: 'Open a .dta file you added: use "myfile.dta", clear',
  });
  expect(
    await source.evaluate((box) =>
      box.value.slice(box.selectionStart, box.selectionEnd),
    ),
  ).toBe("myfile.dta");
});

test("F162 and F163: Ctrl+Enter runs the command; Up keeps the draft", async ({
  page,
}) => {
  await ready(page);
  const line = page.locator("#console-command");
  await line.fill("display 2+2");
  await line.press("ControlOrMeta+Enter");
  await expect(commands(page).last()).toHaveText(". display 2+2");
  await expect(line).toHaveValue("");
  await type(page, "display 3");
  await line.fill("list in 1/2");
  await line.press("ArrowUp");
  await expect(line).toHaveValue("display 3");
  await line.press("ArrowUp");
  await expect(line).toHaveValue("display 2+2");
  await line.press("ArrowDown");
  await line.press("ArrowDown");
  await expect(line).toHaveValue("list in 1/2");
});

test("F164: one failed command has no commands before it", async ({ page }) => {
  await ready(page);
  await type(page, "summarize wagez");
  await expect(page.locator("#console-status")).toHaveText(
    /^Stopped at an error, return code 111\.$/,
  );
  await page
    .locator("#console-source")
    .fill("sysuse study, clear\nsummarize wagez\n");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toContainText(
    "Stopped at an error, return code 111. Commands before it took effect.",
  );
});

test("F165: by() panels keep their text readable", async ({ page }) => {
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "scatter score hours, by(group)");
  const sizes = await page
    .locator("#console-output .console-graph")
    .last()
    .evaluate((img) => {
      const svg = decodeURIComponent(img.src.split(",")[1]),
        panels = [
          ...svg.matchAll(
            /<svg x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+" xmlns="[^"]+" viewBox="0 0 ([\d.]+) [\d.]+"/g,
          ),
        ];
      return panels.map((m) => Number(m[1]) / Number(m[2]));
    });
  expect(sizes.length).toBeGreaterThan(1);
  // A panel's 12-point text is drawn at least at 0.7 of the graph's.
  for (const shrink of sizes) expect(shrink).toBeGreaterThanOrEqual(0.7);
});

test("F166: nothing is drawn over the bottom of the Results window", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#console-command").scrollIntoViewIfNeeded();
  const cover = await page.evaluate(() => {
    const drawers = document.querySelector(".console-drawers"),
      window = document
        .querySelector(".console-window")
        .getBoundingClientRect(),
      style = getComputedStyle(drawers);
    return {
      shadow: style.boxShadow,
      gap: drawers.getBoundingClientRect().top - window.bottom,
    };
  });
  expect(cover.shadow).toBe("none");
  expect(cover.gap).toBeGreaterThanOrEqual(0);
});

test("F167: the page declares an icon and logs no errors", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await ready(page);
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

// ----- the second look at the console group's fixes -----

const lastError = (page) =>
  page
    .locator("#console-output .console-record")
    .last()
    .locator(".console-error");

test("F14: merge's message on keys that are not unique is a paragraph", async ({
  page,
}) => {
  await ready(page);
  // Stata 19 at linesize 40: {p 0 4 2}.
  await type(page, "set linesize 40");
  await type(page, "clear");
  await type(page, "set obs 4");
  await type(page, "generate id = ceil(_n/2)");
  await type(page, "save twice");
  await type(page, "capture noisily merge 1:1 id using twice");
  await expect(lastError(page)).toHaveText(
    "variable id does not uniquely identify\n    observations in the master data\n",
  );
});

test("F14: the error that stops a do-file run by do is red and broken as Stata breaks it", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      "clear\ncapture noisily append using nosuchfile_long_name_here.dta\nuse nosuchfile_long_name_here.dta\n",
    );
  await type(page, "set linesize 40");
  await type(page, "do main.do");
  const errors = page
    .locator("#console-output .console-record")
    .filter({ hasText: ". use nosuchfile_long_name_here.dta" })
    .locator(".console-error");
  await expect(errors).toHaveText([
    "file nosuchfile_long_name_here.dta not\n    found\nr(601);\n",
    "r(601);\n",
  ]);
  await expect(
    page
      .locator("#console-output .console-record")
      .filter({ hasText: ". use nosuchfile_long_name_here.dta" }),
  ).toContainText("end of do-file");
});

test("F155: 79 columns fit in Results at every desktop width, and the text never shrinks as the window grows", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await ready(page);
  await type(page, "sysuse study, clear");
  await type(page, "regress score hours attendance");
  let size = 0;
  for (const width of [
    901, 920, 950, 1000, 1100, 1240, 1241, 1300, 1420, 1421, 1600,
  ]) {
    await page.setViewportSize({ width, height: 900 });
    const fit = await page.locator("#console-output").evaluate((out) => ({
      client: out.clientWidth,
      scroll: out.scrollWidth,
      size: parseFloat(getComputedStyle(out).fontSize),
    }));
    expect(fit.scroll, `${width}px`).toBeLessThanOrEqual(fit.client);
    expect(fit.size, `${width}px`).toBeGreaterThanOrEqual(10.5);
    expect(fit.size, `${width}px`).toBeGreaterThanOrEqual(size);
    size = fit.size;
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("F161: a file added again is the last added; Insert keeps the line it is in whole", async ({
  page,
}) => {
  await ready(page);
  page.on("dialog", (dialog) => dialog.accept());
  const source = page.locator("#console-source");
  for (const name of ["first.csv", "second.csv", "first.csv"]) {
    await page.locator("#console-file").setInputFiles(csv(name, "x\n1\n"));
    await expect(page.locator("#console-status")).toContainText(
      `Added ${name}`,
    );
  }
  await source.fill("sysuse study, clear\nsummarize\n");
  // The cursor inside "sysuse": the line stays whole, the command goes
  // under it.
  await source.evaluate((box) => box.setSelectionRange(5, 5));
  await menu(page);
  await page.locator("#console-insert").selectOption({
    label:
      'Read a CSV file you added: import delimited using "myfile.csv", clear',
  });
  await expect(source).toHaveValue(
    'sysuse study, clear\nimport delimited using "first.csv", clear\nsummarize\n',
  );
  await expect(page.locator("#console-status")).toContainText(
    "for first.csv, the last text file you added",
  );
});

test("F164: a typed loop that fails after a command in it took effect says so", async ({
  page,
}) => {
  await ready(page);
  await type(page, "sysuse study, clear");
  // The block is typed a line at a time, as in Stata's Command window.
  for (const line of [
    "forvalues i = 1/3 {",
    "generate v`i' = `i'",
    "generate v1 = 0",
    "}",
  ])
    await type(page, line);
  await expect(page.locator("#console-status")).toHaveText(
    "Stopped at an error, return code 110. Commands before it took effect.",
  );
  for (const line of ["forvalues i = 1/3 {", "summarize nosuch", "}"])
    await type(page, line);
  await expect(page.locator("#console-status")).toHaveText(
    /^Stopped at an error, return code 111\.$/,
  );
});
