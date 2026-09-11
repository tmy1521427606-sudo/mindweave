import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import * as shared from "../assets/shared.js";
import {
  apiJson,
  archiveSearchPath,
  archiveSearchResult,
  calculateFeedbackMetrics,
  choosePersonalizedSort,
  createSerialTaskQueue,
  buildIssueNavigation,
  defaultViewState,
  explicitSortParam,
  filterItems,
  getDetailOrder,
  legacySignalEntries,
  migrateLegacySignals,
  readStoredJson,
  resolveViewState,
  sortItems,
  toggleFeedback,
  toggleInterestSignal,
  itemTimingLabel,
  issueDateLabel,
  personalizedScore,
  viewStateToParams,
  writeStoredJson,
} from "../assets/shared.js";
import { contentType, createStaticServer, resolveStaticPath } from "../server.mjs";

const items = [
  {
    id: "a",
    title: "购物 Agent 协议更新",
    publishedDate: "2026-09-03",
    isBackfill: true,
    topics: ["电商 × Agent"],
    contentType: "news",
    region: "海外",
    priority: "关注",
    source: { type: "官方开源发布" },
    concepts: [{ name: "协议协商" }],
    oneLineValue: "让 Agent 完成交易",
    score: { total: 96 },
  },
  {
    id: "b",
    title: "MCP 安全默认值",
    publishedDate: "2026-09-07",
    isBackfill: false,
    topics: ["数据 × Agent", "Agent 安全"],
    contentType: "learning",
    region: "国内",
    priority: "必读",
    source: { type: "官方开源发布" },
    concepts: [{ name: "OAuth issuer" }],
    oneLineValue: "保护数据连接",
    score: { total: 92 },
  },
];

test("filters use AND across dimensions and OR inside topics", () => {
  const state = {
    ...defaultViewState("2026-09-07"),
    sections: ["yesterday"],
    topics: ["电商 × Agent", "数据 × Agent"],
    sourceTypes: ["官方开源发布"],
    minScore: 90,
  };
  assert.deepEqual(filterItems(items, state, {}).map((item) => item.id), ["b"]);
});

test("filters by content type, region, and priority", () => {
  const state = {
    ...defaultViewState("2026-09-07"),
    contentTypes: ["learning"],
    regions: ["国内"],
    priorities: ["必读"],
  };
  assert.deepEqual(filterItems(items, state, {}).map((item) => item.id), ["b"]);
});

test("search includes concept names and ignores ASCII case", () => {
  const state = { ...defaultViewState("2026-09-07"), search: "OAUTH ISSUER" };
  assert.deepEqual(filterItems(items, state, {}).map((item) => item.id), ["b"]);
});

test("sorts without mutating the original array", () => {
  assert.deepEqual(sortItems(items, "scoreDesc").map((item) => item.id), ["a", "b"]);
  assert.deepEqual(sortItems(items, "dateDesc").map((item) => item.id), ["b", "a"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b"]);
});

test("feedback removes only its mutually exclusive counterpart", () => {
  assert.deepEqual(toggleFeedback(["irrelevant", "follow"], "useful"), ["follow", "useful"]);
  assert.deepEqual(toggleFeedback(["tooDeep", "known"], "tooShallow"), ["known", "tooShallow"]);
  assert.deepEqual(toggleFeedback(["known"], "known"), []);
});

test("feedback metrics distinguish coverage from label rates", () => {
  const metrics = calculateFeedbackMetrics(["a", "b", "c"], {
    a: { tags: ["useful", "follow"] },
    b: { tags: ["known"] },
    orphan: { tags: ["irrelevant"] },
  });
  assert.equal(metrics.feedbackCount, 2);
  assert.equal(metrics.coverage, 2 / 3);
  assert.equal(metrics.rates.useful, 1 / 2);
  assert.equal(metrics.rates.follow, 1 / 2);
  assert.equal(metrics.rates.irrelevant, 0);
});

test("zero feedback reports null rates", () => {
  const metrics = calculateFeedbackMetrics(["a"], {});
  assert.equal(metrics.coverage, 0);
  assert.equal(metrics.rates.useful, null);
});

test("corrupt local storage deletes only the requested key", () => {
  const values = new Map([["bad", "{"], ["keep", "42"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };
  assert.deepEqual(readStoredJson(storage, "bad", { safe: true }), { safe: true });
  assert.equal(values.has("bad"), false);
  assert.equal(values.get("keep"), "42");
});

test("unavailable local storage falls back without breaking the page", () => {
  const storage = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  assert.deepEqual(readStoredJson(storage, "state", { safe: true }), { safe: true });
  assert.equal(writeStoredJson(storage, "state", { value: 1 }), false);
});

test("missing display fields do not break default filtering and sorting", () => {
  const incomplete = {
    id: "incomplete",
    title: "字段不完整的条目",
    publishedDate: "2026-09-02",
    isBackfill: true,
  };
  const state = defaultViewState("2026-09-07");
  assert.deepEqual(filterItems([incomplete], state, {}).map((item) => item.id), [
    "incomplete",
  ]);
  assert.deepEqual(sortItems([incomplete], "scoreDesc").map((item) => item.id), [
    "incomplete",
  ]);
});

test("URL fields override storage while omitted fields survive", () => {
  const stored = {
    ...defaultViewState("2026-09-06"),
    search: "旧搜索",
    minScore: 70,
  };
  const state = resolveViewState(
    new URLSearchParams(
      "date=2026-09-07&q=OAuth&contentType=learning&region=%E5%9B%BD%E5%86%85&priority=%E5%BF%85%E8%AF%BB&topic=%E6%95%B0%E6%8D%AE%20%C3%97%20Agent",
    ),
    stored,
    ["2026-09-07", "2026-09-06"],
  );
  assert.equal(state.date, "2026-09-07");
  assert.equal(state.search, "OAuth");
  assert.equal(state.minScore, 70);
  assert.deepEqual(state.contentTypes, ["learning"]);
  assert.deepEqual(state.regions, ["国内"]);
  assert.deepEqual(state.priorities, ["必读"]);
  assert.deepEqual(state.topics, ["数据 × Agent"]);
});

test("homepage opens the latest issue instead of a stored older date", () => {
  const stored = { ...defaultViewState("2026-09-07"), search: "Agent" };
  const state = resolveViewState(
    new URLSearchParams(),
    stored,
    ["2026-09-08", "2026-09-07"],
  );
  assert.equal(state.date, "2026-09-08");
  assert.equal(state.search, "Agent");
});

test("issue navigation does not label a stale latest issue as today", () => {
  const navigation = buildIssueNavigation([
    { date: "2026-09-07", status: "final", itemCount: 10 },
    { date: "2026-09-09", status: "tracking", itemCount: 18 },
    { date: "2026-09-08", status: "final", itemCount: 20 },
  ], "2026-09-11");
  assert.equal(navigation.today, null);
  assert.equal(navigation.latest.date, "2026-09-09");
  assert.equal(navigation.previous.date, "2026-09-08");
  assert.deepEqual(navigation.archive.map((issue) => issue.date), ["2026-09-07"]);
});

test("issue navigation exposes an issue as today only on its calendar date", () => {
  const navigation = buildIssueNavigation([
    { date: "2026-09-09", status: "tracking", itemCount: 18 },
    { date: "2026-09-08", status: "final", itemCount: 20 },
  ], "2026-09-09");
  assert.equal(navigation.today.date, "2026-09-09");
  assert.equal(navigation.latest.date, "2026-09-09");
  assert.equal(navigation.previous.date, "2026-09-08");
});

test("stale latest issue uses a recent-issue label instead of a today label", () => {
  assert.equal(issueDateLabel(
    { date: "2026-09-09", status: "tracking" },
    { todayDate: "2026-09-11", latestDate: "2026-09-09" },
  ), "最近一期");
});

test("timing labels distinguish live additions from follow-up material", () => {
  assert.equal(itemTimingLabel({ dateStatus: "unverified", isBackfill: false }, "tracking"), "日期待核验");
  assert.equal(itemTimingLabel({ isBackfill: false }, "tracking"), "今日新增");
  assert.equal(itemTimingLabel({ isBackfill: true }, "tracking"), "热点跟进");
  assert.equal(itemTimingLabel({ isBackfill: false }, "final"), "当日");
  assert.equal(itemTimingLabel({ isBackfill: true }, "final"), "回溯");
});

test("view state serializes multi-select values as repeated parameters", () => {
  const state = {
    ...defaultViewState("2026-09-07"),
    sections: ["yesterday"],
    contentTypes: ["learning"],
    regions: ["国内"],
    priorities: ["必读"],
    topics: ["数据 × Agent", "电商 × Agent"],
    minScore: 80,
    sort: "dateDesc",
  };
  const params = viewStateToParams(state);
  assert.equal(params.get("date"), "2026-09-07");
  assert.deepEqual(params.getAll("contentType"), ["learning"]);
  assert.deepEqual(params.getAll("region"), ["国内"]);
  assert.deepEqual(params.getAll("priority"), ["必读"]);
  assert.deepEqual(params.getAll("topic"), ["数据 × Agent", "电商 × Agent"]);
  assert.equal(params.get("minScore"), "80");
  assert.equal(params.get("sort"), "dateDesc");
  assert.equal(params.has("q"), false);
});

test("implicit default omits sort while manual or inbound explicit state includes it", () => {
  const state = defaultViewState("2026-09-07");
  assert.equal(viewStateToParams(state, { includeSort: false }).has("sort"), false);
  assert.equal(viewStateToParams(state, { includeSort: true }).get("sort"), "scoreDesc");
  assert.equal(explicitSortParam(new URLSearchParams("sort=scoreDesc")), "scoreDesc");
  assert.equal(explicitSortParam(new URLSearchParams("sort=unknown")), null);
});

test("detail order follows the saved filter and sort", () => {
  const state = {
    ...defaultViewState("2026-09-07"),
    minScore: 93,
    sort: "scoreDesc",
  };
  assert.deepEqual(getDetailOrder(items, state, {}).map((item) => item.id), ["a"]);
});

test("personalized score keeps editorial and interest contributions separate", () => {
  const score = personalizedScore(
    { topics: ["Agent 开发"], score: { total: 92 } },
    { topics: { "Agent 开发": 3 } },
  );
  assert.deepEqual(score, { editorial: 92, personalizedBoost: 3, total: 95 });
});

test("archive search encodes reserved characters and skips blank queries", () => {
  assert.equal(
    archiveSearchPath("RAG & Agent"),
    "/api/search?q=RAG%20%26%20Agent&scope=all",
  );
  assert.equal(archiveSearchPath("   "), null);
});

test("archive search result exposes external content only as text fields", () => {
  const result = archiveSearchResult({
    id: "a&1",
    issueDate: "2026-09-07",
    title: "<img src=x onerror=alert(1)>",
    sourceName: "示例来源",
    item: {
      topics: ["Agent", 42],
      oneLineValue: "<mark>命中摘要</mark>",
    },
  });
  assert.deepEqual(result, {
    id: "a&1",
    issueDate: "2026-09-07",
    title: "<img src=x onerror=alert(1)>",
    sourceName: "示例来源",
    topics: ["Agent"],
    snippet: "<mark>命中摘要</mark>",
  });
  assert.equal("html" in result, false);
});

test("API JSON helper preserves caller options and reports API errors", async () => {
  const calls = [];
  const value = await apiJson("/api/profile", { signal: "test-signal" }, async (requestPath, options) => {
    calls.push([requestPath, options]);
    return { ok: true, json: async () => ({ profile: { evidenceCount: 2 } }) };
  });
  assert.equal(value.profile.evidenceCount, 2);
  assert.equal(calls[0][0], "/api/profile");
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].signal, "test-signal");

  await assert.rejects(
    () => apiJson("/api/search?q=x", {}, async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: "搜索暂不可用" } }),
    })),
    /搜索暂不可用/,
  );
});

test("interest selection toggles independently without mutating stored values", () => {
  const selected = ["bookmark", "follow"];
  assert.deepEqual(toggleInterestSignal(selected, "bookmark"), ["follow"]);
  assert.deepEqual(toggleInterestSignal(selected, "moreLikeThis"), [
    "bookmark",
    "follow",
    "moreLikeThis",
  ]);
  assert.deepEqual(selected, ["bookmark", "follow"]);
});

test("topic-preference selections replace each other while other signals stay independent", () => {
  const selected = ["follow", "moreLikeThis"];
  assert.deepEqual(toggleInterestSignal(selected, "lessLikeThis"), ["follow", "lessLikeThis"]);
  assert.deepEqual(toggleInterestSignal(["follow", "lessLikeThis"], "irrelevant"), ["follow", "irrelevant"]);
  assert.deepEqual(toggleInterestSignal(["follow", "irrelevant"], "irrelevant"), ["follow"]);
  assert.deepEqual(selected, ["follow", "moreLikeThis"]);
});

test("browser personalized score caps the separate interest contribution at six", () => {
  assert.deepEqual(
    personalizedScore(
      { topics: ["Agent", "Agent", "Agent"], score: { total: 92 } },
      { topics: { Agent: 3 } },
    ),
    { editorial: 92, personalizedBoost: 6, total: 98 },
  );
});

test("legacy migration includes only overlapping signals one article at a time", () => {
  const feedback = {
    a: { tags: ["tooDeep", "known", "follow"] },
    b: { tags: ["useful", "irrelevant", "tooShallow"] },
  };
  assert.deepEqual(legacySignalEntries(feedback), [
    { articleId: "a", signals: ["known", "follow"] },
    { articleId: "b", signals: ["irrelevant"] },
  ]);
  assert.deepEqual(feedback.a.tags, ["tooDeep", "known", "follow"]);
  assert.deepEqual(feedback.b.tags, ["useful", "irrelevant", "tooShallow"]);
});

test("personalized sorting uses the transparent total while editorial sorting stays distinct", () => {
  const ranked = [
    { id: "editorial", topics: ["neutral"], score: { total: 95 } },
    { id: "personal", topics: ["Agent"], score: { total: 90 } },
  ];
  const profile = { topics: { Agent: 10 }, evidenceCount: 1 };
  assert.deepEqual(sortItems(ranked, "scoreDesc", profile).map((item) => item.id), [
    "editorial",
    "personal",
  ]);
  assert.deepEqual(sortItems(ranked, "personalized", profile).map((item) => item.id), [
    "personal",
    "editorial",
  ]);
});

test("profile evidence selects personalized sort unless the user chose explicitly", () => {
  const profile = { evidenceCount: 1 };
  assert.equal(choosePersonalizedSort("scoreDesc", profile, null), "personalized");
  assert.equal(choosePersonalizedSort("personalized", profile, "scoreDesc"), "scoreDesc");
  assert.equal(choosePersonalizedSort("dateDesc", { evidenceCount: 0 }, null), "dateDesc");
});

test("explicit URL sort overrides stored manual preference and profile evidence", () => {
  assert.equal(
    choosePersonalizedSort("scoreDesc", { evidenceCount: 4 }, "dateDesc", true),
    "scoreDesc",
  );
  assert.equal(
    choosePersonalizedSort("scoreDesc", { evidenceCount: 4 }, "dateDesc", false),
    "dateDesc",
  );
  assert.equal(
    choosePersonalizedSort("scoreDesc", { evidenceCount: 4 }, null, false),
    "personalized",
  );
});

test("detail inbound sort remains above a stored preference", () => {
  const params = new URLSearchParams("date=2026-09-07&id=a&sort=scoreDesc");
  const state = resolveViewState(
    params,
    { ...defaultViewState("2026-09-07"), sort: "dateDesc" },
    ["2026-09-07"],
  );
  assert.equal(
    choosePersonalizedSort(
      state.sort,
      { evidenceCount: 3 },
      "dateDesc",
      explicitSortParam(params) !== null,
    ),
    "scoreDesc",
  );
});

test("detail neighbor links retain scoreDesc above a stale manual preference", async () => {
  const source = await readFile(path.resolve("assets/detail.js"), "utf8");
  const navigationSource = source.slice(
    source.indexOf("function detailHref("),
    source.indexOf("function renderItem("),
  );
  const elements = Object.fromEntries(
    [
      "top-previous-link", "top-previous-boundary", "top-next-link", "top-next-boundary",
      "previous-link", "previous-boundary", "next-link", "next-boundary",
    ]
      .map((id) => [id, {}]),
  );
  const issue = {
    date: "2026-09-07",
    items: [
      { ...items[0], id: "previous&1" },
      items[1],
      { ...items[1], id: "next&2", score: { total: 80 } },
    ],
  };
  const state = defaultViewState(issue.date);
  runInNewContext(`${navigationSource}\nrenderNavigation(issue, state);`, {
    elements,
    issue,
    state,
    currentItem: items[1],
    feedbackById: {},
    profile: { evidenceCount: 3 },
    getDetailOrder,
    sortItems,
    availableText: (text) => text,
  });
  for (const [direction, expectedId] of [["previous", "previous&1"], ["next", "next&2"]]) {
    const url = new URL(elements[`${direction}-link`].href, "https://example.test/");
    assert.equal(url.pathname, "/detail.html");
    assert.equal(url.searchParams.get("date"), "2026-09-07");
    assert.equal(url.searchParams.get("id"), expectedId);
    assert.equal(url.searchParams.get("sort"), "scoreDesc");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["date", "id", "sort"]);
    const nextState = resolveViewState(
      url.searchParams,
      { ...state, sort: "dateDesc" },
      [issue.date],
    );
    assert.equal(choosePersonalizedSort(
      nextState.sort,
      { evidenceCount: 3 },
      "dateDesc",
      explicitSortParam(url.searchParams) !== null,
    ), "scoreDesc");
  }
});

test("top and bottom detail navigation share adjacent articles, URLs, and boundaries", async () => {
  const source = await readFile(path.resolve("assets/detail.js"), "utf8");
  const navigationSource = source.slice(
    source.indexOf("function detailHref("),
    source.indexOf("function renderItem("),
  );
  const elements = Object.fromEntries(
    [
      "top-previous-link", "top-previous-boundary", "top-next-link", "top-next-boundary",
      "previous-link", "previous-boundary", "next-link", "next-boundary",
    ].map((id) => [id, {}]),
  );
  const issue = {
    date: "2026-09-07",
    items: [{ ...items[0], id: "first" }, items[1], { ...items[1], id: "last", score: { total: 80 } }],
  };
  const state = defaultViewState(issue.date);
  runInNewContext(`${navigationSource}\nrenderNavigation(issue, state);`, {
    elements,
    issue,
    state,
    currentItem: items[1],
    feedbackById: {},
    profile: { evidenceCount: 3 },
    getDetailOrder,
    sortItems,
    availableText: (text) => text,
  });
  for (const direction of ["previous", "next"]) {
    const top = new URL(elements[`top-${direction}-link`].href, "https://example.test/");
    const bottom = new URL(elements[`${direction}-link`].href, "https://example.test/");
    assert.equal(top.href, bottom.href);
    assert.deepEqual([...top.searchParams.keys()].sort(), ["date", "id", "sort"]);
    assert.equal(elements[`top-${direction}-boundary`].hidden, true);
    assert.equal(elements[`${direction}-boundary`].hidden, true);
  }
});

test("legacy migration skips missing articles and continues but retries transient failures", async () => {
  const calls = [];
  const complete = await migrateLegacySignals(
    { missing: { tags: ["follow"] }, valid: { tags: ["known"] } },
    async (articleId, signal) => {
      calls.push([articleId, signal]);
      if (articleId === "missing") throw Object.assign(new Error("missing"), { status: 404 });
      return { profile: { articleSignals: { valid: ["known"] } } };
    },
  );
  assert.deepEqual(calls, [["missing", "follow"], ["valid", "known"]]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.lastResult.profile.articleSignals, { valid: ["known"] });

  const transient = await migrateLegacySignals(
    { a: { tags: ["follow"] } },
    async () => { throw Object.assign(new Error("offline"), { status: 503 }); },
  );
  assert.equal(transient.complete, false);
});

test("serial task queue never starts a newer interest write before the old one settles", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const events = [];
  const enqueue = createSerialTaskQueue(async (value) => {
    events.push(`start:${value}`);
    if (value === "first") await firstGate;
    events.push(`end:${value}`);
    return value;
  });
  const first = enqueue("first");
  const second = enqueue("second");
  await Promise.resolve();
  assert.deepEqual(events, ["start:first"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});

test("static path stays inside the site root", () => {
  const root = path.resolve("site-root");
  assert.equal(resolveStaticPath(root, "/"), path.join(root, "index.html"));
  assert.equal(
    resolveStaticPath(root, "/assets/styles.css"),
    path.join(root, "assets/styles.css"),
  );
  assert.equal(resolveStaticPath(root, "/..%2Fsecret.txt"), null);
});

test("content types cover site assets", () => {
  assert.equal(contentType("page.html"), "text/html; charset=utf-8");
  assert.equal(contentType("data.json"), "application/json; charset=utf-8");
  assert.equal(contentType("app.js"), "text/javascript; charset=utf-8");
  assert.equal(contentType("styles.css"), "text/css; charset=utf-8");
});

test("serves the knowledge workspace with its three accessible views", async () => {
  const server = createStaticServer(path.resolve());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/knowledge.html`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /知识卡片/);
    assert.match(html, /主题 Wiki/);
    assert.match(html, /兴趣画像/);
    assert.match(html, /assets\/knowledge\.js/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("detail page puts article context before concepts and compact insights", async () => {
  const html = await readFile(path.resolve("detail.html"), "utf8");
  const markers = [
    'id="detail-fact"',
    'id="background-section"',
    'id="development-section"',
    'id="impact-section"',
    'id="source-view-section"',
    'id="follow-up-section"',
    'id="model-comparison-section"',
    'id="relevance-heading"',
    'id="concepts-heading"',
    'class="detail-section secondary-insights"',
  ];
  const positions = markers.map((marker) => html.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0), "detail hierarchy markers missing");
  assert.deepEqual(positions, positions.toSorted((left, right) => left - right));
});

test("SQLite signals override overlapping legacy filters and metric tags, retaining calibration and offline fallback", () => {
  const legacy = { a: { tags: ["follow", "known", "tooDeep"] }, b: { tags: ["irrelevant"] } };
  const profile = { articleSignals: { b: ["follow", "known"] } };
  const state = { ...defaultViewState("2026-09-07"), feedbackStates: ["follow"] };
  assert.deepEqual(filterItems(items, state, legacy, profile).map((item) => item.id), ["b"]);
  assert.deepEqual(filterItems(items, state, legacy, { articleSignals: {} }), []);
  assert.deepEqual(filterItems(items, state, legacy).map((item) => item.id), ["a"]);
  const metrics = calculateFeedbackMetrics(["a", "b"], legacy, profile);
  assert.equal(metrics.feedbackCount, 2);
  assert.equal(metrics.rates.follow, 0.5);
  assert.equal(metrics.rates.known, 0.5);
  assert.equal(metrics.rates.irrelevant, 0);
  assert.equal(metrics.rates.tooDeep, 0.5);
  assert.deepEqual(legacy.a.tags, ["follow", "known", "tooDeep"]);
});

function browserNode(tag = "div") {
  return { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, attributes: new Map(), listeners: new Map(), _text: "", hidden: false, value: "",
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { this._text = String(value); this.children = []; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this._text = ""; this.children = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name); },
    removeAttribute(name) { this.attributes.delete(name); if (name === "href") delete this.href; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); },
  };
}

test("homepage immediately refreshes the follow filter and statistics after saving and cancelling SQLite follow", async () => {
  const source = await readFile(path.resolve("assets/index.js"), "utf8");
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, browserNode()); return elements.get(id); }, createElement: browserNode, querySelectorAll: () => [] };
  const script = source.slice(0, source.indexOf('elements["filter-panel"].addEventListener')).replace(/^import\s[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  const ui = runInNewContext(`${script}\n({ app, commitInterestSignal, renderList, renderMetrics });`, {
    ...shared, document, localStorage: { setItem() {} }, URLSearchParams, window: { location: { pathname: "/index.html" } },
    history: { replaceState() {} }, location: { pathname: "/index.html" },
    apiJson: async (_url, options) => ({ profile: { topics: {}, evidenceCount: options.method === "PUT" ? 1 : 0, articleSignals: options.method === "PUT" ? { a: ["follow"] } : {} } }),
  });
  Object.assign(ui.app, { issue: { date: "2026-09-07", items }, allItemIds: ["a", "b"], feedback: {}, view: { ...defaultViewState("2026-09-07"), feedbackStates: ["follow"] } });
  ui.renderList();
  ui.renderMetrics();
  assert.equal(elements.get("result-count").textContent, "0 / 2 条");
  await ui.commitInterestSignal("a", "follow");
  assert.equal(elements.get("result-count").textContent, "1 / 2 条");
  assert.match(elements.get("metric-list").textContent, /想追踪率100\.0%/);
  await ui.commitInterestSignal("a", "follow");
  assert.equal(elements.get("result-count").textContent, "0 / 2 条");
  assert.match(elements.get("metric-list").textContent, /想追踪率暂无反馈/);
  ui.app.profile = {};
  ui.app.interestSignals = { b: ["follow"] };
  ui.renderList();
  assert.equal(elements.get("result-count").textContent, "1 / 2 条", "cached SQLite signals remain usable offline");
});

for (const sort of ["scoreDesc", "personalized"]) {
  test(`detail interest update recomputes both navigation blocks from [b,a] to [a,b] starting with ${sort}`, async () => {
    const source = await readFile(path.resolve("assets/detail.js"), "utf8");
    const nodes = new Map();
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, browserNode()); return nodes.get(id); }, createElement: browserNode, querySelectorAll: () => [] };
    const script = source.slice(0, source.indexOf("async function initialize()")).replace(/^import\s[\s\S]*?;\r?\n/gm, "");
    const ui = runInNewContext(`${script}\n({ load(issue, item, view) { currentViewState = view; renderItem(issue, item, view); }, commitInterestSignal });`, {
      ...shared, document, URL, URLSearchParams, localStorage: { setItem() {} },
      apiJson: async (_url, options) => ({ profile: { topics: { A: options.method === "PUT" ? 3 : 0 }, evidenceCount: options.method === "PUT" ? 1 : 0, articleSignals: options.method === "PUT" ? { a: ["follow"] } : {} } }),
    });
    const issue = { date: "2026-09-07", items: [{ ...items[0], score: { total: 91 }, topics: ["A"] }, { ...items[1], topics: ["B"] }] };
    ui.load(issue, issue.items[0], { ...defaultViewState(issue.date), sort });
    for (const prefix of ["top-", ""]) {
      assert.equal(nodes.get(`${prefix}next-link`).hidden, true);
      assert.equal(new URL(nodes.get(`${prefix}previous-link`).href, "https://example.test").searchParams.get("id"), "b");
    }
    await ui.commitInterestSignal("follow");
    for (const prefix of ["top-", ""]) {
      assert.equal(nodes.get(`${prefix}previous-link`).hidden, true);
      assert.equal(nodes.get(`${prefix}previous-link`).href, undefined);
      assert.equal(nodes.get(`${prefix}previous-boundary`).hidden, false);
      assert.equal(nodes.get(`${prefix}next-boundary`).hidden, true);
      const url = new URL(nodes.get(`${prefix}next-link`).href, "https://example.test");
      assert.deepEqual(Object.fromEntries(url.searchParams), { date: "2026-09-07", id: "b", sort: "personalized" });
    }
    await ui.commitInterestSignal("follow");
    for (const prefix of ["top-", ""]) {
      assert.equal(nodes.get(`${prefix}next-link`).hidden, true);
      assert.equal(nodes.get(`${prefix}next-boundary`).hidden, false);
      assert.equal(nodes.get(`${prefix}previous-boundary`).hidden, true);
    }
  });
}

test("knowledge UI submits its labelled date filter and safe topic-control actions", async () => {
  const source = await readFile(path.resolve("assets/knowledge.js"), "utf8");
  const html = await readFile(path.resolve("knowledge.html"), "utf8");
  const nodes = new Map();
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, browserNode()); return nodes.get(id); }, createElement: browserNode };
  const formHtml = html.slice(html.indexOf('<form id="knowledge-filters"'), html.indexOf('</form>', html.indexOf('<form id="knowledge-filters"')));
  const fields = [...formHtml.matchAll(/<(input|select)\b([^>]*)>/g)].map((match) => {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((part) => [part[1], part[2]]));
    const field = document.getElementById(attributes.id);
    Object.assign(field, attributes);
    return field;
  });
  document.getElementById("knowledge-filters").elements = fields;
  const calls = [];
  let score = 3;
  const profile = () => ({ topics: { "A & <img>": score }, depth: 0, angles: {}, evidenceCount: 1 });
  const script = source.replace(/^import\s[^\n]+\r?\n/gm, "").replace(/loadCards\(\);\s*$/, "");
  const ui = runInNewContext(`${script}\n({ loadCards, loadProfile });`, { document, URL, URLSearchParams, apiJson: async (url, options = {}) => {
    calls.push([url, options.method ?? "GET"]);
    if (url === "/api/profile") return { profile: profile() };
    if (url.startsWith("/api/profile/topics/")) { score = 2; return { profile: profile() }; }
    return { cards: [], topics: [] };
  } });
  const date = fields.find((field) => field.name === "date");
  assert.equal(date?.type, "date", "date control must be in the actual filter form");
  assert.match(formHtml, /<label for="knowledge-date">创建日期<\/label>/);
  date.value = "2026-09-08";
  await ui.loadCards();
  assert.equal(calls[0][0], "/api/knowledge?date=2026-09-08");
  await ui.loadProfile();
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  for (const action of ["lower", "reset", "unfollow"]) {
    const button = descendants(nodes.get("profile-content")).find((node) => node.dataset.topicAction === action);
    assert.ok(button, `missing topic action ${action}`);
    assert.match(button.getAttribute("aria-label"), /A & <img>/);
    await button.dispatch("click");
    assert.ok(calls.some(([url, method]) => url === `/api/profile/topics/A%20%26%20%3Cimg%3E/${action}` && method === "POST"));
  }
  assert.equal(descendants(nodes.get("profile-content")).some((node) => node.tagName === "IMG"), false);
  assert.match(nodes.get("profile-content").textContent, /\+2/);
});
