import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.join(__dirname, "site");
const port = Number(process.env.PORT || 4180);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

function sanitize(urlPath) {
  const pathname = decodeURIComponent((urlPath || "/").split("?")[0]);
  const normalized = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized.startsWith(path.sep) ? normalized.slice(1) : normalized;
}

async function readFileIfPresent(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    return null;
  }

  return {
    body: await fs.readFile(filePath),
    filePath
  };
}

async function resolveRequestPath(requestPath) {
  const clean = sanitize(requestPath);
  const candidates = [];

  if (!clean) {
    candidates.push("index.html");
  } else {
    candidates.push(clean);
    candidates.push(`${clean}.html`);
    candidates.push(path.join(clean, "index.html"));
  }

  for (const candidate of candidates) {
    const resolved = await readFileIfPresent(path.join(siteRoot, candidate));
    if (resolved) {
      return resolved;
    }
  }

  return readFileIfPresent(path.join(siteRoot, "index.html"));
}

const server = createServer(async (req, res) => {
  const resolved = await resolveRequestPath(req.url);

  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("site/index.html was not found");
    return;
  }

  const ext = path.extname(resolved.filePath).toLowerCase();
  const contentType = contentTypes.get(ext) || "application/octet-stream";

  res.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": contentType
  });
  res.end(resolved.body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Published build preview running at http://127.0.0.1:${port}`);
});
