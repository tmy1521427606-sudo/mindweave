import { searchArticles } from "./database.mjs";
import { randomUUID } from "node:crypto";
import { validateChatInput } from "./agent.mjs";
import { ProviderUnavailableError } from "./providers.mjs";
import { assertSignal, getProfile, setInterestSignal, setTopicPreference } from "./personalization.mjs";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const ARTICLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KNOWLEDGE_TYPES = new Set(["fact", "concept", "event", "comparison", "relation", "inference"]);
const KNOWLEDGE_STATUSES = new Set(["verified", "needs_review", "rejected", "superseded"]);

export function sendJson(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

export function createApiHandler({ db, agent = null, dailyGeneration = null, issueVersions = null, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  if (!db) throw new TypeError("db is required");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative integer");
  }

  return async function handleApi(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = parseRoute(url.pathname);

      if (route.kind === "chat") {
        if (request.method !== "POST") return sendError(response, 405, "method_not_allowed", "不支持的请求方法", { Allow: "POST" });
        const input = validateChatInput(await readOptionalJsonBody(request, maxBodyBytes));
        if (!agent) throw new ProviderUnavailableError("Doubao");
        return sendJson(response, 200, await agent.answer(input));
      }

      if (route.kind === "health") {
        return requireMethod(request, response, "GET", () => sendJson(response, 200, {
          status: "ok",
          database: "ready",
          doubaoConfigured: Boolean(process.env.ARK_API_KEY),
          agentConfigured: Boolean(agent),
          webSearchConfigured: Boolean(process.env.TAVILY_API_KEY),
          dailyGenerationConfigured: Boolean(dailyGeneration),
        }));
      }

      if (route.kind === "daily_generation") {
        if (request.method !== "POST") return sendError(response, 405, "method_not_allowed", "不支持的请求方法", { Allow: "POST" });
        if (!dailyGeneration) throw new ProviderUnavailableError("Daily generation");
        const input = await readOptionalJsonBody(request, maxBodyBytes);
        try {
          return sendJson(response, 202, dailyGeneration.start(input));
        } catch (error) {
          if (error?.code === "generation_in_progress") throw httpError(409, "generation_in_progress", "已有日报生成任务正在运行");
          if (error instanceof TypeError) throw httpError(400, "invalid_generation_request", "日报生成参数无效");
          throw error;
        }
      }

      if (route.kind === "daily_generation_job") {
        return requireMethod(request, response, "GET", () => {
          if (!dailyGeneration) throw new ProviderUnavailableError("Daily generation");
          const snapshot = dailyGeneration.get(route.jobId);
          if (!snapshot) throw httpError(404, "generation_not_found", "找不到日报生成任务");
          sendJson(response, 200, snapshot);
        });
      }

      if (route.kind === "issue_versions") {
        return requireMethod(request, response, "GET", async () => {
          if (!issueVersions) throw httpError(503, "versions_unavailable", "日报版本暂不可用");
          if (!strictDate(route.date)) throw httpError(400, "invalid_date", "无效的日报日期");
          sendJson(response, 200, await issueVersions(route.date));
        });
      }

      if (route.kind === "search") {
        return requireMethod(request, response, "GET", () => {
          const query = url.searchParams.get("q")?.trim();
          const scope = url.searchParams.get("scope") ?? "all";
          if (!query) throw httpError(400, "missing_query", "缺少搜索关键词");
          if (query.length > 500) throw httpError(400, "invalid_query", "搜索关键词过长");
          if (scope !== "all") throw httpError(400, "invalid_scope", "不支持的搜索范围");
          sendJson(response, 200, { results: searchArticles(db, query) });
        });
      }

      if (route.kind === "knowledge") {
        return requireMethod(request, response, "GET", () => {
          const filters = knowledgeFilters(url.searchParams);
          sendJson(response, 200, { cards: readKnowledgeCards(db, filters), topics: readKnowledgeTopics(db) });
        });
      }

      if (route.kind === "wiki") {
        return requireMethod(request, response, "GET", () => {
          if (!validTopic(route.topic)) throw httpError(400, "invalid_topic", "无效的主题");
          sendJson(response, 200, wikiProjection(route.topic, readKnowledgeCards(db, { topic: route.topic, limit: null })));
        });
      }

      if (route.kind === "knowledge_export") {
        return requireMethod(request, response, "POST", () => {
          const date = new Date().toISOString().slice(0, 10);
          sendJson(response, 200, exportKnowledge(db), {
            "Content-Disposition": `attachment; filename="cognitive-daily-export-${date}.json"`,
          });
        });
      }

      if (route.kind === "profile") {
        return requireMethod(request, response, "GET", () => {
          sendJson(response, 200, { profile: getProfile(db) });
        });
      }

      if (route.kind === "topic_preference") {
        if (request.method !== "POST") return sendError(response, 405, "method_not_allowed", "不支持的请求方法", { Allow: "POST" });
        if (!validTopic(route.topic)) throw httpError(400, "invalid_topic", "无效的主题");
        if (!["lower", "reset", "unfollow"].includes(route.action)) throw httpError(400, "invalid_action", "不支持的主题操作");
        await readOptionalJsonBody(request, maxBodyBytes);
        try { setTopicPreference(db, route.topic, route.action); }
        catch (error) {
          if (error instanceof RangeError) throw httpError(404, "topic_not_found", "主题不存在");
          throw error;
        }
        return sendJson(response, 200, { profile: getProfile(db) });
      }

      if (route.kind === "signal") {
        if (!["PUT", "DELETE"].includes(request.method)) {
          return sendError(response, 405, "method_not_allowed", "不支持的请求方法", { Allow: "PUT, DELETE" });
        }
        if (!ARTICLE_ID.test(route.articleId)) {
          return sendError(response, 400, "invalid_article_id", "无效的文章 ID");
        }
        try {
          assertSignal(route.signal);
        } catch {
          return sendError(response, 400, "invalid_signal", "无效的兴趣信号");
        }
        await readOptionalJsonBody(request, maxBodyBytes);
        try {
          setInterestSignal(db, route.articleId, route.signal, request.method === "PUT");
        } catch (error) {
          if (error instanceof RangeError) {
            return sendError(response, 404, "article_not_found", "文章不存在");
          }
          throw error;
        }
        return sendJson(response, 200, { profile: getProfile(db) });
      }

      return sendError(response, 404, "not_found", "接口不存在");
    } catch (error) {
      if (error?.code === "provider_timeout" || error?.name === "TimeoutError" || error?.status === 504) {
        return sendError(response, 504, "provider_timeout", "服务响应超时，请稍后重试");
      }
      if (error instanceof ProviderUnavailableError) return sendError(response, 503, "provider_unavailable", "服务尚未配置");
      if (error?.status && error?.code) {
        return sendError(response, error.status, error.code, error.message);
      }
      return sendError(response, 500, "internal_error", "服务器处理请求时出错");
    }
  };
}

function parseRoute(pathname) {
  if (pathname === "/api/daily-generations") return { kind: "daily_generation" };
  const generationJob = /^\/api\/daily-generations\/([A-Za-z0-9._-]{1,128})$/.exec(pathname);
  if (generationJob) return { kind: "daily_generation_job", jobId: generationJob[1] };
  const issueVersions = /^\/api\/issues\/([^/]+)\/versions$/.exec(pathname);
  if (issueVersions) {
    try { return { kind: "issue_versions", date: decodeURIComponent(issueVersions[1]) }; }
    catch { return { kind: "issue_versions", date: null }; }
  }
  const topicAction = /^\/api\/profile\/topics\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (topicAction) {
    try { return { kind: "topic_preference", topic: decodeURIComponent(topicAction[1]), action: topicAction[2] }; }
    catch { return { kind: "topic_preference", topic: null, action: topicAction[2] }; }
  }
  if (pathname === "/api/chat") return { kind: "chat" };
  if (pathname === "/api/health") return { kind: "health" };
  if (pathname === "/api/search") return { kind: "search" };
  if (pathname === "/api/profile") return { kind: "profile" };
  if (pathname === "/api/knowledge") return { kind: "knowledge" };
  if (pathname === "/api/knowledge/export") return { kind: "knowledge_export" };
  if (pathname.startsWith("/api/wiki/")) {
    const encodedTopic = pathname.slice("/api/wiki/".length);
    try {
      return { kind: "wiki", topic: decodeURIComponent(encodedTopic) };
    } catch {
      return { kind: "wiki", topic: null };
    }
  }
  const match = /^\/api\/articles\/([^/]+)\/signals\/([^/]+)$/.exec(pathname);
  if (!match) return { kind: "unknown" };
  try {
    return { kind: "signal", articleId: decodeURIComponent(match[1]), signal: decodeURIComponent(match[2]) };
  } catch {
    return { kind: "unknown" };
  }
}

function knowledgeFilters(params) {
  const topic = params.get("topic")?.trim() || undefined;
  const type = params.get("type")?.trim() || undefined;
  const status = params.get("status")?.trim() || undefined;
  const date = params.get("date")?.trim() || undefined;
  if (topic && !validTopic(topic)) throw httpError(400, "invalid_topic", "无效的主题");
  if (type && !KNOWLEDGE_TYPES.has(type)) throw httpError(400, "invalid_type", "不支持的知识卡片类型");
  if (status && !KNOWLEDGE_STATUSES.has(status)) throw httpError(400, "invalid_status", "不支持的知识卡片状态");
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw httpError(400, "invalid_date", "无效的创建日期");
  return { topic, type, status, date };
}

function validTopic(topic) {
  return typeof topic === "string" && topic.trim().length > 0 && topic.length <= 120 && !/[\u0000-\u001f\u007f]/.test(topic);
}

function strictDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; }
  catch { return false; }
}

function readKnowledgeCards(db, { topic, type, status, date, limit = 200 } = {}) {
  const clauses = [];
  const values = [];
  if (topic) {
    clauses.push("EXISTS (SELECT 1 FROM card_topics ct WHERE ct.card_id = c.id AND ct.topic = ?)");
    values.push(topic);
  }
  if (type) {
    clauses.push("c.type = ?");
    values.push(type);
  }
  if (status) {
    clauses.push("c.status = ?");
    values.push(status);
  }
  if (date) {
    clauses.push("substr(c.created_at, 1, 10) = ?");
    values.push(date);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rowLimit = limit === null ? -1 : Math.min(200, limit);
  const rows = db.prepare(`
    SELECT c.id, c.fingerprint, c.type, c.status, c.text, c.conflicted, c.created_at AS createdAt
    FROM knowledge_cards c ${where}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ?
  `).all(...values, rowLimit);
  return rows.map((row) => ({
    ...row,
    conflicted: Boolean(row.conflicted),
    updatedAt: row.createdAt,
    topics: db.prepare("SELECT topic FROM card_topics WHERE card_id = ? ORDER BY topic").all(row.id).map((entry) => entry.topic),
    sources: sourcesForCard(db, row.id),
  }));
}

function sourcesForCard(db, cardId) {
  return db.prepare(`
    SELECT s.id, s.fingerprint, s.url, s.publisher, s.title, s.source_type AS type,
           s.published_date AS publishedDate, s.excerpt, s.content_fingerprint AS contentFingerprint
    FROM knowledge_card_sources cs JOIN knowledge_sources s ON s.id = cs.source_id
    WHERE cs.card_id = ? ORDER BY s.id
  `).all(cardId);
}

function readKnowledgeTopics(db) {
  return db.prepare("SELECT DISTINCT topic FROM card_topics ORDER BY topic").all().map((row) => row.topic);
}

function wikiProjection(topic, cards) {
  const sections = () => ({ definitions: [], events: [], relations: [], other: [] });
  const projection = { topic, verified: sections(), needs_review: sections() };
  for (const card of cards) {
    const group = projection[card.status];
    if (!group) continue;
    if (card.type === "concept") group.definitions.push(card);
    else if (card.type === "event") group.events.push(card);
    else if (card.type === "relation") group.relations.push(card);
    else group.other.push(card);
  }
  return projection;
}

function exportKnowledge(db) {
  const sources = db.prepare(`
    SELECT id, fingerprint, url, publisher, title, source_type AS type, published_date AS publishedDate, excerpt,
      content_fingerprint AS contentFingerprint
    FROM knowledge_sources ORDER BY id
  `).all();
  const signals = db.prepare(`
    SELECT article_id AS articleId, topic, signal, created_at AS createdAt
    FROM interest_signals ORDER BY created_at, article_id, topic, signal
  `).all();
  const conversations = db.prepare("SELECT id, created_at AS createdAt FROM conversations ORDER BY created_at, id").all()
    .map((conversation) => ({
      ...conversation,
      messages: db.prepare(`
        SELECT id, role, content, created_at AS createdAt FROM messages
        WHERE conversation_id = ? ORDER BY created_at, id
      `).all(conversation.id),
    }));
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    sources,
    cards: readKnowledgeCards(db, { limit: null }),
    signals,
    conversations,
    cardRelations: db.prepare("SELECT id, from_card_id AS fromCardId, to_card_id AS toCardId, relation_type AS type FROM card_relations ORDER BY id").all(),
    cardSourceLinks: db.prepare("SELECT card_id AS cardId, source_id AS sourceId FROM knowledge_card_sources ORDER BY card_id, source_id").all(),
    topicProvenance: {
      explicit: db.prepare("SELECT card_id AS cardId, topic FROM knowledge_card_explicit_topics ORDER BY card_id, topic").all(),
      articles: db.prepare("SELECT card_id AS cardId, article_id AS articleId FROM knowledge_card_article_provenance ORDER BY card_id, article_id").all(),
      origins: db.prepare("SELECT card_id AS cardId, origin FROM knowledge_card_topic_origins ORDER BY card_id").all(),
    },
    articleReferences: db.prepare(`SELECT a.id, a.issue_date AS issueDate, a.title, a.source_url AS sourceUrl,
      EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = a.id) AS retired FROM articles a
      WHERE a.id IN (SELECT article_id FROM knowledge_card_article_provenance UNION SELECT article_id FROM interest_signals)
      ORDER BY a.id`).all().map((article) => ({ ...article, retired: Boolean(article.retired),
      topics: db.prepare("SELECT topic FROM article_topics WHERE article_id = ? ORDER BY topic").all(article.id).map((row) => row.topic),
    })),
  };
}

function requireMethod(request, response, method, callback) {
  if (request.method !== method) {
    return sendError(response, 405, "method_not_allowed", "不支持的请求方法", { Allow: method });
  }
  return callback();
}

async function readOptionalJsonBody(request, maxBodyBytes) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  const hasBody = declaredLength > 0 || Boolean(request.headers["transfer-encoding"]);
  if (!hasBody) return;
  if (declaredLength > maxBodyBytes) {
    request.resume();
    throw httpError(413, "body_too_large", "请求正文过大");
  }
  const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    request.resume();
    throw httpError(415, "unsupported_media_type", "请求正文必须为 JSON");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, "body_too_large", "请求正文过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "invalid_json", "请求正文不是有效 JSON");
  }
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sendError(response, status, code, message, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify({ error: { code, message, requestId: randomUUID() } }));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}
