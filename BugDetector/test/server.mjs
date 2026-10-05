/**
 * Tiny dev server for the bug playground (no dependencies).
 *   node test/server.mjs [port]   →   http://127.0.0.1:5179/
 * Content scripts don't run on file:// or chrome-extension:// pages, so the
 * playground has to be served over http.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": `req_${Date.now().toString(36)}` });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const routes = {
  "GET /api/ok": (req, res) => json(res, 200, { ok: true }),
  "POST /api/orders": async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    json(res, 500, { error: "coupon_not_found", message: `Coupon "${body.coupon}" does not exist`, cartId: body.cartId });
  },
  "GET /api/users/42": (req, res) => json(res, 404, { error: "not_found", message: "User 42 not found" }),
  "PUT /api/profile": async (req, res) => {
    await readBody(req);
    json(res, 500, { error: "db_timeout", message: "Database did not respond in 5s", session_token: "should-be-redacted" });
  }
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return route(req, res);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/bug-playground.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(join(root, "bug-playground.html")));
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.argv[2]) || 5179);
  console.log(`Bug playground running at http://127.0.0.1:${server.address().port}/`);
}
