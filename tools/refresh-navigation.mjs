import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const walk = async (dir) => {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "test-results", "playwright-report"].includes(
        e.name,
      )
    )
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
};
for (const file of await walk(root)) {
  let html = await fs.readFile(file, "utf8");
  if (!html.includes('class="nav"')) continue;
  const base = (path.relative(path.dirname(file), root) || ".")
    .split(path.sep)
    .join("/");
  const links = [
    ["Learn/", "Practice"],
    ["ZeroToHero/", "Applied lessons"],
    ["ScriptLibrary/", "Scripts"],
    ["Glossary/", "Concepts"],
    ["Search/", "Search"],
    ["index.html#reference-title", "All resources"],
  ];
  const nav = `<nav class="nav" aria-label="Main navigation"><a class="brand" href="${base}/index.html">STATAverse</a><div class="nav-links">${links.map(([href, title]) => `<a href="${base}/${href}">${title}</a>`).join("")}</div></nav>`;
  html = html.replace(/<nav class="nav"[^>]*>[\s\S]*?<\/nav>/, nav);
  if (!html.includes('class="skip-link"'))
    html = html
      .replace(
        /(<body[^>]*>)/,
        '$1\n    <a class="skip-link" href="#main">Skip to content</a>',
      )
      .replace("<main>", '<main id="main">');
  await fs.writeFile(file, html);
}
