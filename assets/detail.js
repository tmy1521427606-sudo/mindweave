import {
  apiJson,
  choosePersonalizedSort,
  createSerialTaskQueue,
  defaultViewState,
  explicitSortParam,
  getDetailOrder,
  loadJson,
  itemTimingLabel,
  migrateLegacySignals,
  personalizedScore,
  readStoredJson,
  resolveViewState,
  sortItems,
  SORTS,
  STORAGE_KEYS,
  toggleFeedback,
  toggleInterestSignal,
  viewStateToParams,
  writeStoredJson,
} from "./shared.js";
import { mountLearningAgent } from "./agent.js";

const interestNames = {
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

const scoreLabels = {
  interest: ["兴趣匹配", 30],
  impact: ["实际影响", 20],
  source: ["来源可信", 20],
  novelty: ["新颖度", 15],
  crossDomain: ["跨领域连接", 10],
  actionability: ["可行动性", 5],
};

const feedbackNames = {
  useful: "有用",
  known: "已知",
  tooShallow: "太浅",
  tooDeep: "太深",
  irrelevant: "无关",
  follow: "想追踪",
};

const elements = Object.fromEntries(
  [
    "back-link",
    "detail-error",
    "detail-error-message",
    "article",
    "detail-topics",
    "detail-title",
    "detail-value",
    "detail-date",
    "detail-source",
    "detail-score",
    "detail-fact",
    "background-section",
    "detail-background",
    "development-section",
    "detail-development",
    "impact-section",
    "detail-impact",
    "source-view-section",
    "detail-source-view",
    "follow-up-section",
    "detail-follow-up",
    "model-comparison-section",
    "model-comparison-note",
    "model-comparison-body",
    "model-comparison-verdict",
    "detail-relevance",
    "detail-concepts",
    "detail-connections",
    "detail-uncertainty",
    "detail-action",
    "score-total",
    "score-breakdown",
    "source-description",
    "source-link",
    "feedback-status",
    "interest-status",
    "top-previous-link",
    "top-previous-boundary",
    "top-next-link",
    "top-next-boundary",
    "previous-link",
    "previous-boundary",
    "next-link",
    "next-boundary",
  ].map((id) => [id, document.getElementById(id)]),
);

let currentItem = null;
let currentIssue = null;
let feedbackById = {};
let interestById = {};
let profile = { topics: {}, depth: 0, angles: {}, evidenceCount: 0 };
let currentViewState = null;
let manualSort = null;
let inboundExplicitSort = false;

function updateBackLink() {
  if (!currentViewState) return;
  const params = viewStateToParams(currentViewState, {
    includeSort: inboundExplicitSort || SORTS.includes(manualSort),
  });
  elements["back-link"].href = `index.html?${params}`;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeInterestStore(value) {
  return Object.fromEntries(
    Object.entries(safeObject(value)).map(([articleId, signals]) => [
      articleId,
      [...new Set(
        (Array.isArray(signals) ? signals : []).filter((signal) =>
          Object.hasOwn(interestNames, signal),
        ),
      )],
    ]),
  );
}

function currentInterestSignals() {
  return currentItem ? interestById[currentItem.id] ?? [] : [];
}

function renderInterest() {
  const selected = new Set(currentInterestSignals());
  for (const button of document.querySelectorAll("[data-interest-signal]")) {
    button.setAttribute(
      "aria-pressed",
      String(selected.has(button.dataset.interestSignal)),
    );
  }
}

function setInterestButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll("[data-interest-signal]")) {
    button.disabled = disabled;
  }
}

function applyServerProfile(value) {
  profile = safeObject(value);
  interestById = normalizeInterestStore(profile.articleSignals);
  writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, interestById);
}

function renderPersonalizedTotal(item) {
  const ranking = personalizedScore(item, profile);
  elements["detail-score"].textContent =
    `推荐分：${ranking.total}（编辑 ${ranking.editorial}，兴趣 ${ranking.personalizedBoost >= 0 ? "+" : ""}${ranking.personalizedBoost}）`;
}

async function commitInterestSignal(signal) {
  if (!currentItem) return;
  const previous = currentInterestSignals();
  const next = toggleInterestSignal(previous, signal);
  const enabled = next.includes(signal);
  interestById[currentItem.id] = next;
  writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, interestById);
  renderInterest();
  elements["interest-status"].textContent = "正在保存兴趣设置…";
  try {
    const result = await apiJson(
      `/api/articles/${encodeURIComponent(currentItem.id)}/signals/${encodeURIComponent(signal)}`,
      { method: enabled ? "PUT" : "DELETE" },
    );
    applyServerProfile(result.profile);
    if (currentViewState) {
      currentViewState.sort = choosePersonalizedSort(
        currentViewState.sort,
        profile,
        manualSort,
        inboundExplicitSort,
      );
      writeStoredJson(localStorage, STORAGE_KEYS.viewState, currentViewState);
      updateBackLink();
      if (currentIssue) renderNavigation(currentIssue, currentViewState);
    }
    renderPersonalizedTotal(currentItem);
    elements["interest-status"].textContent = enabled
      ? `已启用：${interestNames[signal]}`
      : `已取消：${interestNames[signal]}`;
  } catch (error) {
    interestById[currentItem.id] = previous;
    writeStoredJson(localStorage, STORAGE_KEYS.interestSignals, interestById);
    renderInterest();
    elements["interest-status"].textContent = `保存失败，已恢复原设置。${error.message}`;
  }
}

const enqueueInterestUpdate = createSerialTaskQueue(commitInterestSignal);

function updateInterestSignal(signal) {
  setInterestButtonsDisabled(true);
  return enqueueInterestUpdate(signal).finally(() => setInterestButtonsDisabled(false));
}

async function migrateLegacyFeedback() {
  if (readStoredJson(localStorage, STORAGE_KEYS.signalsMigrated, false) === true) return;
  const result = await migrateLegacySignals(feedbackById, async (articleId, signal) => {
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

function availableText(value) {
  return typeof value === "string" && value.trim() ? value : "本期未提供";
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

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderError(message) {
  elements.article.hidden = true;
  elements["detail-error"].hidden = false;
  elements["detail-error-message"].textContent = message;
  document.title = "内容不存在｜知脉 MindWeave";
}

function renderTopics(item, issueStatus) {
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const chips = [
    textElement(
      "span",
      `chip ${item.isBackfill ? "chip-backfill" : "chip-yesterday"}`,
      itemTimingLabel(item, issueStatus),
    ),
    textElement("span", "chip chip-kind", item.contentType === "learning" ? "技术学习" : "新闻事件"),
    textElement("span", `chip chip-priority ${item.priority === "必读" ? "chip-priority-high" : ""}`, item.priority ?? "关注"),
    textElement("span", "chip chip-region", item.region ?? "全球"),
    ...(item.learningTrack
      ? [textElement("span", "chip chip-learning", `${item.learningTrack.topic} · 第 ${item.learningTrack.part}/${item.learningTrack.total} 讲`)]
      : []),
    ...(item.followUpSeries
      ? [textElement("span", "chip chip-followup", `${item.followUpSeries.title} · ${item.followUpSeries.stage}`)]
      : []),
    ...(item.modelComparison
      ? [textElement("span", "chip chip-model", "模型对比")]
      : []),
    ...topics.map((topic) => textElement("span", "chip chip-topic", topic)),
  ];
  elements["detail-topics"].replaceChildren(...chips);
}

function renderFollowUp(item) {
  const series = item.followUpSeries;
  elements["follow-up-section"].hidden = !series;
  elements["detail-follow-up"].textContent = series
    ? `${series.title}｜当前阶段：${series.stage}。${series.newInformation}`
    : "";
}

function renderModelComparison(item) {
  const comparison = item.modelComparison;
  elements["model-comparison-section"].hidden = !comparison;
  if (!comparison) {
    elements["model-comparison-body"].replaceChildren();
    return;
  }
  const comparabilityNames = {
    comparable: "测试口径可比",
    partial: "仅部分口径可比",
    "not-comparable": "测试口径不可直接比较",
  };
  elements["model-comparison-note"].textContent = comparabilityNames[comparison.comparability];
  const rows = comparison.dimensions.map((dimension) => {
    const row = document.createElement("tr");
    for (const value of [dimension.name, dimension.current, dimension.comparison, dimension.evidence]) {
      row.append(textElement("td", "", availableText(value)));
    }
    return row;
  });
  elements["model-comparison-body"].replaceChildren(...rows);
  elements["model-comparison-verdict"].textContent = availableText(comparison.verdict);
}

function renderConcepts(concepts) {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    elements["detail-concepts"].replaceChildren(
      textElement("dd", "concept-explanation", "本期未提供"),
    );
    return;
  }
  const nodes = concepts.flatMap((concept) => [
    textElement("dt", "concept-name", availableText(concept.name)),
    textElement("dd", "concept-explanation", availableText(concept.explanation)),
  ]);
  elements["detail-concepts"].replaceChildren(...nodes);
}

function renderArticleContext(item) {
  const background = typeof item.background === "string" ? item.background.trim() : "";
  elements["background-section"].hidden = !background;
  elements["detail-background"].textContent = background;

  const development = Array.isArray(item.development)
    ? item.development.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  elements["development-section"].hidden = development.length === 0;
  elements["detail-development"].replaceChildren(
    ...development.map((entry) => textElement("li", "", entry)),
  );

  const impact = Array.isArray(item.impact)
    ? item.impact.filter(
        (row) =>
          row &&
          typeof row.audience === "string" &&
          row.audience.trim() &&
          typeof row.text === "string" &&
          row.text.trim(),
      )
    : [];
  elements["impact-section"].hidden = impact.length === 0;
  elements["detail-impact"].replaceChildren(
    ...impact.flatMap((row) => [
      textElement("dt", "impact-audience", row.audience),
      textElement("dd", "impact-text", row.text),
    ]),
  );
}

function renderScores(score) {
  const values = score && typeof score === "object" ? score : {};
  elements["score-total"].textContent = Number.isFinite(values.total)
    ? `${values.total} / 100`
    : "本期未提供";
  const rows = Object.entries(scoreLabels).map(([key, [label, maximum]]) => {
    const value = Number.isFinite(values[key]) ? values[key] : null;
    const row = document.createElement("div");
    row.className = "score-row";
    const labelRow = document.createElement("div");
    labelRow.className = "score-row-label";
    labelRow.append(
      textElement("span", "", label),
      textElement("strong", "", value === null ? "本期未提供" : `${value} / ${maximum}`),
    );
    const track = document.createElement("div");
    track.className = "score-track";
    track.setAttribute("role", "meter");
    track.setAttribute("aria-label", label);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(maximum));
    track.setAttribute("aria-valuenow", String(value ?? 0));
    const fill = document.createElement("span");
    fill.className = "score-fill";
    fill.style.width = `${((value ?? 0) / maximum) * 100}%`;
    track.append(fill);
    row.append(labelRow, track);
    return row;
  });
  elements["score-breakdown"].replaceChildren(...rows);
}

function currentTags() {
  const tags = feedbackById[currentItem.id]?.tags;
  return Array.isArray(tags) ? tags : [];
}

function renderFeedback() {
  const selected = new Set(currentTags());
  for (const button of document.querySelectorAll("[data-feedback]")) {
    button.setAttribute("aria-pressed", String(selected.has(button.dataset.feedback)));
  }
}

function detailHref(date, id, sort) {
  return `detail.html?date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}&sort=${encodeURIComponent(sort)}`;
}

function setNeighbor(direction, item, date, sort) {
  for (const prefix of ["top-", ""]) {
    const link = elements[`${prefix}${direction}-link`];
    const boundary = elements[`${prefix}${direction}-boundary`];
    if (!item) {
      link.hidden = true;
      link.removeAttribute("href");
      link.textContent = "";
      boundary.hidden = false;
      continue;
    }
    link.hidden = false;
    link.href = detailHref(date, item.id, sort);
    link.textContent = availableText(item.title);
    boundary.hidden = true;
  }
}

function renderNavigation(issue, viewState) {
  let order = getDetailOrder(issue.items, viewState, feedbackById, profile);
  let index = order.findIndex((item) => item.id === currentItem.id);
  if (index === -1) {
    order = sortItems(issue.items, "scoreDesc");
    index = order.findIndex((item) => item.id === currentItem.id);
  }
  setNeighbor("previous", index > 0 ? order[index - 1] : null, issue.date, viewState.sort);
  setNeighbor("next", index < order.length - 1 ? order[index + 1] : null, issue.date, viewState.sort);
}

function renderItem(issue, item, viewState) {
  currentIssue = issue;
  currentItem = item;
  const title = availableText(item.title);
  document.title = `${title}｜知脉 MindWeave`;
  elements["detail-error"].hidden = true;
  elements.article.hidden = false;
  renderTopics(item, issue.status);
  elements["detail-title"].textContent = title;
  elements["detail-value"].textContent = availableText(item.oneLineValue);
  elements["detail-date"].textContent = `${item.isBackfill ? "回溯日期" : "发布日期"}：${formatDate(item.publishedDate)}`;
  elements["detail-source"].textContent = `来源：${availableText(item.source?.name)}`;
  renderPersonalizedTotal(item);
  elements["detail-fact"].textContent = availableText(item.fact);
  renderArticleContext(item);
  elements["source-view-section"].hidden = item.sourceView === null;
  elements["detail-source-view"].textContent = availableText(item.sourceView);
  renderFollowUp(item);
  renderModelComparison(item);
  elements["detail-relevance"].textContent = availableText(item.relevance);
  renderConcepts(item.concepts);
  elements["detail-connections"].textContent = availableText(item.connections);
  elements["detail-uncertainty"].textContent = availableText(item.uncertainty);
  elements["detail-action"].textContent = availableText(item.action);
  renderScores(item.score);
  elements["source-description"].textContent = `${availableText(item.source?.name)} · ${availableText(item.source?.type)}`;

  let sourceUrl;
  try {
    sourceUrl = new URL(item.source?.url);
  } catch {
    sourceUrl = null;
  }
  if (!sourceUrl || sourceUrl.protocol !== "https:") {
    elements["source-link"].removeAttribute("href");
    elements["source-link"].textContent = "原始来源地址无效";
    elements["source-link"].setAttribute("aria-disabled", "true");
  } else {
    elements["source-link"].href = sourceUrl.href;
    elements["source-link"].textContent = "打开一手来源 ↗";
    elements["source-link"].removeAttribute("aria-disabled");
  }

  renderFeedback();
  renderInterest();
  renderNavigation(issue, viewState);
}

async function initialize() {
  const params = new URLSearchParams(location.search);
  const date = params.get("date");
  const id = params.get("id");
  if (!date || !id) {
    renderError("链接缺少日报日期或新闻 ID。");
    return;
  }

  try {
    const storedFeedback = readStoredJson(localStorage, STORAGE_KEYS.feedback, {});
    feedbackById = safeObject(storedFeedback);
    if (feedbackById !== storedFeedback) localStorage.removeItem(STORAGE_KEYS.feedback);
    interestById = normalizeInterestStore(
      readStoredJson(localStorage, STORAGE_KEYS.interestSignals, {}),
    );
    const storedSortPreference = readStoredJson(
      localStorage,
      STORAGE_KEYS.sortPreference,
      null,
    );
    manualSort = typeof storedSortPreference === "string"
      ? storedSortPreference
      : null;
    try {
      const profileResult = await apiJson("/api/profile");
      applyServerProfile(profileResult.profile);
    } catch {
      profile = { topics: {}, depth: 0, angles: {}, evidenceCount: 0 };
    }
    await migrateLegacyFeedback();

    const manifest = await loadJson("data/index.json");
    const issueRef = manifest.issues.find((entry) => entry.date === date);
    if (!issueRef) {
      renderError(`找不到 ${date} 的日报。`);
      return;
    }
    const issue = await loadJson(`data/${issueRef.file}`);
    const item = issue.items.find((entry) => entry.id === id);
    if (!item) {
      renderError("这期日报中没有找到对应内容。");
      return;
    }

    const storedView = readStoredJson(localStorage, STORAGE_KEYS.viewState, null);
    const storedObject = safeObject(storedView);
    const viewState = resolveViewState(
      params,
      storedObject.date === issue.date
        ? storedObject
        : defaultViewState(issue.date),
      [issue.date],
    );
    inboundExplicitSort = explicitSortParam(params) !== null;
    viewState.sort = choosePersonalizedSort(
      viewState.sort,
      profile,
      manualSort,
      inboundExplicitSort,
    );
    currentViewState = viewState;
    updateBackLink();
    renderItem(issue, item, viewState);
    mountLearningAgent({
      container: document.getElementById("learning-agent-root"),
      articleId: item.id,
    });
  } catch (error) {
    renderError(error.message || "日报读取失败，请返回后重试。");
  }
}

for (const button of document.querySelectorAll("[data-interest-signal]")) {
  button.addEventListener("click", () => updateInterestSignal(button.dataset.interestSignal));
}

for (const button of document.querySelectorAll("[data-feedback]")) {
  button.addEventListener("click", () => {
    if (!currentItem) return;
    const tag = button.dataset.feedback;
    const nextTags = toggleFeedback(currentTags(), tag);
    feedbackById[currentItem.id] = {
      tags: nextTags,
      updatedAt: new Date().toISOString(),
    };
    const saved = writeStoredJson(
      localStorage,
      STORAGE_KEYS.feedback,
      feedbackById,
    );
    renderFeedback();
    elements["feedback-status"].textContent = saved
      ? nextTags.includes(tag)
        ? `已标记：${feedbackNames[tag]}`
        : `已取消：${feedbackNames[tag]}`
      : "当前浏览器阻止了本地保存，本次反馈仅在页面关闭前有效。";
  });
}

initialize();
