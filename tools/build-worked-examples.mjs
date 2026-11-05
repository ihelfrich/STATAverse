import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { WORKED_EXAMPLES, splitDoFile } from "../src/worked-examples.js";
import { escapeHTML as h } from "../src/render.js";
import { format } from "prettier";
export async function buildWorkedExamples() {
  const hashes = {};
  for (const example of WORKED_EXAMPLES) {
    const bytes = await fs.readFile("CodeLibrary/scripts/" + example.file);
    const sections = splitDoFile(bytes.toString("utf8"), example);
    if (example.guides && example.guides.length !== sections.length)
      throw new Error("Guide sections do not match " + example.id);
    hashes[example.id] = createHash("sha256").update(bytes).digest("hex");
  }
  const panel = JSON.parse(
    await fs.readFile("assets/data/panel-output.json", "utf8"),
  );
  if (panel.sourceSha256 !== hashes.panel)
    throw new Error(
      "Regenerate and verify the native panel output before building a changed panel script.",
    );
  await fs.writeFile(
    "src/worked-example-hashes.js",
    await format(
      "// Generated from the downloadable source bytes by tools/build-worked-examples.mjs.\nexport const WORKED_EXAMPLE_HASHES = " +
        JSON.stringify(hashes) +
        ";\n",
      { parser: "babel" },
    ),
  );
  const rows = WORKED_EXAMPLES.map(
    (example, i) =>
      `<article class="example-list-row" id="example-${example.id}"><span class="example-order" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div><p class="eyebrow">${h(example.level)}</p><h2><a href="?example=${example.id}">${h(example.title)}</a></h2><p>${h(example.summary)}</p></div><div class="example-list-actions"><a href="?example=${example.id}">Read example →</a><a href="scripts/${example.file}" download>Download .do</a></div></article>`,
  ).join("\n");
  const file = "CodeLibrary/index.html",
    html = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    await format(
      html.replace(
        /<!-- WORKED-EXAMPLES:START -->[\s\S]*?<!-- WORKED-EXAMPLES:END -->/,
        "<!-- WORKED-EXAMPLES:START -->\n" +
          rows +
          "\n<!-- WORKED-EXAMPLES:END -->",
      ),
      { parser: "html" },
    ),
  );
}
