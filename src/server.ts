import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest, setApiConfig } from "./api.js";
import type { DuckpipeConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, "..", "dashboard");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function startDashboardServer(
  config: DuckpipeConfig,
  port = 9876
): Promise<void> {
  setApiConfig(config);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (handleApiRequest(req, res)) return;
      serveStatic(req, res);
    });

    server.listen(port, () => {
      console.log(`\n  Dashboard: http://localhost:${port}\n`);
      resolve();
    });

    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use. Try --port <number>`);
      }
      reject(err);
    });
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const filePath = join(DASHBOARD_DIR, pathname);

  if (!existsSync(filePath)) {
    // SPA fallback: serve index.html for any unknown path
    const indexPath = join(DASHBOARD_DIR, "index.html");
    if (existsSync(indexPath)) {
      serveFile(indexPath, ".html", res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  serveFile(filePath, ext, res);
}

function serveFile(filePath: string, ext: string, res: ServerResponse): void {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(content);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
}
