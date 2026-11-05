import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  problems = [];
const walk = async (dir) => {
  const files = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "test-results", "playwright-report"].includes(
        e.name,
      )
    )
      continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(file)));
    else if (/\.html$/.test(file) || /\/content\/.*\.md$/.test(file))
      files.push(file);
  }
  return files;
};
function baseFor(file) {
  const relative = path.relative(root, file);
  if (file.endsWith(".html")) return path.dirname(file);
  const parts = relative.split(path.sep),
    section = parts[0],
    name = path.basename(file, ".md");
  if (section === "ZeroToHero") {
    const folder = /^0\d-/.test(name)
      ? "modules"
      : /^project-/.test(name)
        ? "projects"
        : "datasets";
    return path.join(root, section, folder);
  }
  if (section === "STATAForBusiness")
    return path.join(root, section, "modules");
  return path.join(root, section);
}
let checked = 0;
for (const file of await walk(root)) {
  const text = await fs.readFile(file, "utf8");
  const refs = [
    ...text.matchAll(
      /(?:href|src|data-md|data-csv|data-csv-preview)="([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  if (file.endsWith(".md"))
    refs.push(
      ...[...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map((m) => m[1]),
    );
  for (let ref of refs) {
    if (/^(?:https?:|mailto:|data:|#|javascript:)/.test(ref)) continue;
    ref = ref.split(/[?#]/)[0];
    if (!ref) continue;
    const target = path.resolve(baseFor(file), decodeURIComponent(ref));
    checked++;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) await fs.access(path.join(target, "index.html"));
    } catch {
      problems.push({ source: path.relative(root, file), reference: ref });
    }
  }
}
console.log(
  JSON.stringify({ checked, broken: problems.length, problems }, null, 2),
);
if (problems.length) process.exitCode = 1;
