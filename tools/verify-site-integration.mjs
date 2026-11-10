import { chromium, devices } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { LESSONS } from "../src/lessons.js";
import { replaceEditor } from "../tests/browser/editor-helpers.js";
const origin = process.env.SITE_TEST_ORIGIN || "http://127.0.0.1:4176";
const root = origin + "/learn/stata/";
const browser = await chromium.launch({ channel: "chrome" });
const receipt = {
  origin,
  checkedAt: new Date().toISOString(),
  base: "/learn/stata/",
  checks: [],
  payloadBasis:
    "HTTP response bodies from the tested origin; gzip sizes computed locally",
  payloads: [],
};
async function verifyPrefixes(page) {
  await replaceEditor(
    page,
    "capture noisily {\n  generate double prefix_started=1\n  confirm variable prefix_absent\n  generate double prefix_skipped=1\n}\nquietly regress score hours attendance\ndisplay _rc",
  );
  await page.locator("#run").click();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(
    await page.locator("#results").innerText(),
    /Execution continued/,
  );
  assert.match(await page.locator("#results").innerText(), /111/);
  await page.locator("#tab-history").click();
  assert.match(
    await page.locator("#command-history").innerText(),
    /Captured r\(111\)/,
  );
  assert.match(
    await page.locator("#command-history").innerText(),
    /Output suppressed/,
  );
  assert.equal(
    await page.locator('[data-variable="prefix_started"]').count(),
    1,
  );
  assert.equal(
    await page.locator('[data-variable="prefix_skipped"]').count(),
    0,
  );
  await page.reload();
  await page.locator("#run:not([disabled])").waitFor();
  await replaceEditor(page, "display _rc");
  await page.locator("#run").click();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(
    await page.locator("#results .result-card").first().innerText(),
    /111/,
  );
  for (let i = 0; i < 4; i++) await page.locator("#undo").click();
  assert.equal(
    await page.locator('[data-variable="prefix_started"]').count(),
    0,
  );
  assert.match(await page.locator("#dataset-count").innerText(), /5 variables/);
}
async function verifyBy(page) {
  await replaceEditor(
    page,
    "bysort group (id): generate double by_position = _n\nby group: generate double by_previous = hours[_n-1]\ngenerate by_initial = upper(substr(group, 1, 1))",
  );
  await page.locator("#run").click();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(await page.locator("#dataset-count").innerText(), /8 variables/);
  await replaceEditor(page, "by hours: generate double by_unsorted = 1");
  await page.locator("#run").click();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(await page.locator("#results").innerText(), /not sorted/);
  assert.equal(await page.locator('[data-variable="by_unsorted"]').count(), 0);
  await page.reload();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(await page.locator("#dataset-count").innerText(), /8 variables/);
  for (let i = 0; i < 3; i++) await page.locator("#undo").click();
  assert.match(await page.locator("#dataset-count").innerText(), /5 variables/);
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage(),
    errors = [],
    external = [];
  const releaseResponse = await context.request.get(root + "site-release.json");
  assert.ok(releaseResponse.ok(), "Integrated release receipt must be public");
  receipt.release = await releaseResponse.json();
  assert.equal(receipt.release.development, false);
  assert.equal(receipt.release.base, "/learn/stata/");
  if (process.env.SITE_TEST_COMMIT)
    assert.equal(receipt.release.commit, process.env.SITE_TEST_COMMIT);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== origin && !r.url().startsWith("data:"))
      external.push(r.url());
  });
  if (process.env.SITE_TEST_LEGACY === "1") {
    await page.goto(
      origin + "/STATAverse/Learn/?course=fall%202026#first-commands",
    );
    await page.waitForURL(root + "Learn/?course=fall%202026#first-commands");
    await page.locator("#command-editor").waitFor();
    await page.goto(
      origin +
        "/STATAverse/ScriptLibrary/script.html?id=regress&return=%2F#example",
    );
    await page.waitForURL(
      root + "ScriptLibrary/script.html?id=regress&return=%2F#example",
    );
    receipt.checks.push(
      "public legacy links preserve paths, encoded query strings and fragments at the canonical site",
    );
  }
  await page.goto(root);
  await page.locator("#preview-result svg").waitFor();
  await page.locator('[data-preview="regress"]').click();
  assert.match(await page.locator("#preview-result").innerText(), /22/);
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute("href"),
    "https://ihelfrich.github.io/learn/stata/",
  );
  await page.locator(".sv-site-menu summary").click();
  await fs.mkdir("docs/verification/screenshots", { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/verification/screenshots/site-integration-desktop.png",
    fullPage: false,
  });
  assert.equal(
    (await new AxeBuilder({ page }).include(".sv-site-nav").analyze())
      .violations.length,
    0,
  );
  await page.locator(".sv-site-menu summary").click();
  await page
    .getByRole("link", { name: "Start with your first command" })
    .click();
  await page.locator("#command-editor").waitFor();
  await page.locator("#insert-example").click();
  await page.locator("#run").click();
  await page.locator("#exercise-check.success").waitFor();
  await page
    .locator(
      `input[name="interpretation"][value="${LESSONS[0].steps[0].correct}"]`,
    )
    .check();
  await page.locator("#check-answer").click();
  await page.locator("#next-step:not([disabled])").waitFor();
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).scope,
  );
  assert.equal(scope, root);
  const practice = await page.evaluate(() =>
    localStorage.getItem("stataverse:practice:v2"),
  );
  assert.ok(practice);
  receipt.checks.push(
    "nested-path command execution, saved practice and scoped service worker",
  );
  await page
    .getByRole("link", { name: "Do-file builder", exact: true })
    .click();
  assert.equal(
    new URL(page.url()).pathname,
    "/learn/stata/ScriptLibrary/builder.html",
  );
  await page.locator("#project").fill("/Users/student/Course project");
  await page.locator('[data-stage="1"]').click();
  await page.locator("#file").fill("data/survey.dta");
  await page.locator("#format").selectOption("dta");
  await page.locator('[data-stage="3"]').click();
  await page.locator("#method").selectOption("ols");
  await page.locator("#outcome").fill("score");
  await page.locator("#predictors").fill("hours attendance");
  assert.equal(await page.locator("#download-do").isEnabled(), true);
  assert.match(
    await page.locator("#builder-code").inputValue(),
    /regress score hours attendance, vce\(robust\)/,
  );
  await page.reload();
  assert.match(
    await page.locator("#builder-code").inputValue(),
    /regress score hours attendance/,
  );
  assert.equal((await new AxeBuilder({ page }).analyze()).violations.length, 0);
  receipt.checks.push(
    "site navigation opens the guided do-file builder; generated code and saved plan work at the canonical subdirectory",
  );
  const factorContext = await browser.newContext();
  const factorPage = await factorContext.newPage();
  factorPage.on("pageerror", (error) => errors.push(error.message));
  await factorPage.goto(root + "Learn/");
  await factorPage.locator("#free-mode").click();
  await replaceEditor(factorPage, "reg hours attendance##score");
  await factorPage.locator("#run").click();
  await factorPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await factorPage.locator("#results").innerText(),
    /uses all available degrees of freedom/,
  );
  await replaceEditor(
    factorPage,
    "reg hours c.attendance##c.score, robust\npredict double fitted",
  );
  await factorPage.locator("#run").click();
  await factorPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await factorPage.locator("#dataset-count").innerText(),
    /6 variables/,
  );
  await factorPage.locator("#tab-results").click();
  const term = factorPage.locator('[data-coefficient="c.attendance#c.score"]');
  await term.click();
  assert.match(
    await factorPage
      .locator(`[data-annotation="${await term.getAttribute("data-result")}"]`)
      .innerText(),
    /attendance multiplied by score/,
  );
  await factorPage.reload();
  await factorPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await factorPage.locator("#dataset-count").innerText(),
    /6 variables/,
  );
  await factorPage.locator("#undo").click();
  assert.match(
    await factorPage.locator("#dataset-count").innerText(),
    /5 variables/,
  );
  receipt.checks.push(
    "reported categorical interaction and continuous interaction run at the public subdirectory; predictions, coefficient interpretation, reload and undo work",
  );
  await verifyPrefixes(factorPage);
  await verifyBy(factorPage);
  receipt.checks.push(
    "bysort, by, subscripts and string functions run at the canonical address; unsorted by stops with not sorted and changes nothing; reload replays and undo restores the data",
  );
  await replaceEditor(factorPage, "clear\ncount");
  const shortcutEditor = factorPage.locator("#command-editor");
  await shortcutEditor.press("ControlOrMeta+A");
  await shortcutEditor.press("ControlOrMeta+/");
  assert.equal(await shortcutEditor.innerText(), "// clear\n// count");
  await shortcutEditor.press("ControlOrMeta+z");
  assert.equal(await shortcutEditor.innerText(), "clear\ncount");
  await shortcutEditor.press("ControlOrMeta+Home");
  await shortcutEditor.press("ControlOrMeta+/");
  await shortcutEditor.press("ControlOrMeta+Shift+Enter");
  await factorPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await factorPage.locator("#dataset-count").innerText(),
    /24 observations/,
  );
  await factorPage.reload();
  await factorPage.locator("#run:not([disabled])").waitFor();
  assert.equal(await shortcutEditor.innerText(), "// clear\ncount");
  await factorPage.locator(".editor-shortcuts summary").click();
  assert.match(
    await factorPage.locator(".editor-shortcuts").innerText(),
    /Comment \/ uncomment/,
  );
  receipt.checks.push(
    "editor comment shortcut, text undo, run-all shortcut and saved commented draft work at the canonical address; shortcut reference is available",
  );
  await factorContext.close();
  receipt.checks.push(
    "capture/noisily blocks, quietly, confirm and _rc run through the worker at the canonical address; partial changes, skipped commands, History, reload and grouped undo agree",
  );
  const recoveryContext = await browser.newContext();
  await recoveryContext.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error("Worker unavailable in recovery verification");
      }
    };
  });
  const recoveryPage = await recoveryContext.newPage();
  recoveryPage.on("pageerror", (error) => errors.push(error.message));
  await recoveryPage.goto(root + "Learn/");
  await recoveryPage.locator("#free-mode").click();
  await replaceEditor(
    recoveryPage,
    "generate double recovery_check=hours+1\ncount",
  );
  await recoveryPage.locator("#run").click();
  await recoveryPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await recoveryPage.locator("#dataset-count").innerText(),
    /6 variables/,
  );
  await recoveryPage.reload();
  await recoveryPage.locator("#run:not([disabled])").waitFor();
  assert.match(
    await recoveryPage.locator("#dataset-count").innerText(),
    /6 variables/,
  );
  await recoveryPage.locator("#undo").click();
  await recoveryPage.locator("#undo").click();
  assert.match(
    await recoveryPage.locator("#dataset-count").innerText(),
    /5 variables/,
  );
  receipt.checks.push(
    "blocked workers recover locally at the integrated address; saved commands replay and undo retains the preceding dataset",
  );
  await verifyPrefixes(recoveryPage);
  await recoveryContext.close();
  receipt.checks.push(
    "capture/noisily blocks and _rc also survive blocked-worker fallback, saved replay and undo at the canonical address",
  );
  await page.goto(root + "Labs/Data/#investigation=matching-records");
  await page.locator("#investigation-number").fill("5");
  await page.locator("#investigation-number").press("Enter");
  await page.locator("#investigation-feedback.answer-passed").waitFor();
  await page.locator("#investigation-next:not([disabled])").waitFor();
  await page.goto(root + "Workspace/");
  assert.match(
    await page.locator("#lab-resume-links").innerText(),
    /Matching records: 1\/6/,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("stataverse:practice:v2")),
    practice,
  );
  receipt.checks.push(
    "investigation persistence and Workspace resume at integrated path",
  );
  const oldKey =
    "stataverse:progress:/STATAverse/ZeroToHero/modules/01-stata-foundations.html";
  await page.evaluate(
    ({ key }) =>
      localStorage.setItem(key, JSON.stringify({ checks: [true], notes: {} })),
    { key: oldKey },
  );
  await page.goto(root + "ZeroToHero/modules/01-stata-foundations.html");
  await page
    .locator('.lesson-content input[type="checkbox"]')
    .first()
    .waitFor();
  assert.ok(
    await page
      .locator('.lesson-content input[type="checkbox"]')
      .first()
      .isChecked(),
  );
  await page
    .locator('.lesson-content input[type="checkbox"]')
    .first()
    .uncheck();
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).checks[0],
      oldKey,
    ),
    false,
  );
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem(
        "stataverse:progress:/learn/stata/ZeroToHero/modules/01-stata-foundations.html",
      ),
    ),
    null,
  );
  receipt.checks.push(
    "existing project-path reading progress survives the new mount without a second copy",
  );
  await page.goto(root + "Labs/Inference/");
  await page.locator("#inference-repetitions").selectOption("50");
  await page.locator("#run-simulation").click();
  await page
    .getByText("Completed 50 samples. All three methods used the same draws.", {
      exact: true,
    })
    .waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.locator("#run-simulation").click();
  await page
    .getByText(
      "Completed 500 samples. All three methods used the same draws.",
      { exact: true },
    )
    .waitFor();
  await page.goto(root + "Learn/");
  await page.locator("#command-editor").waitFor();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector(".sv-site-nav")).display,
    ),
    "flex",
  );
  await page.goto(root + "Learn/#macros-loops");
  await page.locator("#insert-example").click();
  await page.locator("#run").click();
  await page.locator("#exercise-check.success").waitFor();
  assert.match(
    await page.locator("#exercise-check").innerText(),
    /expected result/,
  );
  await page.locator("#free-mode").click();
  const program =
    "local prefix browser\nforvalues p = 1/2 {\n generate double `prefix'`p' = hours^`p'\n}";
  await replaceEditor(page, program);
  await page.locator("#run").click();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(await page.locator("#dataset-count").innerText(), /7 variables/);
  await page.locator("#tab-results").click();
  assert.match(
    await page.locator("#results").innerText(),
    /generate double browser2 = hours\^2/,
  );
  await page.reload();
  await page.locator("#command-editor").waitFor();
  await page.locator("#run:not([disabled])").waitFor();
  assert.match(await page.locator("#dataset-count").innerText(), /7 variables/);
  assert.equal(await page.locator("#command-editor").innerText(), program);
  receipt.checks.push(
    "programming lesson, local substitution, integer loops and saved replay execute entirely offline at the canonical mount",
  );
  await context.setOffline(false);
  await page.goto(root + "Labs/IV/");
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute("href"),
    "https://ihelfrich.github.io/learn/stata/Labs/IV/",
  );
  await page.locator("#iv-scenario").selectOption("invalid");
  assert.match(await page.locator("#iv-assumptions").innerText(), /violated/);
  await page.locator("#iv-tab-uncertainty").click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/verification/screenshots/site-iv-desktop.png",
    fullPage: false,
  });
  await context.setOffline(true);
  await page.reload();
  await page.locator("#iv-guide-select").selectOption("iv-weak");
  await page.locator("#iv-guide-steps").selectOption("2");
  assert.equal(await page.locator("#iv-set").innerText(), "All real values");
  await page.locator('#iv-guide-inputs input[value="2"]').check();
  await page.locator("#iv-guide-check").click();
  await page.locator("#iv-guide-next:not([disabled])").waitFor();
  assert.match(
    await page.locator("#iv-guide-feedback").innerText(),
    /rejects no candidate/,
  );
  await page
    .locator("#iv-guide-note")
    .fill("This sample supplies no finite AR bound.");
  await page
    .getByText("Task, responses and settings saved on this device", {
      exact: true,
    })
    .waitFor();
  await page.reload();
  await page.locator("#iv-guide-next:not([disabled])").waitFor();
  assert.equal(
    await page.locator("#iv-guide-note").inputValue(),
    "This sample supplies no finite AR bound.",
  );
  assert.equal(
    await page.locator('#iv-guide-inputs input[value="2"]').isChecked(),
    true,
  );
  assert.equal(
    await page.locator('.sv-site-nav a[href="/teaching/"]').first().count(),
    1,
  );
  await context.setOffline(false);
  receipt.checks.push(
    "IV lab at the canonical nested route, shared navigation, checked weak-instrument investigation offline, and restored task response, experiment and note after reload",
  );
  await page.goto(root + "MethodLab/");
  for (const [name, value] of Object.entries({
    outcome: "binary",
    structure: "panel",
    design: "unresolved",
    dependence: "clustered",
  }))
    await page.locator(`#method-${name}`).selectOption(value);
  assert.equal(await page.locator("#method-cards article").count(), 3);
  assert.equal(
    await page.locator("#method-card-iv, #method-card-did").count(),
    0,
  );
  assert.match(
    await page.locator("#method-notices").innerText(),
    /causal interpretation is unresolved/,
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator("#method-card-panel").waitFor();
  assert.equal(await page.locator("#method-design").inputValue(), "unresolved");
  const comparisonDownload = page.waitForEvent("download");
  await page.locator("#method-download").click();
  const comparisonText = await fs.readFile(
    await (await comparisonDownload).path(),
    "utf8",
  );
  assert.match(comparisonText, /Strict exogeneity/);
  assert.match(comparisonText, /Limit:/);
  assert.ok(comparisonText.split("\n").length > 50);
  await context.setOffline(false);
  assert.equal((await new AxeBuilder({ page }).analyze()).violations.length, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/verification/screenshots/site-method-desktop.png",
    fullPage: false,
  });
  receipt.checks.push(
    "method comparison retains selected choices offline at a new query URL, exports its conditions and limitations, and does not infer a causal design from unresolved endogeneity",
  );
  await page.goto(root + "CodeLibrary/");
  await page.locator("#example-panel h2 a").click();
  await page.locator('#example-sections a[data-section="3"]').click();
  await page.locator("#example-native-table table").waitFor();
  assert.match(
    await page.locator("#example-source").innerText(),
    /estimates store hybrid/,
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator("#example-native-table table").waitFor();
  await page.locator('#example-options input[value="2"]').check();
  await page.locator("#example-check").click();
  await page.locator("#example-feedback.correct").waitFor();
  const sourceDownload = page.waitForEvent("download");
  await page.locator("#example-download").click();
  const downloadedSource = await fs.readFile(
    await (await sourceDownload).path(),
    "utf8",
  );
  assert.equal(
    downloadedSource,
    await fs.readFile("CodeLibrary/scripts/06_panel_data_toolkit.do", "utf8"),
  );
  await context.setOffline(false);
  await page.goto(root + "Search/");
  await page.locator("#site-search").fill("Within-between decomposition");
  await page
    .getByText("Panel example: Within-between decomposition", { exact: true })
    .click();
  await page.locator("#example-native-table table").waitFor();
  assert.equal(
    await page.locator("#example-section-title").innerText(),
    "Within-between decomposition",
  );
  assert.equal((await new AxeBuilder({ page }).analyze()).violations.length, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/verification/screenshots/site-worked-desktop.png",
    fullPage: false,
  });
  receipt.checks.push(
    "worked panel source and matching native estimates reopen offline, an interpretation check runs, the complete download preserves source bytes, and app search opens the specific section",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  receipt.checks.push(
    "offline practice and worker simulation, navigation CSS cached, no external runtime requests",
  );
  await page.goto(origin + "/teaching/");
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller),
    null,
  );
  await page
    .locator(".teaching-entry-materials")
    .getByRole("link", { name: "STATAverse", exact: true })
    .click();
  assert.equal(page.url(), root);
  await page.goto(origin + "/search/");
  const matches = await page.evaluate(async () => {
    const p = await import("/pagefind/pagefind.js");
    const r = await p.search("STATAverse");
    return Promise.all(
      r.results.slice(0, 20).map(async (x) => (await x.data()).url),
    );
  });
  const ivMatches = await page.evaluate(async () => {
    const p = await import("/pagefind/pagefind.js");
    const results = await p.search("instrumental variables");
    return Promise.all(
      results.results.slice(0, 30).map(async (item) => (await item.data()).url),
    );
  });
  assert.ok(
    ivMatches.some((url) => url.endsWith("/learn/stata/Labs/IV/")),
    "IV lab is discoverable in the site-wide search",
  );
  const methodMatches = await page.evaluate(async () => {
    const p = await import("/pagefind/pagefind.js");
    const results = await p.search("method comparison");
    return Promise.all(
      results.results.slice(0, 30).map(async (item) => (await item.data()).url),
    );
  });
  assert.ok(
    methodMatches.some((url) => url.endsWith("/learn/stata/MethodLab/")),
    "Method comparison is discoverable in site-wide search",
  );
  const workedMatches = await page.evaluate(async () => {
    const p = await import("/pagefind/pagefind.js");
    const results = await p.search("Panel-data comparisons");
    return Promise.all(
      results.results.slice(0, 30).map(async (item) => (await item.data()).url),
    );
  });
  assert.ok(
    workedMatches.some((url) => url.includes("/learn/stata/CodeLibrary/")),
    "Worked examples are discoverable in site-wide search",
  );
  const sitemap = await (
    await context.request.get(origin + "/sitemap.xml")
  ).text();
  assert.ok(
    sitemap.includes("https://ihelfrich.github.io/learn/stata/Labs/IV/"),
    "IV lab appears in the site sitemap",
  );
  assert.ok(
    matches.some((url) => url.includes("/learn/stata/")),
    JSON.stringify(matches),
  );
  receipt.checks.push(
    "Teaching entry, site search indexing and no worker control outside STATAverse",
  );
  const phone = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const mobile = await phone.newPage();
  await mobile.goto(root + "Learn/");
  await mobile.locator("#command-editor").waitFor();
  await mobile.locator(".sv-site-menu summary").focus();
  await mobile.keyboard.press("Enter");
  assert.ok(
    (await mobile.locator(".sv-site-menu").getAttribute("open")) !== null,
  );
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.equal(
    (await new AxeBuilder({ page: mobile }).include(".sv-site-nav").analyze())
      .violations.length,
    0,
  );
  await mobile.evaluate(() => document.fonts.ready);
  await mobile.screenshot({
    path: "docs/verification/screenshots/site-integration-mobile.png",
    fullPage: false,
  });
  await mobile.goto(root + "Labs/IV/");
  await mobile.locator("#iv-tab-uncertainty").click();
  await mobile.locator(".iv-confidence-summary").scrollIntoViewIfNeeded();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.equal(
    (await new AxeBuilder({ page: mobile }).analyze()).violations.length,
    0,
  );
  await mobile.evaluate(() => document.fonts.ready);
  await mobile.screenshot({
    path: "docs/verification/screenshots/site-iv-mobile.png",
    fullPage: false,
  });
  const plain = await browser.newContext({ javaScriptEnabled: false });
  const noJs = await plain.newPage();
  await noJs.goto(root);
  await noJs.locator(".sv-site-menu summary").click();
  assert.ok(
    await noJs.locator('.sv-site-menu a[href="/teaching/"]').isVisible(),
  );
  receipt.checks.push(
    "mobile width, keyboard/native navigation, targeted accessibility and no-script site links",
  );
  const measuredAssets = new Map();
  for (const name of [
    "home",
    "learn",
    "practice-worker",
    "do-builder",
    "workspace",
    "data-lab",
    "inference-lab",
    "inference-worker",
    "iv-lab",
    "iv-investigation-ui",
    "method-lab",
    "worked-reader",
  ]) {
    const assetPath = "assets/js/" + name + ".js";
    const response = await context.request.get(root + assetPath);
    assert.ok(response.ok(), assetPath);
    const b = await response.body();
    measuredAssets.set(assetPath, b);
    receipt.payloads.push({
      asset: name + ".js",
      bytes: b.length,
      gzipBytes: gzipSync(b).length,
    });
  }
  assert.ok(
    receipt.payloads.find((x) => x.asset === "home.js").gzipBytes < 5000,
  );
  assert.ok(
    receipt.payloads.find((x) => x.asset === "method-lab.js").gzipBytes < 14000,
  );
  assert.ok(
    receipt.payloads.find((x) => x.asset === "worked-reader.js").gzipBytes <
      16000,
  );
  const workerText = await (
    await context.request.get(root + "service-worker.js")
  ).text();
  const precacheFiles = [
    ...workerText
      .match(/const CORE_ASSETS = \[([\s\S]*?)\];/)[1]
      .matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  receipt.coreOfflinePackage = {
    files: precacheFiles.length,
    bytes: 0,
    gzipBytes: 0,
  };
  for (const file of precacheFiles) {
    let bytes = measuredAssets.get(file);
    if (!bytes) {
      const response = await context.request.get(root + file);
      assert.ok(response.ok(), file);
      bytes = await response.body();
    }
    receipt.coreOfflinePackage.bytes += bytes.length;
    receipt.coreOfflinePackage.gzipBytes += gzipSync(bytes).length;
  }
  assert.ok(receipt.coreOfflinePackage.gzipBytes < 600000);
  await fs.writeFile(
    process.env.SITE_TEST_RECEIPT || "docs/verification/site-integration.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
}
