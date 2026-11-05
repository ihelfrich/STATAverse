import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const base = process.env.BASE_PATH || "/";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
http
  .createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (!pathname.startsWith(base)) {
        res.writeHead(404).end("Page not found");
        return;
      }
      pathname = "/" + pathname.slice(base.length);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.resolve(root, "." + pathname);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await fs.readFile(file);
      res
        .writeHead(200, {
          "Content-Type":
            mime[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store",
          ...(process.env.TEST_VARY_ORIGIN === "1" ? { Vary: "Origin" } : {}),
        })
        .end(data);
    } catch {
      res
        .writeHead(404, { "Content-Type": "text/plain" })
        .end("Page not found");
    }
  })
  .listen(Number(process.env.PORT || 4173), "127.0.0.1", () =>
    console.log(
      "STATAverse: http://127.0.0.1:" + (process.env.PORT || 4173) + base,
    ),
  );
