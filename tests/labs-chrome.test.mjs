import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) =>
  fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
const LABS = [
  ["Regression", "01 Regression & adjustment"],
  ["Inference", "02 Uncertainty & repeated samples"],
  ["Data", "03 Merge & reshape"],
  ["IV", "04 Instrumental variables"],
  ["Project", "05 Panel project"],
];
const text = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const links = (html) =>
  [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a\s*>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1],
    current: /aria-current="page"/.test(m[1]),
    rel: /rel="([^"]*)"/.exec(m[1])?.[1],
    text: text(m[2]),
  }));
const block = (html, open) => {
  const start = html.indexOf(open);
  assert.notEqual(start, -1, "missing " + open);
  const tag = /^<(\w+)/.exec(open)[1];
  return html.slice(start, html.indexOf(`</${tag}>`, start));
};

test("every lab carries the same switcher, with its own entry current", () => {
  for (const [dir, label] of LABS) {
    const html = read(`Labs/${dir}/index.html`);
    assert.equal(html.split('class="lab-switcher"').length, 2, dir);
    const found = links(block(html, '<nav class="lab-switcher"'));
    assert.deepEqual(
      found.map((link) => [link.href, link.text]),
      [["../", "All labs"], ...LABS.map(([d, l]) => [`../${d}/`, l])],
      dir,
    );
    assert.deepEqual(
      found.filter((link) => link.current).map((link) => link.text),
      [label],
      dir,
    );
    // The switcher opens the page; it is not nested in the heading.
    assert.match(
      html,
      /<main[^>]*class="lab-(layout|page)[^"]*"[^>]*>\s*<nav class="lab-switcher"/,
      dir,
    );
  }
});

test("every lab ends with the shared footer and has the shortcut bar", () => {
  LABS.forEach(([dir], index) => {
    const html = read(`Labs/${dir}/index.html`);
    const found = links(block(html, '<footer class="lab-footer"'));
    const previous = LABS[index - 1],
      next = LABS[index + 1];
    assert.deepEqual(
      found.map((link) => [link.rel ?? "", link.href, link.text]),
      [
        ...(previous
          ? [["prev", `../${previous[0]}/`, "Previous lab" + previous[1]]]
          : []),
        ["", "../", "OverviewAll analysis labs"],
        ...(next ? [["next", `../${next[0]}/`, "Next lab" + next[1]]] : []),
      ],
      dir,
    );
    assert.match(html, /<nav\s+class="lab-mobile-nav[ "]/, dir);
    assert.match(html, /class="lab-tabs[ "]/, dir);
    assert.match(html, /<body class="lab-app[ "]/, dir);
  });
});

test("the hub lists the five labs in order and each target exists", () => {
  const html = read("Labs/index.html");
  const cards = html.split('<li class="lab-card">').slice(1);
  assert.equal(cards.length, 5);
  cards.forEach((card, index) => {
    const [dir] = LABS[index];
    const title = links(block(card, "<h2"))[0];
    assert.equal(title.href, dir + "/");
    assert.ok(
      fs.existsSync(new URL(`../Labs/${dir}/index.html`, import.meta.url)),
    );
    assert.ok(card.includes(String(index + 1).padStart(2, "0")));
    for (const term of [
      "You work with",
      "Time",
      "Before you start",
      "In Stata",
    ])
      assert.ok(card.includes(`<dt>${term}</dt>`), `${dir}: ${term}`);
  });
  assert.doesNotMatch(html, /<script type="module"/);
});

test("lab stylesheets share the breakpoints and leave the chrome to labs.css", () => {
  const allowed = {
    "labs.css": ["600", "850", "1180", "1600"],
    "inference.css": ["600", "850", "1180"],
    "data-lab.css": ["850", "1180"],
    "iv.css": ["850", "1180"],
    // 1020px is where 80-column Stata output no longer fits beside the step.
    "project-lab.css": ["600", "850", "1020", "1180"],
  };
  for (const [file, widths] of Object.entries(allowed)) {
    const css = read("assets/css/" + file);
    const used = [
      ...new Set(
        [...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map(
          (m) => m[1],
        ),
      ),
    ].sort((a, b) => a - b);
    assert.deepEqual(used, widths, file);
    if (file === "labs.css") continue;
    assert.deepEqual(
      css.match(
        /\.lab-switcher|\.app-header|-mobile-nav\s*\{|\.(inference|iv)-tabs\s*(button)?\s*\{|\.lab-heading\s*\{/g,
      ),
      null,
      file,
    );
  }
});
