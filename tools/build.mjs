import { build } from "esbuild";
import fs from "node:fs/promises";
import { LESSONS } from "../src/lessons.js";
const home = await fs.readFile("index.html", "utf8");
await fs.writeFile(
  "index.html",
  home
    .replace(/(data-curriculum="lessons">)\d+/, `$1${LESSONS.length}`)
    .replace(
      /(data-curriculum="steps">)\d+/,
      `$1${LESSONS.reduce((n, lesson) => n + lesson.steps.length, 0)}`,
    ),
);
await build({
  entryPoints: [
    "src/learn.js",
    "src/home.js",
    "src/workspace.js",
    "src/regression-lab.js",
  ],
  bundle: true,
  minify: true,
  format: "esm",
  outdir: "assets/js",
  sourcemap: true,
  target: ["es2022"],
  legalComments: "linked",
});
await build({
  entryPoints: ["src/legacy-vendor.js"],
  bundle: true,
  format: "iife",
  outfile: "assets/js/legacy-vendor.js",
  minify: true,
  target: ["es2022"],
  legalComments: "linked",
});
await fs.mkdir("assets/vendor/katex", { recursive: true });
await fs.copyFile(
  "node_modules/katex/dist/katex.min.css",
  "assets/vendor/katex/katex.min.css",
);
await fs.cp("node_modules/katex/dist/fonts", "assets/vendor/katex/fonts", {
  recursive: true,
});
await fs.copyFile("node_modules/katex/LICENSE", "assets/vendor/katex/LICENSE");
await fs.copyFile(
  "node_modules/marked/LICENSE",
  "assets/vendor/marked-LICENSE.md",
);
await fs.mkdir("assets/vendor/licenses", { recursive: true });
for (const name of [
  "fflate",
  "jstat",
  "ml-matrix",
  "ml-array-rescale",
  "ml-array-max",
  "ml-array-min",
  "is-any-array",
  "chart.js",
  "@kurkle/color",
  "@codemirror/view",
  "@codemirror/state",
  "@codemirror/language",
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/search",
  "@lezer/common",
  "@lezer/lr",
  "@lezer/highlight",
  "crelt",
  "style-mod",
  "w3c-keyname",
]) {
  const folder = `node_modules/${name}`;
  const files = await fs.readdir(folder);
  const license = files.find((file) =>
    /^licen[sc]e(?:\.md|\.txt)?$/i.test(file),
  );
  if (!license) throw new Error(`Missing third-party license: ${name}`);
  await fs.copyFile(
    `${folder}/${license}`,
    `assets/vendor/licenses/${name.replaceAll("/", "-")}.txt`,
  );
}
await fs.copyFile(
  "node_modules/chart.js/dist/chart.umd.min.js",
  "assets/vendor/chart.umd.min.js",
);
await fs.writeFile(
  "assets/data/practice-lessons.json",
  JSON.stringify(
    LESSONS.map((l) => ({
      id: l.id,
      title: l.title,
      summary: l.summary,
      level: l.level,
      minutes: l.minutes,
      steps: l.steps.length,
    })),
    null,
    2,
  ) + "\n",
);
