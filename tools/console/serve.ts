// A local page for the hub, built like any other client: it calls the owner endpoints and keeps the key on this side.
// Editing rules writes a draft next to rules.json and runs `agent-autoloop check` on it before replacing the file,
// so the page can't hand the hub a file its own command line would reject.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = (process.env.HUB_URL ?? "http://127.0.0.1:3350").replace(/\/+$/, "");
const KEY = process.env.OWNER_KEY ?? "";
const HOST = process.env.CONSOLE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CONSOLE_PORT ?? 3400);
const HOME = process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop");
const RULES = join(HOME, "rules.json");
const CHECK = join(here, "..", "..", "bin", "agent-autoloop.ts");

if (!KEY) {
  console.error(
    "没有本人密钥。先跑 agent-autoloop key new owner console 拿到密钥，再用 OWNER_KEY=<密钥> 启动这个页面。",
  );
  process.exit(1);
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

/** One hub call as the person: the hub's own status and JSON go back to the page unchanged. */
async function hub(method: string, path: string, body?: unknown) {
  const response = await fetch(HUB + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("内容超过 1 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The page's EventSource can't carry the key, so this side opens the hub's stream and passes the bytes through. */
async function stream(req: IncomingMessage, res: ServerResponse, after: string) {
  const upstream = await fetch(`${HUB}/v1/stream?after=${after}`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!upstream.ok || !upstream.body) {
    return json(res, 502, { error: "接不上中台的日志流，中台在跑吗？" });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const reader = upstream.body.getReader();
  req.on("close", () => void reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {}
  res.end();
}

/** The repo's own rules check on a draft file; its words are what the page shows back. */
function runCheck(file: string) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn(process.execPath, [CHECK, "check", file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", (error) => resolve({ ok: false, output: String(error) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://console");
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(readFileSync(join(here, "index.html")));
      return;
    }
    if (method === "GET" && path === "/api/state") {
      const before = url.searchParams.get("before");
      const result = await hub("GET", before === null ? "/v1/state" : `/v1/state?before=${before}`);
      return json(res, result.status, result.data);
    }
    if (method === "GET" && path === "/api/stream") {
      return await stream(req, res, url.searchParams.get("after") ?? String(req.headers["last-event-id"] ?? "0"));
    }
    let match = /^\/api\/cards\/(\d+)\/(answer|resolve)$/.exec(path);
    if (method === "POST" && match) {
      let body: unknown;
      try {
        body = await bodyOf(req).then((text) => (text ? JSON.parse(text) : {}));
      } catch {
        return json(res, 400, { error: "请求里的内容不是 JSON" });
      }
      const result = await hub("POST", `/v1/cards/${match[1]}/${match[2]}`, body);
      return json(res, result.status, result.data);
    }
    match = /^\/api\/runs\/(\d+)\/cancel$/.exec(path);
    if (method === "POST" && match) {
      const result = await hub("POST", `/v1/runs/${match[1]}/cancel`, {});
      return json(res, result.status, result.data);
    }
    match = /^\/api\/rules\/([^/]+)\/(pause|resume|replay|run)$/.exec(path);
    if (method === "POST" && match) {
      let body: unknown;
      try {
        body = await bodyOf(req).then((text) => (text ? JSON.parse(text) : {}));
      } catch {
        return json(res, 400, { error: "请求里的内容不是 JSON" });
      }
      const result = await hub("POST", `/v1/rules/${match[1]}/${match[2]}`, body);
      return json(res, result.status, result.data);
    }
    if (path === "/api/rules" && method === "GET") {
      try {
        return json(res, 200, { path: RULES, text: readFileSync(RULES, "utf8") });
      } catch {
        return json(res, 200, { path: RULES, text: null });
      }
    }
    if (path === "/api/rules" && method === "PUT") {
      let text: unknown;
      try {
        text = JSON.parse(await bodyOf(req))?.text;
      } catch {
        return json(res, 400, { error: "请求里的内容不是 JSON" });
      }
      if (typeof text !== "string") return json(res, 400, { error: "text 要是一段文字" });
      const draft = `${RULES}.console-tmp`;
      writeFileSync(draft, text);
      const checked = await runCheck(draft);
      if (!checked.ok) return json(res, 400, { error: checked.output || "规则检查没过" });
      renameSync(draft, RULES);
      return json(res, 200, { ok: true, output: checked.output });
    }
    return json(res, 404, { error: "没这个接口" });
  } catch (error) {
    return json(res, 502, { error: `连不上中台 ${HUB}：${(error as Error).message}` });
  }
}

createServer((req, res) => void route(req, res)).listen(PORT, HOST, () =>
  console.log(`管理页面：http://${HOST}:${PORT}　中台：${HUB}`),
);
