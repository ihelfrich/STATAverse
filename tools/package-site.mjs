import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Only student-facing files enter the website. Source, tests, native logs,
// screenshots, local work and dependency trees never enter this package.
export const SITE_ROOTS = [
  "index.html",
  "service-worker.js",
  "assets",
  "Learn",
  "Labs",
  "Workspace",
  "CodeLibrary",
  "Console",
  "Glossary",
  "MethodLab",
  "Readings",
  "RealData",
  "STATAForBusiness",
  "ScriptLibrary",
  "Search",
  "Topics",
  "ZeroToHero",
];
const EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".json",
  ".csv",
  ".tsv",
  ".do",
  ".md",
  ".txt",
  ".png",
  ".svg",
  ".jpg",
  ".webp",
  ".woff2",
  ".woff",
  ".ttf",
  ".zip",
]);
export async function packageSite(root, destination) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  if (destination === root || root.startsWith(destination + path.sep))
    throw new Error(
      "Package destination cannot contain the source repository.",
    );
  // Refuse to erase arbitrary folders. Build output has one fixed destination.
  if (destination !== path.join(root, "dist"))
    throw new Error(
      "Package destination must be the repository's dist directory.",
    );
  const files = [];
  async function collect(relative) {
    const info = await fs.lstat(path.join(root, relative));
    if (info.isSymbolicLink())
      throw new Error(`Symlink cannot enter the package: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
        if (!name.startsWith(".")) await collect(path.join(relative, name));
      }
    } else if (
      EXTENSIONS.has(path.extname(relative)) ||
      path.basename(relative) === "LICENSE"
    )
      files.push(relative);
  }
  for (const name of SITE_ROOTS) await collect(name);
  await fs.rm(destination, { recursive: true, force: true });
  const manifest = [];
  for (const relative of files.sort()) {
    let bytes = await fs.readFile(path.join(root, relative));
    if (relative.endsWith(".js"))
      bytes = Buffer.from(
        bytes.toString().replace(/\n?\/\/# sourceMappingURL=.*(?:\n|$)/g, "\n"),
      );
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    manifest.push({
      path: relative.split(path.sep).join("/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty = Boolean(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  );
  const result = { version: 1, sourceCommit, dirty, files: manifest };
  await fs.writeFile(
    path.join(destination, "site-package.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const result = await packageSite(process.cwd(), path.resolve("dist"));
  console.log(
    JSON.stringify({
      sourceCommit: result.sourceCommit,
      dirty: result.dirty,
      files: result.files.length,
      bytes: result.files.reduce((n, f) => n + f.bytes, 0),
    }),
  );
}
