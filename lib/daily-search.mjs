const SEARCH_GROUPS = Object.freeze([
  { topic: "电商 × Agent", query: "电商 AI Agent 官方 发布 产品 研究" },
  { topic: "数据 × Agent", query: "数据平台 AI Agent 官方 发布 GitHub", allowUndatedLearning: true },
  { topic: "金融 × 科技", query: "金融科技 AI 官方 公告 监管 技术" },
  { topic: "Agent 开发与大模型", query: "AI agent framework model official release GitHub", allowUndatedLearning: true },
  { topic: "模型发布与对比", query: "new AI model official release benchmark", allowUndatedLearning: true },
  { topic: "知识图谱与多智能体", query: "knowledge graph ontology wiki multi-agent release research", allowUndatedLearning: true },
  { topic: "国内模型发布与对比", query: "豆包 通义千问 腾讯混元 文心 智谱 Kimi MiniMax DeepSeek 官方 模型 发布", allowUndatedLearning: true },
  { topic: "国内 Agent 与知识库", query: "火山引擎 阿里云 腾讯云 百度 智谱 Agent RAG 知识库 官方 发布", allowUndatedLearning: true },
]);

const TRACKING_PARAMS = new Set([
  "spm", "source", "ref", "ref_src", "from",
]);

export function buildSearchPlan({ date, lastIssueDate = null, focusMore = [], focusLess = [], temporaryFocus = "", profile = {} }) {
  assertDate(date);
  if (lastIssueDate !== null) assertDate(lastIssueDate);
  assertTextArray(focusMore, "focusMore");
  assertTextArray(focusLess, "focusLess");
  if (focusMore.some((topic) => focusLess.includes(topic))) throw new TypeError("focus topics overlap");
  if (typeof temporaryFocus !== "string" || temporaryFocus.length > 300) throw new TypeError("invalid temporaryFocus");
  if (!profile || typeof profile !== "object") throw new TypeError("invalid profile");

  const endDate = addUtcDays(date, -1);
  const expandedStart = addUtcDays(date, -7);
  const catchUpStart = lastIssueDate && lastIssueDate < date
    ? [addUtcDays(lastIssueDate, 1), expandedStart].sort().at(-1)
    : endDate;
  const suffix = temporaryFocus.trim() ? ` ${temporaryFocus.trim()}` : "";
  const queries = SEARCH_GROUPS.map((group) => ({
    topic: group.topic,
    query: `${group.query}${suffix}`,
    preference: focusMore.includes(group.topic) ? 1 : focusLess.includes(group.topic) ? -1 : 0,
    allowUndatedLearning: group.allowUndatedLearning === true,
  }));
  return {
    date,
    focusMore: [...focusMore],
    focusLess: [...focusLess],
    temporaryFocus: temporaryFocus.trim(),
    profile,
    yesterday: { startDate: catchUpStart, endDate, queries },
    expanded: { startDate: expandedStart, endDate, queries },
  };
}

export async function collectCandidates({ search, plan, excludedUrls = [], resolvePublishedDate = async () => null, onProgress = () => {} }) {
  if (typeof search !== "function") throw new TypeError("search is required");
  if (!plan?.yesterday || !plan?.expanded) throw new TypeError("plan is required");
  if (typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
  if (!Array.isArray(excludedUrls)) throw new TypeError("excludedUrls must be an array");
  if (typeof resolvePublishedDate !== "function") throw new TypeError("resolvePublishedDate must be a function");

  const candidates = new Map();
  const excluded = new Set(excludedUrls.map(normalizePublicUrl).filter(Boolean));
  const dateResolutions = new Map();
  const discarded = { missingDate: 0, outsideWindow: 0, duplicate: 0, invalid: 0 };
  let searchCalls = 0;
  await runWindow(plan.yesterday, "yesterday");
  if (candidates.size < 10) await runWindow(plan.expanded, "expanded");
  return [...candidates.values()].sort((left, right) => (left.dateStatus === "unverified") - (right.dateStatus === "unverified"));

  async function runWindow(window, windowName) {
    const requestEndDate = window.startDate === window.endDate ? addUtcDays(window.endDate, 1) : window.endDate;
    for (const entry of window.queries) {
      searchCalls += 1;
      let results;
      try {
        results = await search(entry.query, {
          maxResults: 10,
          topic: "news",
          startDate: window.startDate,
          endDate: requestEndDate,
          includeRawContent: true,
        });
      } catch {
        onProgress({ searchCalls, candidates: candidates.size, discarded: { ...discarded }, window: windowName });
        continue;
      }
      const normalizedResults = await Promise.all((Array.isArray(results) ? results : [])
        .map((result) => normalizeCandidate(result, entry, windowName, window, resolveDate)));
      for (const normalized of normalizedResults) {
        if (!normalized.candidate) {
          discarded[normalized.reason] += 1;
        } else if (excluded.has(normalized.candidate.url)) {
          discarded.duplicate += 1;
        } else if (candidates.has(normalized.candidate.url)) {
          const existing = candidates.get(normalized.candidate.url);
          if (existing.dateStatus === "unverified" && normalized.candidate.dateStatus === "verified") {
            candidates.set(normalized.candidate.url, normalized.candidate);
          }
          discarded.duplicate += 1;
        } else {
          candidates.set(normalized.candidate.url, normalized.candidate);
        }
      }
      onProgress({ searchCalls, candidates: candidates.size, discarded: { ...discarded }, window: windowName });
    }
  }

  function resolveDate(url) {
    if (!dateResolutions.has(url)) {
      dateResolutions.set(url, Promise.resolve(resolvePublishedDate(url)).catch(() => null));
    }
    return dateResolutions.get(url);
  }
}

async function normalizeCandidate(result, query, windowName, searchWindow, resolvePublishedDate) {
  if (!result || typeof result !== "object") return { candidate: null, reason: "invalid" };
  const url = normalizePublicUrl(result.url);
  const title = typeof result.title === "string" ? result.title.trim() : "";
  const excerptValue = result.raw_content ?? result.content;
  const excerpt = typeof excerptValue === "string" ? excerptValue.trim().slice(0, 12_000) : "";
  if (!url || !title || !excerpt) return { candidate: null, reason: "invalid" };
  const parsed = new URL(url);
  const publishedDate = normalizeDate(result.published_date ?? result.publishedDate)
    ?? normalizeDate(await resolvePublishedDate(url));
  if (!publishedDate && !query.allowUndatedLearning) return { candidate: null, reason: "missingDate" };
  if (publishedDate && (publishedDate < searchWindow.startDate || publishedDate > searchWindow.endDate)) return { candidate: null, reason: "outsideWindow" };
  return { candidate: {
    url,
    title,
    publisher: publisherName(parsed.hostname),
    publishedDate,
    dateStatus: publishedDate ? "verified" : "unverified",
    contentTypeHint: publishedDate ? null : "learning",
    excerpt,
    sourceType: sourceType(parsed.hostname),
    topics: [query.topic],
    preference: query.preference,
    window: windowName,
  } };
}

function normalizePublicUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || unsafeHost(url.hostname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString().replace(/\?$/, "").replace(/\/$/, "");
}

function unsafeHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function sourceType(hostname) {
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return "GitHub";
  if (hostname === "arxiv.org" || hostname.endsWith(".edu")) return "论文/研究";
  if (hostname.endsWith(".gov.cn") || hostname.endsWith(".gov")) return "政府机构";
  return "公开网页";
}

function publisherName(hostname) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  try {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date ? date : null;
  } catch {
    return null;
  }
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function assertDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("invalid date");
  try {
    if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new TypeError("invalid date");
  } catch {
    throw new TypeError("invalid date");
  }
}

function assertTextArray(value, name) {
  if (!Array.isArray(value) || value.length > 20 || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 120)) {
    throw new TypeError(`invalid ${name}`);
  }
}
