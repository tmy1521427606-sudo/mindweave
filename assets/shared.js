export const FEEDBACK_TAGS = [
  "useful",
  "known",
  "tooShallow",
  "tooDeep",
  "irrelevant",
  "follow",
];

export const INTEREST_SIGNALS = Object.freeze({
  bookmark: 1,
  follow: 3,
  moreLikeThis: 2,
  lessLikeThis: -1,
  needFoundation: 0,
  wantTechnical: 0,
  wantBusiness: 0,
  known: 0,
  irrelevant: -3,
});

export const SORTS = ["personalized", "scoreDesc", "dateDesc"];

export const STORAGE_KEYS = {
  feedback: "cognitiveDaily.v1.feedback",
  viewState: "cognitiveDaily.v1.viewState",
  scrollPosition: "cognitiveDaily.v1.scrollPosition",
  summaryCollapsed: "cognitiveDaily.v1.summaryCollapsed",
  interestSignals: "cognitiveDaily.v2.interestSignals",
  signalsMigrated: "cognitiveDaily.v2.signalsMigrated",
  sortPreference: "cognitiveDaily.v2.sortPreference",
};

export function explicitSortParam(params) {
  const sort = params?.get?.("sort");
  return SORTS.includes(sort) ? sort : null;
}

export function archiveSearchPath(query) {
  const normalized = typeof query === "string" ? query.trim() : "";
  return normalized
    ? `/api/search?q=${encodeURIComponent(normalized)}&scope=all`
    : null;
}

export function archiveSearchResult(result) {
  const item = result?.item && typeof result.item === "object" ? result.item : {};
  const text = (value, fallback = "") =>
    typeof value === "string" && value.trim() ? value : fallback;
  return {
    id: text(result?.id),
    issueDate: text(result?.issueDate),
    title: text(result?.title, "无标题"),
    sourceName: text(result?.sourceName, "来源未提供"),
    topics: Array.isArray(item.topics)
      ? item.topics.filter((topic) => typeof topic === "string")
      : [],
    snippet: text(item.oneLineValue, text(item.fact, text(item.relevance, "暂无摘要"))),
  };
}

export async function apiJson(path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(path, { cache: "no-store", ...options });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`),
      { status: response.status, code: body?.error?.code },
    );
  }
  return body;
}

export function toggleInterestSignal(signals, signal) {
  const current = Array.isArray(signals)
    ? signals.filter((value) => Object.hasOwn(INTEREST_SIGNALS, value))
    : [];
  if (!Object.hasOwn(INTEREST_SIGNALS, signal)) return [...current];
  const topicPreferenceSignals = ["moreLikeThis", "lessLikeThis", "irrelevant"];
  if (topicPreferenceSignals.includes(signal) && !current.includes(signal)) {
    return [...current.filter((value) => !topicPreferenceSignals.includes(value)), signal];
  }
  return current.includes(signal)
    ? current.filter((value) => value !== signal)
    : [...current, signal];
}

export function legacySignalEntries(feedbackById) {
  const migrations = [];
  for (const [articleId, record] of Object.entries(feedbackById ?? {})) {
    const tags = Array.isArray(record?.tags) ? record.tags : [];
    const signals = tags.filter((tag) =>
      ["known", "irrelevant", "follow"].includes(tag),
    );
    if (signals.length > 0) migrations.push({ articleId, signals });
  }
  return migrations;
}

export function choosePersonalizedSort(
  currentSort,
  profile,
  manualPreference,
  hasExplicitUrlSort = false,
) {
  if (hasExplicitUrlSort) return currentSort;
  if (SORTS.includes(manualPreference)) return manualPreference;
  return profile?.evidenceCount > 0 ? "personalized" : currentSort;
}

export async function migrateLegacySignals(feedbackById, send) {
  let complete = true;
  let lastResult = null;
  for (const { articleId, signals } of legacySignalEntries(feedbackById)) {
    for (const signal of signals) {
      try {
        lastResult = await send(articleId, signal);
      } catch (error) {
        if (error?.status !== 404) complete = false;
      }
    }
  }
  return { complete, lastResult };
}

export function createSerialTaskQueue(task) {
  let tail = Promise.resolve();
  return (...args) => {
    const result = tail.then(() => task(...args));
    tail = result.catch(() => undefined);
    return result;
  };
}

export function personalizedScore(item, profile) {
  const editorial = Number.isFinite(item.score?.editorial)
    ? item.score.editorial
    : Number.isFinite(item.score?.total)
      ? item.score.total
      : 0;
  const raw = (item.topics ?? []).reduce(
    (sum, topic) => sum + (profile.topics?.[topic] ?? 0),
    0,
  );
  const personalizedBoost = Math.max(-6, Math.min(6, raw));
  return { editorial, personalizedBoost, total: editorial + personalizedBoost };
}

export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function buildIssueNavigation(issues, todayDate = shanghaiDate()) {
  const sorted = [...issues].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] ?? null;
  const today = sorted.find((issue) => issue.date === todayDate) ?? null;
  const primary = today ?? latest;
  const remaining = sorted.filter((issue) => issue !== primary);
  const previous = remaining[0] ?? null;
  return {
    today,
    latest,
    previous,
    yesterday: previous,
    archive: remaining.slice(1),
  };
}

export function issueDateLabel(issue, { todayDate = shanghaiDate(), latestDate } = {}) {
  if (issue?.date === todayDate) return issue.status === "tracking" ? "今日追踪 · 进行中" : "今日日报 · 已定稿";
  if (issue?.date === latestDate) return "最近一期";
  return issue?.status === "tracking" ? "往期追踪" : "往期日报 · 已定稿";
}

export function itemTimingLabel(item, issueStatus) {
  if (item.dateStatus === "unverified") return "日期待核验";
  if (issueStatus === "tracking") {
    return item.isBackfill ? "热点跟进" : "今日新增";
  }
  return item.isBackfill ? "回溯" : "当日";
}

export function defaultViewState(date) {
  return {
    date,
    search: "",
    sections: [],
    contentTypes: [],
    regions: [],
    priorities: [],
    topics: [],
    sourceTypes: [],
    minScore: 0,
    feedbackStates: [],
    sort: "scoreDesc",
  };
}

export function normalizeViewState(candidate, validDates) {
  const latest = validDates[0];
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const textArray = (value) =>
    Array.isArray(value)
      ? [...new Set(value.filter((entry) => typeof entry === "string"))]
      : [];

  return {
    date: validDates.includes(source.date) ? source.date : latest,
    search: typeof source.search === "string" ? source.search : "",
    sections: textArray(source.sections).filter((value) =>
      ["yesterday", "backfill"].includes(value),
    ),
    contentTypes: textArray(source.contentTypes).filter((value) =>
      ["news", "learning"].includes(value),
    ),
    regions: textArray(source.regions),
    priorities: textArray(source.priorities),
    topics: textArray(source.topics),
    sourceTypes: textArray(source.sourceTypes),
    minScore: Math.min(100, Math.max(0, Number(source.minScore) || 0)),
    feedbackStates: textArray(source.feedbackStates).filter(
      (value) => value === "unrated" || FEEDBACK_TAGS.includes(value),
    ),
    sort: SORTS.includes(source.sort) ? source.sort : "scoreDesc",
  };
}

export function resolveViewState(params, stored, validDates) {
  const merged = { ...defaultViewState(validDates[0]), ...(stored ?? {}) };
  const mappings = [
    ["q", "search", false],
    ["section", "sections", true],
    ["contentType", "contentTypes", true],
    ["region", "regions", true],
    ["priority", "priorities", true],
    ["topic", "topics", true],
    ["source", "sourceTypes", true],
    ["feedback", "feedbackStates", true],
    ["sort", "sort", false],
  ];

  merged.date = params.has("date") ? params.get("date") : validDates[0];
  if (params.has("minScore")) merged.minScore = params.get("minScore");
  for (const [queryKey, stateKey, multiple] of mappings) {
    if (params.has(queryKey)) {
      merged[stateKey] = multiple ? params.getAll(queryKey) : params.get(queryKey);
    }
  }
  return normalizeViewState(merged, validDates);
}

export function viewStateToParams(state, { includeSort = true } = {}) {
  const params = new URLSearchParams();
  params.set("date", state.date);
  if (state.search) params.set("q", state.search);
  for (const value of state.sections) params.append("section", value);
  for (const value of state.contentTypes) params.append("contentType", value);
  for (const value of state.regions) params.append("region", value);
  for (const value of state.priorities) params.append("priority", value);
  for (const value of state.topics) params.append("topic", value);
  for (const value of state.sourceTypes) params.append("source", value);
  if (state.minScore > 0) params.set("minScore", String(state.minScore));
  for (const value of state.feedbackStates) params.append("feedback", value);
  if (includeSort) params.set("sort", state.sort);
  return params;
}

export function feedbackWithSignals(feedbackById, articleSignals) {
  if (!articleSignals) return feedbackById;
  const overlapping = ["known", "irrelevant", "follow"];
  return Object.fromEntries([...new Set([...Object.keys(feedbackById), ...Object.keys(articleSignals)])].map((id) => [id, {
    ...feedbackById[id], tags: [
      ...(feedbackById[id]?.tags ?? []).filter((tag) => !overlapping.includes(tag)),
      ...(articleSignals[id] ?? []).filter((signal) => overlapping.includes(signal)),
    ],
  }]));
}

export function filterItems(items, state, feedbackById, profile = {}) {
  const feedback = feedbackWithSignals(feedbackById, profile.articleSignals);
  const query = state.search.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const tags = feedback[item.id]?.tags ?? [];
    const concepts = Array.isArray(item.concepts) ? item.concepts : [];
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const sourceType = item.source?.type ?? "";
    const totalScore = Number.isFinite(item.score?.total) ? item.score.total : 0;
    const searchText = [
      item.title ?? "",
      item.oneLineValue ?? "",
      ...concepts.map((concept) => concept.name ?? ""),
    ]
      .join(" ")
      .toLocaleLowerCase();
    const section = item.isBackfill ? "backfill" : "yesterday";
    const feedbackMatch =
      state.feedbackStates.length === 0 ||
      state.feedbackStates.some((value) =>
        value === "unrated" ? tags.length === 0 : tags.includes(value),
      );

    return (
      (!query || searchText.includes(query)) &&
      (state.sections.length === 0 || state.sections.includes(section)) &&
      (state.contentTypes.length === 0 ||
        state.contentTypes.includes(item.contentType)) &&
      (state.regions.length === 0 || state.regions.includes(item.region)) &&
      (state.priorities.length === 0 ||
        state.priorities.includes(item.priority)) &&
      (state.topics.length === 0 ||
        state.topics.some((topic) => topics.includes(topic))) &&
      (state.sourceTypes.length === 0 ||
        state.sourceTypes.includes(sourceType)) &&
      totalScore >= state.minScore &&
      feedbackMatch
    );
  });
}

export function sortItems(items, sort, profile = {}) {
  const copy = [...items];
  const dateOf = (item) =>
    typeof item.publishedDate === "string" ? item.publishedDate : "";
  const scoreOf = (item) =>
    sort === "personalized"
      ? personalizedScore(item, profile).total
      : Number.isFinite(item.score?.editorial)
        ? item.score.editorial
        : Number.isFinite(item.score?.total)
          ? item.score.total
          : 0;
  return copy.sort(
    sort === "dateDesc"
      ? (a, b) =>
          dateOf(b).localeCompare(dateOf(a)) || scoreOf(b) - scoreOf(a)
      : (a, b) =>
          scoreOf(b) - scoreOf(a) || dateOf(b).localeCompare(dateOf(a)),
  );
}

export function getDetailOrder(items, state, feedbackById, profile = {}) {
  return sortItems(filterItems(items, state, feedbackById, profile), state.sort, profile);
}

export function toggleFeedback(tags, tag) {
  if (!FEEDBACK_TAGS.includes(tag)) return [...tags];
  if (tags.includes(tag)) return tags.filter((value) => value !== tag);
  const excludes = {
    useful: "irrelevant",
    irrelevant: "useful",
    tooShallow: "tooDeep",
    tooDeep: "tooShallow",
  };
  return [...tags.filter((value) => value !== excludes[tag]), tag];
}

export function calculateFeedbackMetrics(itemIds, feedbackById, profile = {}) {
  const idSet = new Set(itemIds);
  const records = Object.entries(feedbackWithSignals(feedbackById, profile.articleSignals))
    .filter(
      ([id, record]) =>
        idSet.has(id) && Array.isArray(record?.tags) && record.tags.length > 0,
    )
    .map(([, record]) => record);
  const rates = Object.fromEntries(
    FEEDBACK_TAGS.map((tag) => [
      tag,
      records.length
        ? records.filter((record) => record.tags.includes(tag)).length /
          records.length
        : null,
    ]),
  );

  return {
    itemCount: itemIds.length,
    feedbackCount: records.length,
    coverage: itemIds.length ? records.length / itemIds.length : 0,
    rates,
  };
}

export function readStoredJson(storage, key, fallback) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      return fallback;
    }
    return fallback;
  }
}

export function writeStoredJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function loadJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`无法读取 ${url}（HTTP ${response.status}）`);
  }
  return response.json();
}
