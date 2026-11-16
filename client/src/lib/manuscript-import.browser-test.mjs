// Run with: node client/src/lib/manuscript-import.browser-test.mjs
// Builds only the isolated test page under /narrow/, then drives system Chromium
// over the DevTools protocol. No application source or dist directory is changed.
import { build } from "vite";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "manuscript-import-"));
let server, browser, socket;
const requests = [];
try {
  await build({
    configFile: false,
    root: here,
    publicDir: false,
    base: "/narrow/",
    logLevel: "error",
    build: { outDir: join(temp, "dist"), emptyOutDir: true, rollupOptions: { input: join(here, "manuscript-import.browser-test.html") } },
  });
  server = createServer(async (req, res) => {
    requests.push(req.url);
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith("/narrow/")) throw new Error("Unexpected path");
      const rel = url.pathname.slice("/narrow/".length);
      const dest = resolve(temp, "dist", rel);
      if (!dest.startsWith(resolve(temp, "dist") + "/")) throw new Error("Bad path");
      const content = await readFile(dest);
      const mime = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".ttf": "font/ttf" }[extname(dest)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.CHROMIUM || "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${join(temp, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const debugPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${stderr}`)), 15000);
    browser.stderr.on("data", chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    browser.on("error", reject);
    browser.on("exit", code => reject(new Error(`Chromium exited: ${code}\n${stderr}`)));
  });
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const network = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") network.push(message.params.request.url);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const callId = ++id; pending.set(callId, { resolve, reject }); socket.send(JSON.stringify({ id: callId, method, params })); });
  await call("Network.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: `${origin}/narrow/manuscript-import.browser-test.html` });
  let result;
  for (let i = 0; i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const response = await call("Runtime.evaluate", { expression: "window.__importTestResult || null", returnByValue: true });
    if (response.result.value) { result = response.result.value; break; }
  }
  if (!result) throw new Error("Browser test timed out");
  if (!result.ok) throw new Error(result.message);
  if (!requests.some(path => /^\/narrow\/assets\/pdf\.worker\.min-.*\.mjs/.test(path))) throw new Error(`No bundled PDF worker requested under /narrow/: ${requests}`);
  if (network.some(url => !url.startsWith(origin + "/narrow/") && url !== "about:blank")) throw new Error(`Unexpected network request: ${network.join(", ")}`);
  if (requests.some(path => !path.startsWith("/narrow/"))) throw new Error(`Unexpected local request: ${requests}`);
  console.log(`PASS: ${result.message}`);
  console.log(`PASS: bundled PDF worker served beneath /narrow/, with ${network.length} same-origin requests and no external requests`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  }
  if (server) await new Promise(resolve => server.close(resolve));
  // Chromium child processes can briefly hold their profile open after exit.
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
