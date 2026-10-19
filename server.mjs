import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function localAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendText(res, 405, "Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";
  const target = path.resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const headers = {
    "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "no-cache",
    "X-Content-Type-Options": "nosniff"
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  const lan = localAddress();
  console.log(`码渡已启动：http://localhost:${port}`);
  if (lan) console.log(`局域网地址：http://${lan}:${port}`);
  console.log("手机摄像头需要 HTTPS。推荐使用 GitHub Pages 或手机上的 HTTPS 托管地址。");
});
