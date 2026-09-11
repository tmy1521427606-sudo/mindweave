import {
  apiJson,
  archiveSearchPath,
  archiveSearchResult,
  buildIssueNavigation,
  calculateFeedbackMetrics,
  choosePersonalizedSort,
  createSerialTaskQueue,
  defaultViewState,
  explicitSortParam,
  filterItems,
  loadJson,
  legacySignalEntries,
  itemTimingLabel,
  migrateLegacySignals,
  normalizeViewState,
  personalizedScore,
  readStoredJson,
  resolveViewState,
  sortItems,
  SORTS,
  STORAGE_KEYS,
  toggleInterestSignal,
  viewStateToParams,
  writeStoredJson,
} from "./shared.js";
import { mountLearningAgent } from "./agent.js";
import { initializeDailyGeneration, versionFileForEntry } from "./daily-generation.js";

const interestLabels = {
  bookmark: "收藏",
  follow: "跟踪",
  moreLikeThis: "更多同类",
  lessLikeThis: "减少推荐",
  needFoundation: "需要基础",
  wantTechnical: "技术视角",
  wantBusiness: "商业视角",
  known: "我已很了解",
  irrelevant: "不感兴趣",
};

const primaryInterestSignals = ["bookmark", "follow"];
const topicPreferenceSignals = ["moreLikeThis", "lessLikeThis", "irrelevant"];
const learningPreferenceSignals = [
  "needFoundation",
  "wantTechnical",
  "wantBusiness",
  "known",
];

const feedbackLabels = {
  useful: "有用率",
  known: "已知率",
  tooShallow: "太浅率",
  tooDeep: "太深率",
  irrelevant: "无关率",
  follow: "想追踪率",
};

const app = {
  manifest: null,
  issue: null,
  view: null,
  feedback: {},
  interestSignals: {},
  profile: { topics: {}, depth: 0, angles: {}, evidenceCount: 0 },
  manualSort: null,
  explicitSort: false,
  allItemIds: [],
  historyLoadFailed: false,
  version: null,
};

let archiveSearchTimer = null;
let archiveSearchController = null;

const elements = Object.fromEntries(
  [
    "issue-date-label",
    "issue-counts",
    "issue-reading",
    "issue-generated",
    "summary-toggle",
    "summary-heading",
    "summary-content",
    "summary-list",
    "summary-count-hint",
    "today-link",
    "yesterday-link",
    "archive-links",
    "metric-list",
    "metrics-note",
    "filter-toggle",
    "filter-panel",
    "clear-filters",
    "issue-date",
    "search-input",
    "archive-search-open",
    "archive-search-dialog",
    "archive-search-form",
    "archive-search-input",
    "archive-search-count",
    "archive-search-status",
    "archive-search-results",
    "content-type-filter",
    "region-filter",
    "priority-filter",
    "topic-filter",
    "source-filter",
    "min-score",
    "min-score-output",
    "sort-select",
    "result-count",
    "load-error",
    "error-message",
    "retry-button",
    "fallback-button",
    "news-list",
    "empty-state",
    "empty-summary",
    "empty-clear",
  ].map((id) => [id, document.getElementById(id)]),
);

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function formatDate(date) {
  if (typeof date !== "string") return "本期未提供";
  const parsed = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return "本期未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parsed);
}

function formatDateTime(dateTime) {
  const parsed = new Date(dateTime);
  if (Number.isNaN(parsed.getTime())) return "更新时间未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function setChildren(parent, children) {
  parent.replaceChildren(...children);
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function normalizeInterestStore(value) {
  const source = safeObject(value);
  return Object.fromEntries(
    Object.entries(source).map(([articleId, signals]) => [
      articleId,
      [...new Set(
        (Array.isArray(signals) ? signals : []).filter((signal) =>
          Object.hasOwn(interestLabels, signal),
        ),
      )],
    ]),
  );
}

function currentInterestSignals(articleId) {
  return app.interestSignals[articleId] ?? [];
}

function renderInterestButtonStates(articleId) {
  const selected = new Set(currentInterestSignals(articleId));
  for (const button of document.querySelectorAll("[data-interest-signal]")) {
    if (button.dataset.articleId === articleId) {
      button.setAttribute(
        "aria-pressed",
        String(selected.has(button.dataset.interestSignal)),
      );
    }
  }
}

function setInterestButtonsDisabled(articleId, disabled) {
  for (const button of document.querySelectorAll("[data-interest-signal]")) {
    if (button.dataset.articleId === articleId) button.disabled = disabled;
  }
}

function applyServerProfile(value) {
  app.profile = safeObject(value);
  app.interestSignals = normalizeInterestStore(app.profile.articleSignals);
  writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, app.interestSignals);
}

function interestStatus(articleId, message) {
  for (const status of document.querySelectorAll("[data-interest-status]")) {
    if (status.dataset.interestStatus === articleId) status.textContent = message;
  }
}

function findInterestButton(articleId, signal) {
  return [...document.querySelectorAll("[data-interest-signal]")].find(
    (button) =>
      button.dataset.articleId === articleId &&
      button.dataset.interestSignal === signal,
  );
}

async function commitInterestSignal(articleId, signal) {
  const previous = currentInterestSignals(articleId);
  const next = toggleInterestSignal(previous, signal);
  const enabled = next.includes(signal);
  app.interestSignals[articleId] = next;
  writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, app.interestSignals);
  renderInterestButtonStates(articleId);
  interestStatus(articleId, "正在保存兴趣设置…");

  try {
    const result = await apiJson(
      `/api/articles/${encodeURIComponent(articleId)}/signals/${encodeURIComponent(signal)}`,
      { method: enabled ? "PUT" : "DELETE" },
    );
    applyServerProfile(result.profile);
    app.view.sort = choosePersonalizedSort(
      app.view.sort,
      app.profile,
      app.manualSort,
      app.explicitSort,
    );
    persistView();
    renderList();
    renderMetrics();
    const nextButton = findInterestButton(articleId, signal);
    const details = nextButton?.closest("details");
    if (details) details.open = true;
    nextButton?.focus();
    interestStatus(
      articleId,
      enabled ? `已启用：${interestLabels[signal]}` : `已取消：${interestLabels[signal]}`,
    );
  } catch (error) {
    app.interestSignals[articleId] = previous;
    writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, app.interestSignals);
    renderInterestButtonStates(articleId);
    interestStatus(articleId, `保存失败，已恢复原设置。${error.message}`);
  }
}

const enqueueInterestUpdate = createSerialTaskQueue(commitInterestSignal);

function updateInterestSignal(articleId, signal) {
  setInterestButtonsDisabled(articleId, true);
  return enqueueInterestUpdate(articleId, signal).finally(() => {
    setInterestButtonsDisabled(articleId, false);
  });
}

function makeInterestButton(articleId, signal) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.articleId = articleId;
  button.dataset.interestSignal = signal;
  button.setAttribute(
    "aria-pressed",
    String(currentInterestSignals(articleId).includes(signal)),
  );
  button.textContent = interestLabels[signal];
  button.addEventListener("click", () => updateInterestSignal(articleId, signal));
  return button;
}

function makeInterestControls(articleId) {
  const controls = document.createElement("div");
  controls.className = "interest-controls card-interest-controls";
  const primary = document.createElement("div");
  primary.className = "interest-buttons";
  primary.setAttribute("role", "group");
  primary.setAttribute("aria-label", "常用兴趣操作");
  primary.append(
    ...primaryInterestSignals.map((signal) => makeInterestButton(articleId, signal)),
  );

  const more = document.createElement("details");
  more.className = "interest-more";
  const summary = textElement("summary", "", "调整推荐与学习偏好");
  const topicPreferences = document.createElement("div");
  topicPreferences.className = "interest-buttons interest-preference-buttons";
  topicPreferences.setAttribute("role", "group");
  topicPreferences.setAttribute("aria-label", "推荐偏好（三选一）");
  topicPreferences.append(
    ...topicPreferenceSignals.map((signal) => makeInterestButton(articleId, signal)),
  );
  const learningPreferences = document.createElement("div");
  learningPreferences.className = "interest-buttons";
  learningPreferences.setAttribute("role", "group");
  learningPreferences.setAttribute("aria-label", "学习偏好");
  learningPreferences.append(
    ...learningPreferenceSignals.map((signal) => makeInterestButton(articleId, signal)),
  );
  more.append(summary, topicPreferences, learningPreferences);

  const status = textElement("p", "feedback-status", "");
  status.dataset.interestStatus = articleId;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  controls.append(primary, more, status);
  return controls;
}

async function migrateLegacyFeedback() {
  const migrated = readStoredJson(localStorage, STORAGE_KEYS.signalsMigrated, false);
  if (migrated === true) return;
  const result = await migrateLegacySignals(app.feedback, async (articleId, signal) => {
    const response = await apiJson(
      `/api/articles/${encodeURIComponent(articleId)}/signals/${encodeURIComponent(signal)}`,
      { method: "PUT" },
    );
    applyServerProfile(response.profile);
    return response;
  });
  if (result.complete) {
    writeStoredJson(localStorage, STORAGE_KEYS.signalsMigrated, true);
  }
}

async function loadManifest() {
  const manifest = await loadJson("data/index.json");
  if (!Array.isArray(manifest.issues) || manifest.issues.length === 0) {
    throw new Error("日报清单为空。");
  }
  return {
    issues: [...manifest.issues].sort((a, b) => b.date.localeCompare(a.date)),
  };
}

function collectOptions(items) {
  return {
    contentTypes: [
      ...new Set(items.map((item) => item.contentType).filter(Boolean)),
    ],
    regions: [...new Set(items.map((item) => item.region).filter(Boolean))],
    priorities: [
      ...new Set(items.map((item) => item.priority).filter(Boolean)),
    ],
    topics: [
      ...new Set(
        items.flatMap((item) => (Array.isArray(item.topics) ? item.topics : [])),
      ),
    ].sort((a, b) => a.localeCompare(b, "zh-CN")),
    sourceTypes: [
      ...new Set(items.map((item) => item.source?.type).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, "zh-CN")),
  };
}

function checkedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(
    (input) => input.value,
  );
}

function readControls() {
  return normalizeViewState(
    {
      date: elements["issue-date"].value,
      search: elements["search-input"].value,
      sections: checkedValues("section-filter"),
      contentTypes: checkedValues("content-type-filter"),
      regions: checkedValues("region-filter"),
      priorities: checkedValues("priority-filter"),
      topics: checkedValues("topic-filter"),
      sourceTypes: checkedValues("source-filter"),
      minScore: elements["min-score"].value,
      feedbackStates: checkedValues("feedback-filter"),
      sort: elements["sort-select"].value,
    },
    app.manifest.issues.map((issue) => issue.date),
  );
}

function setCheckedValues(name, selected) {
  const selectedSet = new Set(selected);
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = selectedSet.has(input.value);
  }
}

function writeControls() {
  elements["issue-date"].value = app.view.date;
  elements["search-input"].value = app.view.search;
  setCheckedValues("section-filter", app.view.sections);
  setCheckedValues("content-type-filter", app.view.contentTypes);
  setCheckedValues("region-filter", app.view.regions);
  setCheckedValues("priority-filter", app.view.priorities);
  setCheckedValues("topic-filter", app.view.topics);
  setCheckedValues("source-filter", app.view.sourceTypes);
  elements["min-score"].value = String(app.view.minScore);
  elements["min-score-output"].value = String(app.view.minScore);
  elements["min-score-output"].textContent = String(app.view.minScore);
  setCheckedValues("feedback-filter", app.view.feedbackStates);
  elements["sort-select"].value = app.view.sort;
}

function persistView() {
  const params = viewStateToParams(app.view, {
    includeSort: app.explicitSort || SORTS.includes(app.manualSort),
  });
  if (app.version) params.set("version", String(app.version));
  history.replaceState(null, "", `${location.pathname}?${params}`);
  writeStoredJson(localStorage, STORAGE_KEYS.viewState, app.view);
}

function renderSummary(issue) {
  elements["summary-heading"].textContent = issue.status === "tracking"
    ? "今日 4 点摘要"
    : "本期 4 点摘要";
  setChildren(
    elements["summary-list"],
    issue.summary.map((entry) => textElement("li", "", entry)),
  );
  elements["summary-count-hint"].textContent = `以下是 4 点摘要；下方完整列表共 ${issue.items.length} 条，可按类型、地区和优先级筛选。`;
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMetrics() {
  const metrics = calculateFeedbackMetrics(app.allItemIds, app.feedback, { articleSignals: app.interestSignals });
  const entries = [
    ["反馈覆盖率", percentage(metrics.coverage), `${metrics.feedbackCount} / ${metrics.itemCount} 条已反馈`],
    ...Object.entries(feedbackLabels).map(([key, label]) => [
      label,
      metrics.rates[key] === null ? "暂无反馈" : percentage(metrics.rates[key]),
      metrics.rates[key] === null ? "需要先给新闻反馈" : "以已反馈新闻为分母",
    ]),
  ];

  const cards = entries.map(([label, value, note]) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.append(
      textElement("span", "metric-label", label),
      textElement("strong", "metric-value", value),
      textElement("small", "metric-note", note),
    );
    return card;
  });
  setChildren(elements["metric-list"], cards);
  elements["metrics-note"].textContent = app.historyLoadFailed
    ? "兴趣反馈保存在本机知识库；部分历史日报暂时无法读取。"
    : "兴趣反馈以本机知识库为准，阅读校准标签保存在当前浏览器。标签率以已反馈新闻为分母。";
}

function renderCheckboxGroup(container, values, selected, name) {
  const labels = { news: "新闻事件", learning: "技术连续学习" };
  const selectedSet = new Set(selected);
  const rows = values.map((value, index) => {
    const label = document.createElement("label");
    label.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = value;
    input.id = `${name}-${index}`;
    input.checked = selectedSet.has(value);
    label.append(input, document.createTextNode(` ${labels[value] ?? value}`));
    return label;
  });
  setChildren(container, rows);
}

function renderFilters(items) {
  const { contentTypes, regions, priorities, topics, sourceTypes } = collectOptions(items);
  app.view.contentTypes = app.view.contentTypes.filter((value) =>
    contentTypes.includes(value),
  );
  app.view.regions = app.view.regions.filter((value) => regions.includes(value));
  app.view.priorities = app.view.priorities.filter((value) =>
    priorities.includes(value),
  );
  app.view.topics = app.view.topics.filter((topic) => topics.includes(topic));
  app.view.sourceTypes = app.view.sourceTypes.filter((type) => sourceTypes.includes(type));
  renderCheckboxGroup(
    elements["content-type-filter"],
    contentTypes,
    app.view.contentTypes,
    "content-type-filter",
  );
  renderCheckboxGroup(
    elements["region-filter"],
    regions,
    app.view.regions,
    "region-filter",
  );
  renderCheckboxGroup(
    elements["priority-filter"],
    priorities,
    app.view.priorities,
    "priority-filter",
  );
  renderCheckboxGroup(elements["topic-filter"], topics, app.view.topics, "topic-filter");
  renderCheckboxGroup(
    elements["source-filter"],
    sourceTypes,
    app.view.sourceTypes,
    "source-filter",
  );
}

function makeChip(text, className = "") {
  return textElement("span", `chip ${className}`.trim(), text);
}

export function renderArchiveSearchResults(results) {
  const shaped = Array.isArray(results)
    ? results.map(archiveSearchResult).filter((result) => result.id && result.issueDate)
    : [];
  const cards = shaped.map((result) => {
    const card = document.createElement("li");
    card.className = "archive-search-result";
    const meta = textElement(
      "p",
      "archive-result-meta",
      `${formatDate(result.issueDate)} · ${result.sourceName}`,
    );
    const heading = document.createElement("h3");
    const link = document.createElement("a");
    link.href = `detail.html?date=${encodeURIComponent(result.issueDate)}&id=${encodeURIComponent(result.id)}`;
    link.textContent = result.title;
    heading.append(link);
    const topics = textElement(
      "p",
      "archive-result-topics",
      result.topics.length > 0 ? result.topics.join(" · ") : "主题未提供",
    );
    const snippet = textElement("p", "archive-result-snippet", result.snippet);
    card.append(meta, heading, topics, snippet);
    return card;
  });
  setChildren(elements["archive-search-results"], cards);
  elements["archive-search-count"].textContent = `${shaped.length} 条结果`;
  return shaped.length;
}

async function performArchiveSearch() {
  const path = archiveSearchPath(elements["archive-search-input"].value);
  if (!path) {
    archiveSearchController?.abort();
    archiveSearchController = null;
    renderArchiveSearchResults([]);
    elements["archive-search-status"].textContent = "输入关键词，搜索所有往期日报。";
    return;
  }

  archiveSearchController?.abort();
  const controller = new AbortController();
  archiveSearchController = controller;
  elements["archive-search-results"].setAttribute("aria-busy", "true");
  elements["archive-search-status"].textContent = "正在搜索…";
  try {
    const body = await apiJson(path, { signal: controller.signal });
    if (archiveSearchController !== controller) return;
    const count = renderArchiveSearchResults(body.results);
    elements["archive-search-status"].textContent = count > 0
      ? `搜索完成，找到 ${count} 条内容。`
      : "没有找到匹配内容，请尝试更短的关键词。";
  } catch (error) {
    if (error.name !== "AbortError") {
      renderArchiveSearchResults([]);
      elements["archive-search-status"].textContent = `搜索失败：${error.message}`;
    }
  } finally {
    if (archiveSearchController === controller) {
      archiveSearchController = null;
      elements["archive-search-results"].removeAttribute("aria-busy");
    }
  }
}

function setupArchiveSearch() {
  elements["archive-search-open"].addEventListener("click", () => {
    elements["archive-search-dialog"].showModal();
    elements["archive-search-input"].focus();
  });
  elements["archive-search-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(archiveSearchTimer);
    performArchiveSearch();
  });
  elements["archive-search-input"].addEventListener("input", () => {
    clearTimeout(archiveSearchTimer);
    archiveSearchTimer = setTimeout(performArchiveSearch, 250);
  });
  elements["archive-search-dialog"].addEventListener("close", () => {
    clearTimeout(archiveSearchTimer);
    archiveSearchController?.abort();
    archiveSearchController = null;
    elements["archive-search-results"].removeAttribute("aria-busy");
  });
}

function makeNewsCard(item, index) {
  const card = document.createElement("li");
  card.className = "news-card";

  const score = document.createElement("div");
  score.className = "score-block";
  const ranking = personalizedScore(item, app.profile);
  const totalScore = Number.isFinite(ranking.total) ? ranking.total : null;
  score.setAttribute(
    "aria-label",
    totalScore === null
      ? "推荐分本期未提供"
      : `推荐分 ${totalScore} 分，编辑评分 ${ranking.editorial} 分，兴趣调整 ${ranking.personalizedBoost} 分`,
  );
  score.append(
    textElement("strong", "score-number", totalScore === null ? "—" : String(totalScore)),
    textElement("span", "score-denominator", "/ 100"),
  );

  const content = document.createElement("article");
  content.className = "news-card-content";
  const badgeRow = document.createElement("div");
  badgeRow.className = "chip-row";
  badgeRow.append(
    makeChip(
      itemTimingLabel(item, app.issue.status),
      item.isBackfill ? "chip-backfill" : "chip-yesterday",
    ),
    makeChip(item.contentType === "learning" ? "技术学习" : "新闻事件", "chip-kind"),
    makeChip(
      item.priority ?? "关注",
      `chip-priority ${item.priority === "必读" ? "chip-priority-high" : ""}`,
    ),
    makeChip(item.region ?? "全球", "chip-region"),
    ...(item.learningTrack
      ? [makeChip(`${item.learningTrack.topic} · 第 ${item.learningTrack.part}/${item.learningTrack.total} 讲`, "chip-learning")]
      : []),
    ...(item.followUpSeries
      ? [makeChip(`${item.followUpSeries.title} · ${item.followUpSeries.stage}`, "chip-followup")]
      : []),
    ...(item.modelComparison ? [makeChip("模型对比", "chip-model")] : []),
    ...(Array.isArray(item.topics) ? item.topics : []).map((topic) =>
      makeChip(topic, "chip-topic"),
    ),
  );

  const heading = document.createElement("h3");
  const link = document.createElement("a");
  const versionParam = app.version ? `&version=${app.version}` : "";
  link.href = `detail.html?date=${encodeURIComponent(app.issue.date)}&id=${encodeURIComponent(item.id)}&sort=${encodeURIComponent(app.view.sort)}${versionParam}`;
  link.textContent = item.title;
  link.addEventListener("click", () => {
    writeStoredJson(localStorage, STORAGE_KEYS.scrollPosition, window.scrollY);
  });
  heading.append(link);

  const meta = textElement(
    "p",
    "card-meta",
    `${formatDate(item.publishedDate)} · ${item.source?.name ?? "本期未提供"} · 第 ${index + 1} 条`,
  );
  const scoreExplanation = textElement(
    "p",
    "score-explanation",
    `编辑 ${ranking.editorial} · 兴趣 ${ranking.personalizedBoost >= 0 ? "+" : ""}${ranking.personalizedBoost} · 推荐 ${ranking.total}`,
  );
  const value = textElement(
    "p",
    "one-line-value",
    item.oneLineValue || "本期未提供",
  );
  content.append(badgeRow, heading, meta, scoreExplanation, value, makeInterestControls(item.id));
  card.append(score, content);
  return card;
}

function activeFilterSummary() {
  const count =
    app.view.sections.length +
    app.view.contentTypes.length +
    app.view.regions.length +
    app.view.priorities.length +
    app.view.topics.length +
    app.view.sourceTypes.length +
    app.view.feedbackStates.length +
    (app.view.search ? 1 : 0) +
    (app.view.minScore > 0 ? 1 : 0);
  return count === 0 ? "当前没有额外筛选。" : `当前启用了 ${count} 个筛选条件。`;
}

function renderList() {
  const visibleItems = sortItems(
    filterItems(app.issue.items, app.view, app.feedback, { articleSignals: app.interestSignals }),
    app.view.sort,
    app.profile,
  );
  elements["result-count"].textContent = `${visibleItems.length} / ${app.issue.items.length} 条`;
  elements["empty-state"].hidden = visibleItems.length > 0;
  elements["news-list"].hidden = visibleItems.length === 0;
  elements["empty-summary"].textContent = activeFilterSummary();
  setChildren(
    elements["news-list"],
    visibleItems.map((item, index) => makeNewsCard(item, index)),
  );
}

function renderIssueMeta(issue) {
  const currentCount = issue.items.filter((item) => !item.isBackfill).length;
  const backfillCount = issue.items.length - currentCount;
  const learningCount = issue.items.filter((item) => item.contentType === "learning").length;
  const tracking = issue.status === "tracking";
  elements["issue-date-label"].textContent = `${tracking ? "今日追踪 · 进行中" : "日报定稿"} · ${formatDate(issue.date)}`;
  elements["issue-counts"].textContent = `${issue.items.length} 条 · ${tracking ? "今日新增" : "当日"} ${currentCount} · ${tracking ? "热点跟进" : "回溯"} ${backfillCount} · 技术学习 ${learningCount}`;
  elements["issue-reading"].textContent = `约 ${issue.readingMinutes} 分钟`;
  elements["issue-generated"].textContent = tracking && issue.updatedAt
    ? `${formatDateTime(issue.updatedAt)} 更新`
    : `${formatDate(issue.generatedAt)} 生成`;
}

function hideError() {
  elements["load-error"].hidden = true;
}

function renderError(error, fallbackDate) {
  elements["load-error"].hidden = false;
  elements["error-message"].textContent = error.message || "发生未知错误。";
  elements["fallback-button"].hidden = !fallbackDate;
  elements["fallback-button"].dataset.date = fallbackDate || "";
  elements["result-count"].textContent = "读取失败";
}

function populateDates() {
  const options = app.manifest.issues.map((issue) => {
    const option = document.createElement("option");
    option.value = issue.date;
    option.textContent = `${formatDate(issue.date)} · ${issue.status === "tracking" ? "进行中" : "已定稿"} · ${issue.itemCount} 条`;
    return option;
  });
  setChildren(elements["issue-date"], options);
}

function renderIssueNavigation() {
  const navigation = buildIssueNavigation(app.manifest.issues);
  const setShortcut = (element, issue, label) => {
    element.hidden = !issue;
    if (!issue) return;
    element.href = `index.html?date=${encodeURIComponent(issue.date)}`;
    element.textContent = `${label} · ${formatDate(issue.date)} · ${issue.itemCount} 条`;
    if (issue.date === app.view?.date) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  };
  setShortcut(elements["today-link"], navigation.today, "今天");
  setShortcut(elements["yesterday-link"], navigation.yesterday, "昨天");
  setChildren(
    elements["archive-links"],
    navigation.archive.map((issue) => {
      const link = textElement("a", "issue-shortcut archive-shortcut", formatDate(issue.date));
      link.href = `index.html?date=${encodeURIComponent(issue.date)}`;
      if (issue.date === app.view?.date) link.setAttribute("aria-current", "page");
      return link;
    }),
  );
  elements["archive-links"].prepend(textElement("span", "archive-label", "往期"));
}

async function loadIssue(date) {
  const issueRef = app.manifest.issues.find((entry) => entry.date === date);
  if (!issueRef) throw new Error(`找不到 ${date} 的日报。`);
  const issue = await loadJson(`data/${versionFileForEntry(issueRef, app.version)}`);
  app.issue = issue;
  app.view.date = issue.date;
  renderIssueNavigation();
  renderFilters(issue.items);
  writeControls();
  renderIssueMeta(issue);
  renderSummary(issue);
  renderList();
  persistView();
  hideError();
}

async function loadMetricIds() {
  const results = await Promise.allSettled(
    app.manifest.issues.map((issue) => loadJson(`data/${issue.file}`)),
  );
  app.historyLoadFailed = results.some((result) => result.status === "rejected");
  app.allItemIds = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value.items.map((item) => item.id) : [],
  );
  if (app.allItemIds.length === 0 && app.issue) {
    app.allItemIds = app.issue.items.map((item) => item.id);
  }
  renderMetrics();
}

function clearFilters() {
  app.manualSort = null;
  app.explicitSort = false;
  try {
    localStorage.removeItem(STORAGE_KEYS.sortPreference);
  } catch {
    // Sorting still resets for this page when storage is unavailable.
  }
  app.view = defaultViewState(app.issue.date);
  if (app.profile.evidenceCount > 0) app.view.sort = "personalized";
  writeControls();
  persistView();
  writeStoredJson(localStorage, STORAGE_KEYS.scrollPosition, 0);
  window.scrollTo(0, 0);
  renderList();
}

function setupSummary() {
  const stored = readStoredJson(localStorage, STORAGE_KEYS.summaryCollapsed, false);
  const collapsed = typeof stored === "boolean" ? stored : false;
  if (typeof stored !== "boolean") localStorage.removeItem(STORAGE_KEYS.summaryCollapsed);
  elements["summary-content"].hidden = collapsed;
  elements["summary-toggle"].setAttribute("aria-expanded", String(!collapsed));
  elements["summary-toggle"].textContent = collapsed ? "展开" : "收起";
}

function setupMobileFilter() {
  const mobile = window.matchMedia("(max-width: 899px)");
  const applyViewport = () => {
    if (mobile.matches) {
      elements["filter-panel"].hidden =
        elements["filter-toggle"].getAttribute("aria-expanded") !== "true";
    } else {
      elements["filter-panel"].hidden = false;
    }
  };
  mobile.addEventListener("change", applyViewport);
  applyViewport();
}

async function initialize() {
  setupSummary();
  setupMobileFilter();
  setupArchiveSearch();
  const storedFeedback = readStoredJson(localStorage, STORAGE_KEYS.feedback, {});
  app.feedback = safeObject(storedFeedback);
  if (app.feedback !== storedFeedback) localStorage.removeItem(STORAGE_KEYS.feedback);
  app.interestSignals = normalizeInterestStore(
    readStoredJson(localStorage, STORAGE_KEYS.interestSignals, null)
      ?? Object.fromEntries(legacySignalEntries(app.feedback).map(({ articleId, signals }) => [articleId, signals])),
  );
  const storedSortPreference = readStoredJson(
    localStorage,
    STORAGE_KEYS.sortPreference,
    null,
  );
  app.manualSort = typeof storedSortPreference === "string"
    ? storedSortPreference
    : null;

  try {
    try {
      const profileResult = await apiJson("/api/profile");
      applyServerProfile(profileResult.profile);
    } catch {
      app.profile = { topics: {}, depth: 0, angles: {}, evidenceCount: 0 };
    }
    await migrateLegacyFeedback();
    app.manifest = await loadManifest();
    populateDates();
    const storedView = readStoredJson(localStorage, STORAGE_KEYS.viewState, null);
    const params = new URLSearchParams(location.search);
    const requestedVersion = Number(params.get("version"));
    app.version = Number.isInteger(requestedVersion) && requestedVersion > 0 ? requestedVersion : null;
    app.view = resolveViewState(
      params,
      safeObject(storedView),
      app.manifest.issues.map((issue) => issue.date),
    );
    app.explicitSort = explicitSortParam(params) !== null;
    app.view.sort = choosePersonalizedSort(
      app.view.sort,
      app.profile,
      app.manualSort,
      app.explicitSort,
    );
    renderIssueNavigation();
    await loadIssue(app.view.date);
    await loadMetricIds();
    await initializeDailyGeneration();
    const savedPosition = readStoredJson(localStorage, STORAGE_KEYS.scrollPosition, 0);
    if (typeof savedPosition !== "number") {
      localStorage.removeItem(STORAGE_KEYS.scrollPosition);
      return;
    }
    requestAnimationFrame(() => window.scrollTo(0, savedPosition));
  } catch (error) {
    renderError(error);
  }
}

elements["filter-panel"].addEventListener("input", async (event) => {
  if (!app.issue) return;
  if (event.target === elements["issue-date"]) return;
  if (event.target === elements["sort-select"]) {
    app.explicitSort = false;
    app.manualSort = elements["sort-select"].value;
    writeStoredJson(localStorage, STORAGE_KEYS.sortPreference, app.manualSort);
  }
  app.view = readControls();
  writeControls();
  persistView();
  writeStoredJson(localStorage, STORAGE_KEYS.scrollPosition, 0);
  renderList();
});

elements["issue-date"].addEventListener("change", async () => {
  if (!app.manifest) return;
  app.view = readControls();
  app.version = null;
  writeStoredJson(localStorage, STORAGE_KEYS.scrollPosition, 0);
  try {
    await loadIssue(elements["issue-date"].value);
    window.scrollTo(0, 0);
  } catch (error) {
    const fallback = app.manifest.issues.find(
      (entry) => entry.date !== elements["issue-date"].value,
    )?.date;
    renderError(error, fallback);
  }
});

elements["summary-toggle"].addEventListener("click", () => {
  const collapsed = !elements["summary-content"].hidden;
  elements["summary-content"].hidden = collapsed;
  elements["summary-toggle"].setAttribute("aria-expanded", String(!collapsed));
  elements["summary-toggle"].textContent = collapsed ? "展开" : "收起";
  writeStoredJson(localStorage, STORAGE_KEYS.summaryCollapsed, collapsed);
});

elements["filter-toggle"].addEventListener("click", () => {
  const expanded = elements["filter-toggle"].getAttribute("aria-expanded") === "true";
  elements["filter-toggle"].setAttribute("aria-expanded", String(!expanded));
  elements["filter-panel"].hidden = expanded;
});

elements["clear-filters"].addEventListener("click", clearFilters);
elements["empty-clear"].addEventListener("click", clearFilters);

elements["retry-button"].addEventListener("click", async () => {
  hideError();
  if (!app.manifest) {
    location.reload();
    return;
  }
  try {
    await loadIssue(app.view.date);
  } catch (error) {
    const fallback = app.manifest.issues.find((entry) => entry.date !== app.view.date)?.date;
    renderError(error, fallback);
  }
});

elements["fallback-button"].addEventListener("click", async () => {
  const date = elements["fallback-button"].dataset.date;
  if (!date) return;
  try {
    await loadIssue(date);
  } catch (error) {
    renderError(error);
  }
});

mountLearningAgent({ container: document.getElementById("learning-agent-root") });
initialize();
