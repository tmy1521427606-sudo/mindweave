import assert from "node:assert/strict";
import test from "node:test";
import { createLearningAgent, extractRequiredObjects } from "../lib/agent.mjs";
import { backfillCardTopics, initializeSchema, openDatabase } from "../lib/database.mjs";
import { ProviderUnavailableError } from "../lib/providers.mjs";
import { persistKnowledgeBundle } from "../lib/knowledge.mjs";
import { getProfile, setInterestSignal } from "../lib/personalization.mjs";

function database(t, title = "Agent", fact = "Agent 支持工具调用") {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  if (title) {
    const item = { title, fact, topics: ["Agent 开发"], source: { url: "https://example.test/local", name: "官方", type: "官方文档" } };
    db.prepare("INSERT INTO issues VALUES (?, ?, ?)").run("2026-09-09", "test.json", "{}");
    db.prepare("INSERT INTO sources VALUES (?, ?, ?)").run(item.source.url, "官方", "官方文档");
    db.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("a1", "2026-09-09", title, "2026-09-09", "官方", item.source.url, JSON.stringify(item), "fixture", title, fact);
    db.prepare("INSERT INTO article_topics (article_id, topic) VALUES (?, ?)").run("a1", "Agent 开发");
    db.exec("INSERT INTO article_fts(rowid, fts_title, fts_body) SELECT rowid, fts_title, fts_body FROM articles");
  }
  return db;
}

function citedModel(inspect = () => {}) {
  return { async chat(request) {
    inspect(request);
    const evidence = JSON.parse(request.messages.at(-1).content).untrustedEvidence;
    return {
      answerSections: [{ kind: "fact", text: "有资料支持", citationIds: [evidence[0].id] }],
      knowledgeCards: [{ type: "fact", title: "工具调用", content: "有资料支持", citationIds: [evidence[0].id] }],
      remainingUncertainty: [],
    };
  } };
}

test("strong local evidence avoids web and saves cards with resolvable source IDs", async (t) => {
  const db = database(t);
  const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel((request) => {
    assert.equal(request.responseSchema.strict, true);
    assert.match(request.messages[0].content, /不可信/);
  }), webSearch: { search() { assert.fail("must stay local"); } } });
  const result = await agent.answer({ question: "Agent" });
  assert.equal(result.mode, "local");
  assert.equal(result.savedCards.length, 1);
  assert.equal(result.answerSections[0].citationIds[0], result.sources[0].id);
  assert.equal(db.prepare("SELECT source_id FROM knowledge_card_sources").get().source_id, result.sources[0].id);
  assert.deepEqual(
    db.prepare("SELECT topic FROM card_topics").all().map((row) => row.topic),
    ["Agent 开发"],
  );
  assert.deepEqual(result.savedCards[0].topics, ["Agent 开发"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
});

test("freshness queries call web and all citations resolve", async (t) => {
  const db = database(t);
  let searches = 0;
  const agent = createLearningAgent({ db, doubao: citedModel(), webSearch: { async search(query) {
    assert.equal(query, "今天有什么新模型");
    searches += 1;
    return [{ title: "发布", url: "https://example.test/new", content: "今天发布模型" }];
  } } });
  const result = await agent.answer({ question: "今天有什么新模型" });
  assert.equal(searches, 1);
  assert.equal(result.mode, "local+web");
  assert.ok(result.answerSections.every((section) => section.citationIds.every((id) => result.sources.some((source) => source.id === id))));
  assert.equal(result.savedCards.length, 1);
});

test("web-only cited cards remain unclassified instead of guessing from the question", async (t) => {
  const db = database(t, null);
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: {
    async search() { return [{ title: "Agent news", url: "https://example.test/web-only", content: "Agent 更新" }]; },
  } }).answer({ question: "今天 Agent 有什么更新" });
  assert.equal(result.mode, "local+web");
  assert.deepEqual(result.savedCards[0].topics, []);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics").all(), []);
  db.prepare("INSERT INTO issues VALUES (?, ?, ?)").run("2026-09-09", "late.json", "{}");
  db.prepare("INSERT INTO sources VALUES (?, ?, ?)").run("https://example.test/web-only", "官方", "官方文档");
  db.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("late", "2026-09-09", "Late", "2026-09-09", "官方", "https://example.test/web-only", "{}", "late", "Late", "Fact");
  db.prepare("INSERT INTO article_topics VALUES (?, ?)").run("late", "迟到主题");
  backfillCardTopics(db);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics").all(), []);
});

test("a card inherits topics only from its cited local article when articles share a URL", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  const sourceUrl = "https://example.test/shared";
  db.prepare("INSERT INTO issues VALUES (?, ?, ?)").run("2026-09-09", "test.json", "{}");
  db.prepare("INSERT INTO sources VALUES (?, ?, ?)").run(sourceUrl, "官方", "官方文档");
  for (const [id, title, topic] of [["a1", "First", "Topic A"], ["a2", "Second", "Topic B"]]) {
    const item = { title, fact: `${title} fact`, topics: [topic], source: { url: sourceUrl, name: "官方", type: "官方文档" } };
    db.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, "2026-09-09", title, "2026-09-09", "官方", sourceUrl, JSON.stringify(item), id, title, item.fact);
    db.prepare("INSERT INTO article_topics VALUES (?, ?)").run(id, topic);
  }
  db.exec("INSERT INTO article_fts(rowid, fts_title, fts_body) SELECT rowid, fts_title, fts_body FROM articles");

  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel() })
    .answer({ question: "Second" });
  assert.deepEqual(result.savedCards[0].topics, ["Topic B"]);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics").all().map((row) => row.topic), ["Topic B"]);
  backfillCardTopics(db);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics").all().map((row) => row.topic), ["Topic B"]);
});

test("unavailable or empty search returns uncertainty without model calls or cards", async (t) => {
  for (const webSearch of [null, { search() { throw new ProviderUnavailableError("Tavily"); } }, { search: async () => [] }]) {
    const db = database(t, null);
    const result = await createLearningAgent({ db, webSearch, doubao: { chat() { assert.fail("no evidence"); } } }).answer({ question: "今天有什么新模型" });
    assert.equal(result.savedCards.length, 0);
    assert.deepEqual(result.answerSections, []);
    assert.match(result.remainingUncertainty.join(""), /无法完成.*核验/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_cards").get().n, 0);
  }
});

test("rejects unsupported facts, source positions, cards and unknown citations before persistence", async (t) => {
  for (const output of [
    { answerSections: [{ kind: "fact", text: "无据事实", citationIds: [] }], knowledgeCards: [], remainingUncertainty: [] },
    { answerSections: [{ kind: "source_position", text: "无据观点", citationIds: [] }], knowledgeCards: [], remainingUncertainty: [] },
    { answerSections: [{ kind: "fact", text: "伪造", citationIds: ["invented"] }], knowledgeCards: [], remainingUncertainty: [] },
    { answerSections: [], knowledgeCards: [{ type: "fact", title: "伪造", content: "无据", citationIds: [] }], remainingUncertainty: [] },
  ]) {
    const db = database(t);
    const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: { chat: async () => output } }).answer({ question: "Agent" });
    assert.deepEqual(result.answerSections, []);
    assert.deepEqual(result.savedCards, []);
    assert.match(result.remainingUncertainty.join(""), /引用|格式/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_sources").get().n, 0);
  }
});

test("inference is visibly labelled and conversation continues", async (t) => {
  const db = database(t);
  const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: { chat: async () => ({
    answerSections: [{ kind: "inference", text: "可能提升效率", citationIds: [] }], knowledgeCards: [], remainingUncertainty: [],
  }) } });
  const result = await agent.answer({ question: "Agent", articleId: "a1" });
  assert.match(result.answerSections[0].text, /推断/);
  const next = await agent.answer({ question: "Agent", conversationId: result.conversationId });
  assert.equal(next.conversationId, result.conversationId);
  assert.equal(db.prepare("SELECT count(*) AS n FROM conversations").get().n, 1);
});

test("explicit comparison names force web when the second object is missing", async (t) => {
  for (const [question, expected] of [["豆包和扣子有什么区别", ["豆包", "扣子"]], ["A 与 B", ["A", "B"]], ["A vs B", ["A", "B"]], ["比较 A、B", ["A", "B"]]]) {
    assert.deepEqual(extractRequiredObjects(question), expected);
  }
  assert.deepEqual(extractRequiredObjects("如何学习和理解复杂概念"), []);
  const db = database(t, "豆包", "豆包支持聊天");
  let searched = false;
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: { search: async () => {
    searched = true;
    return [{ url: "https://example.test/coze", content: "扣子是 Agent 开发平台" }];
  } } }).answer({ question: "豆包和扣子有什么区别" });
  assert.equal(searched, true);
  assert.equal(result.mode, "local+web");
});

test("optional stored embeddings find evidence after lexical search", async (t) => {
  const db = database(t);
  db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?)").run("e1", "a1", null, "embed-v1", "[1,0]", "e1");
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: {
    ...citedModel(), embeddingModel: "embed-v1", embed: async () => [[1, 0]],
  }, webSearch: { search() { assert.fail("vector evidence is sufficient"); } } }).answer({ question: "工具编排" });
  assert.equal(result.mode, "local");
  assert.equal(result.sources[0].url, "https://example.test/local");
});

test("invalid requests fail before providers and persistence", async (t) => {
  const db = database(t);
  const agent = createLearningAgent({ db, doubao: { chat() { assert.fail("invalid input"); } } });
  for (const input of [{ question: " " }, { question: "a".repeat(4001) }, { question: "ok", articleId: "missing" }, { question: "ok", conversationId: "missing" }, null]) {
    await assert.rejects(() => agent.answer(input), (error) => error.status === 400);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
});

test("source conflict forces web fallback even for a strong local hit", async (t) => {
  const db = database(t);
  const row = db.prepare("SELECT payload_json FROM articles").get();
  db.prepare("UPDATE articles SET payload_json = ?").run(JSON.stringify({ ...JSON.parse(row.payload_json), sourceConflict: true }));
  let searched = false;
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: { async search() {
    searched = true;
    return [{ url: "https://example.test/check", content: "Agent 的补充证据" }];
  } } }).answer({ question: "Agent" });
  assert.equal(searched, true);
  assert.equal(result.mode, "local+web");
});

test("message write failure rolls back sources and cards too", async (t) => {
  const db = database(t);
  db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel() });
  await assert.rejects(() => agent.answer({ question: "Agent" }), /fixture failure/);
  for (const table of ["knowledge_sources", "knowledge_cards", "conversations", "messages"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
});

for (const useEmbedding of [false, true]) {
  test(`fresh web excerpt replaces the same-URL local evidence with ${useEmbedding ? "higher vector" : "equal lexical"} score`, async (t) => {
    const db = database(t, "Agent", "OLD price 10");
    db.prepare("UPDATE articles SET published_date = ?").run("2020-01-01");
    const doubao = citedModel((request) => {
      const input = request.messages.at(-1).content;
      assert.match(input, /NEW price 20/);
      assert.doesNotMatch(input, /OLD price 10/);
      assert.equal(JSON.parse(input).untrustedEvidence.length, 1);
    });
    if (useEmbedding) {
      db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?)").run("e1", "a1", null, "embed-v1", "[1,0]", "e1");
      Object.assign(doubao, { embeddingModel: "embed-v1", embed: async () => [[1, 0]] });
    }
    const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao, webSearch: { async search() {
      return [{ title: "Agent", url: "https://example.test/local", publishedDate: "2026-09-09", content: "NEW price 20" }];
    } } }).answer({ question: "Agent" });
    assert.equal(result.mode, "local+web");
    assert.equal(result.sources[0].excerpt, "NEW price 20");
  });
}

test("Agent price revisions return and persist the evidence version actually cited", async (t) => {
  const db = database(t, "Agent", "Price: 10");
  const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: { async search() {
    return [{ title: "Agent", type: "官方文档", url: "https://example.test/local", publishedDate: "2026-09-09", content: "Price: 20" }];
  } } });
  const oldAnswer = await agent.answer({ question: "Agent" });
  const newAnswer = await agent.answer({ question: "今天 Agent 价格" });
  assert.notEqual(newAnswer.sources[0].id, oldAnswer.sources[0].id);
  for (const [answer, excerpt] of [[oldAnswer, "Price: 10"], [newAnswer, "Price: 20"]]) {
    const row = db.prepare(`SELECT s.id, s.excerpt FROM knowledge_card_sources cs JOIN knowledge_sources s ON s.id = cs.source_id WHERE cs.card_id = ?`).get(answer.savedCards[0].id);
    assert.equal(row.id, answer.sources[0].id);
    assert.equal(row.excerpt, excerpt);
  }
});

for (const status of ["verified", "needs_review"]) {
  test(`a ${status} card-only local match supplies its original citations to the model`, async (t) => {
    const db = database(t, null);
    const source = { url: "https://example.test/cards", title: "工具研究", type: "官方文档", publishedDate: "2026-09-09", excerpt: "调用前校验参数" };
    persistKnowledgeBundle(db, { sources: [source], cards: [{ id: "saved", type: "concept", text: "幂等编排：重复调用不改变结果", topics: ["显式主题"], topicOrigin: "agent", sources: [source.url] }] });
    db.prepare("UPDATE knowledge_cards SET status = ? WHERE id = 'saved'").run(status);
    const originalId = db.prepare("SELECT id FROM knowledge_sources").get().id;
    let modelCalled = false;
    const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel((request) => {
      modelCalled = true;
      const evidence = JSON.parse(request.messages.at(-1).content).untrustedEvidence;
      assert.equal(evidence[0].id, originalId);
      assert.equal(evidence[0].knowledgeCards[0].id, "saved");
      assert.equal(evidence[0].knowledgeCards[0].status, status);
      assert.match(evidence[0].knowledgeCards[0].text, /幂等编排/);
      assert.equal(evidence[0].excerpt, "调用前校验参数");
    }), webSearch: { search() { assert.fail("matching local card must avoid web"); } } }).answer({ question: "幂等编排" });
    assert.equal(modelCalled, true);
    assert.equal(result.mode, "local");
    assert.equal(result.answerSections[0].citationIds[0], originalId);
    assert.equal(result.sources[0].id, originalId);
    assert.deepEqual(result.savedCards[0].topics, ["显式主题"]);
  });
}

test("rejected and superseded cards never participate in lexical or embedding retrieval", async (t) => {
  const db = database(t, null);
  const source = { url: "https://example.test/retired", title: "Archived", type: "官方文档", publishedDate: "2026-09-09", excerpt: "不可作为默认答案" };
  for (const status of ["rejected", "superseded"]) {
    persistKnowledgeBundle(db, { sources: [source], cards: [{ id: status, type: "fact", text: `已废弃编排 ${status}`, sources: [source.url] }] });
    db.prepare("UPDATE knowledge_cards SET status = ? WHERE id = ?").run(status, status);
    db.prepare("INSERT INTO embeddings VALUES (?, NULL, ?, ?, ?, ?)").run(status, status, "test-embed", "[1,0]", status);
  }
  const result = await createLearningAgent({ db, doubao: { embeddingModel: "test-embed", embed() { assert.fail("no eligible embedding owners"); }, chat() { assert.fail("retired cards are not evidence"); } } }).answer({ question: "已废弃编排" });
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.savedCards, []);
});

for (const owner of ["article", "card"]) {
  test(`configured embeddings build a missing ${owner} vector and retrieve semantic evidence`, async (t) => {
    const db = database(t, owner === "article" ? "Agent" : null);
    if (owner === "card") persistKnowledgeBundle(db, { sources: [{ url: "https://example.test/semantic", title: "流程", type: "官方文档", publishedDate: "2026-09-09", excerpt: "工具请求有序执行" }], cards: [{ id: "semantic", type: "concept", text: "工具流程", topicOrigin: "agent", sources: ["https://example.test/semantic"] }] });
    const embeddingInputs = [];
    const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: { ...citedModel(), embeddingModel: "test-embed", async embed(texts) {
      embeddingInputs.push(...texts);
      return texts.map(() => [1, 0]);
    } }, webSearch: { search() { assert.fail("semantic local evidence is sufficient"); } } });
    const result = await agent.answer({ question: "怎样安排执行顺序" });
    assert.equal(result.mode, "local");
    assert.equal(result.savedCards.length, 1);
    assert.ok(embeddingInputs.some((text) => text.includes(owner === "article" ? "Agent" : "工具流程")));
    assert.ok(embeddingInputs.includes("怎样安排执行顺序"));
    assert.equal(db.prepare(`SELECT count(*) AS n FROM embeddings WHERE ${owner === "article" ? "article_id" : "card_id"} IS NOT NULL`).get().n, 1);
  });
}

test("card retrieval retains both source snapshots when a comparison cites one URL twice", async (t) => {
  const db = database(t, null);
  persistKnowledgeBundle(db, { sources: [10, 20].map((price) => ({ id: `v${price}`, url: "https://example.test/prices", title: "价格", publishedDate: "2026-09-09", type: "官方文档", excerpt: `Price: ${price}` })), cards: [{ id: "compare", type: "comparison", text: "价格差异", sources: ["v10", "v20"] }] });
  let modelCalled = false;
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel((request) => {
    modelCalled = true;
    const evidence = JSON.parse(request.messages.at(-1).content).untrustedEvidence;
    assert.deepEqual(evidence.map((row) => row.excerpt).sort(), ["Price: 10", "Price: 20"]);
  }) }).answer({ question: "价格差异" });
  assert.equal(modelCalled, true);
  assert.equal(result.sources.length, 2);
});

test("SQLite depth and angle signals change a bounded explanation strategy without changing topic frequency", async (t) => {
  const db = database(t);
  const strategies = [];
  const agent = createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel((request) => {
    const preference = request.messages.find((message) => message.role === "system" && message.content.startsWith('{"explanationStrategy"'));
    strategies.push(preference ? JSON.parse(preference.content).explanationStrategy : null);
  }) });
  await agent.answer({ question: "Agent" });
  setInterestSignal(db, "a1", "known", true);
  await agent.answer({ question: "Agent" });
  setInterestSignal(db, "a1", "known", false);
  setInterestSignal(db, "a1", "needFoundation", true);
  setInterestSignal(db, "a1", "wantTechnical", true);
  setInterestSignal(db, "a1", "wantBusiness", true);
  await agent.answer({ question: "Agent" });
  assert.deepEqual(strategies, [
    { foundation: "standard", technical: 0, business: 0 },
    { foundation: "concise", technical: 0, business: 0 },
    { foundation: "expanded", technical: 2, business: 2 },
  ]);
  assert.equal(getProfile(db).topics["Agent 开发"], 0);
  for (let index = 0; index < 20; index += 1) db.prepare("INSERT INTO interest_signals VALUES (?, ?, ?, ?)").run("a1", `角度${index}`, "wantTechnical", "2026-09-09");
  await agent.answer({ question: "Agent" });
  assert.equal(strategies.at(-1).technical, 2);
});

test("unresolved conflict on cited evidence keeps a model-produced fact card in review", async (t) => {
  const db = database(t);
  const original = JSON.parse(db.prepare("SELECT payload_json FROM articles").get().payload_json);
  db.prepare("UPDATE articles SET payload_json = ?").run(JSON.stringify({ ...original, sourceConflict: true }));
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: { async search() {
    return [{ url: "https://example.test/secondary", content: "二手消息，没有消除冲突", type: "二手报道" }];
  } } }).answer({ question: "Agent" });
  assert.equal(result.savedCards[0].status, "needs_review");
  assert.equal(db.prepare("SELECT conflicted FROM knowledge_cards WHERE id = ?").get(result.savedCards[0].id).conflicted, 1);
  assert.equal(result.sources.find((source) => source.id === result.savedCards[0].citationIds[0]).conflicted, true);
});

for (const type of [null, "二手报道"]) {
  test(`web evidence of type ${type ?? "unknown"} cannot alone establish a fact`, async (t) => {
    const db = database(t, null);
    const result = await createLearningAgent({ db, doubao: citedModel(), webSearch: { async search() {
      return [{ url: "https://example.test/report", title: "来源说法", type, content: "声称价格已变更" }];
    } } }).answer({ question: "今天价格是多少" });
    assert.equal(result.answerSections[0].kind, "source_position");
    assert.match(result.remainingUncertainty.join(""), /一手|核验/);
    assert.equal(result.savedCards[0].status, "needs_review");
    assert.equal(result.answerSections[0].citationIds[0], result.sources[0].id);
    assert.equal(result.sources.length, 1);
  });
}

test("eligible web source types and direct GitHub releases can support verified factual answers", async (t) => {
  for (const source of [
    { url: "https://example.test/primary", type: "官方产品公告" },
    { url: "https://github.com/example/project/releases/tag/v1.0" },
  ]) {
    const db = database(t, null);
    const result = await createLearningAgent({ db, doubao: citedModel(), webSearch: { async search() { return [{ ...source, title: "发布", content: "模型发布" }]; } } }).answer({ question: "今天有什么发布" });
    assert.equal(result.answerSections[0].kind, "fact");
    assert.equal(result.savedCards[0].status, "verified");
    assert.ok(["官方产品公告", "GitHub Release"].includes(result.sources[0].type));
  }
});

test("an unrelated primary hit does not validate a fact citing only a secondary result", async (t) => {
  const db = database(t, null);
  const result = await createLearningAgent({ db, doubao: citedModel(), webSearch: { async search() {
    return [
      { url: "https://example.test/secondary-only", type: "二手报道", content: "未经核验的价格" },
      { url: "https://example.test/primary-other", type: "官方文档", content: "无关的接口说明" },
    ];
  } } }).answer({ question: "今天价格是多少" });
  assert.equal(result.answerSections[0].kind, "source_position");
  assert.equal(result.savedCards[0].status, "needs_review");
});

test("explicit web verification overrides sufficient local evidence and returns retrieval provenance", async (t) => {
  const db = database(t);
  let searches = 0;
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel(), webSearch: { async search() {
    searches += 1;
    return [{ url: "https://example.test/check", title: "补充核验", type: "官方文档", content: "支持工具调用" }];
  } } }).answer({ question: "Agent", verifyWeb: true });
  assert.equal(searches, 1);
  assert.equal(result.mode, "local+web");
  assert.equal(result.retrieval.webStatus, "completed");
  assert.equal(result.retrieval.webRequested, true);
  assert.deepEqual(result.retrieval.localSourceIds, [result.sources.find((source) => source.url.endsWith("/local")).id]);
  assert.deepEqual(result.retrieval.webSourceIds, [result.sources.find((source) => source.url.endsWith("/check")).id]);
});

test("explicit verification without Tavily clearly reports unavailable verification even with strong local evidence", async (t) => {
  const db = database(t);
  const result = await createLearningAgent({ db, now: () => new Date("2026-09-09"), doubao: citedModel() }).answer({ question: "Agent", verifyWeb: true });
  assert.match(result.remainingUncertainty.join(""), /联网.*未配置|联网.*不可用/);
  assert.deepEqual(result.answerSections, []);
  assert.deepEqual(result.retrieval.localSourceIds, []);
  assert.deepEqual(result.retrieval.webSourceIds, []);
  assert.equal(result.retrieval.webStatus, "unavailable");
});
