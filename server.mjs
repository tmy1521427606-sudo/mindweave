import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiHandler } from "./lib/api.mjs";
import { initializeSchema, openDatabase, syncIssueDirectory } from "./lib/database.mjs";
import { createLearningAgent } from "./lib/agent.mjs";
import { createDoubaoClient, createSourceDateResolver, createTavilyClient } from "./lib/providers.mjs";
import { createDailyGenerationService } from "./lib/daily-generation.mjs";
import { listIssueVersions } from "./lib/issue-versions.mjs";

const siteRoot = path.dirname(fileURLToPath(import.meta.url));

export function createConfiguredAgent({ db, env = process.env, fetchImpl = fetch }) {
  if (!env.ARK_API_KEY?.trim() || !env.DOUBAO_CHAT_MODEL?.trim()) return null;
  const doubao = createDoubaoClient({ apiKey: env.ARK_API_KEY, chatModel: env.DOUBAO_CHAT_MODEL,
    embeddingModel: env.DOUBAO_EMBEDDING_MODEL, fetchImpl });
  const webSearch = createTavilyClient({ apiKey: env.TAVILY_API_KEY ?? "", fetchImpl });
  return createLearningAgent({ db, doubao, webSearch });
}

export function createConfiguredDailyGeneration({
  db,
  dataDir = path.join(siteRoot, "data"),
  env = process.env,
  fetchImpl = fetch,
  clock,
  syncIssues,
} = {}) {
  if (!env.ARK_API_KEY?.trim() || !env.DOUBAO_CHAT_MODEL?.trim() || !env.TAVILY_API_KEY?.trim()) return null;
  const doubao = createDoubaoClient({
    apiKey: env.ARK_API_KEY,
    chatModel: env.DOUBAO_CHAT_MODEL,
    embeddingModel: env.DOUBAO_EMBEDDING_MODEL,
    fetchImpl,
  });
  const tavily = createTavilyClient({ apiKey: env.TAVILY_API_KEY, fetchImpl });
  const resolvePublishedDate = createSourceDateResolver({ fetchImpl });
  return createDailyGenerationService({
    db,
    dataDir,
    doubao,
    search: (query, options) => tavily.search(query, options),
    resolvePublishedDate,
    clock,
    syncIssues: syncIssues ?? (() => syncIssueDirectory(db, dataDir)),
  });
}

export function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const relativeRequest = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativeRequest);
  const relative = path.relative(root, candidate);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : candidate;
}

export function contentType(file) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  );
}

function responseHeaders(file, length) {
  return {
    "Cache-Control": "no-store",
    "Content-Length": length,
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": contentType(file),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

export function createStaticServer(root = siteRoot, apiHandler = null) {
  return createServer(async (request, response) => {
    if (request.url?.startsWith("/api/") && apiHandler) {
      await apiHandler(request, response);
      return;
    }
    if (!request.url || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }

    const file = resolveStaticPath(root, request.url);
    if (!file) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(file);
      response.writeHead(200, responseHeaders(file, body.length));
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const status = error.code === "EACCES" ? 403 : 404;
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(status === 403 ? "Forbidden" : "Not found");
    }
  });
}

function parsePort(args) {
  const index = args.indexOf("--port");
  const value = index === -1 ? 4173 : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("--port 必须是 0 到 65535 之间的整数。");
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  startServer(parsePort(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function startServer(port) {
  const varDir = path.join(siteRoot, "var");
  await mkdir(varDir, { recursive: true });
  const db = openDatabase(path.join(varDir, "cognitive-daily.sqlite"));
  initializeSchema(db);
  await syncIssueDirectory(db, path.join(siteRoot, "data"));
  const dataDir = path.join(siteRoot, "data");
  const dailyGeneration = createConfiguredDailyGeneration({ db, dataDir });
  const server = createStaticServer(siteRoot, createApiHandler({
    db,
    agent: createConfiguredAgent({ db }),
    dailyGeneration,
    issueVersions: (date) => listIssueVersions(dataDir, date),
  }));
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`http://127.0.0.1:${address.port}/`);
  });
}
