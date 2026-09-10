import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { backfillCardTopics, getArticle, openDatabase, initializeSchema, syncIssueDirectory, searchArticles } from "../lib/database.mjs";
import { persistKnowledgeBundle } from "../lib/knowledge.mjs";
import { createLearningAgent } from "../lib/agent.mjs";

test("syncs JSON issues idempotently and searches all dates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "Agent 商品检索", publishedDate: "2026-09-09", topics: ["电商 × Agent"], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "商品检索支持新协议", concepts: [{ name: "协议", explanation: "约定" }] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 1, articles: 1 });
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 1, articles: 1 });
  assert.equal(searchArticles(db, "商品", 10)[0].id, "a1");
});

test("replaces obsolete FTS terms and topics when an article changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "oldterm article", publishedDate: "2026-09-09", topics: ["old topic"], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "oldterm fact", concepts: [] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);

  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "newterm article", publishedDate: "2026-09-09", topics: ["new topic"], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "newterm fact", concepts: [] }],
  }));
  await syncIssueDirectory(db, dir);

  assert.deepEqual(searchArticles(db, "oldterm").map((item) => item.id), []);
  assert.deepEqual(searchArticles(db, "newterm").map((item) => item.id), ["a1"]);
  assert.deepEqual(
    db.prepare("SELECT topic FROM article_topics WHERE article_id = ?").all("a1").map((row) => row.topic),
    ["new topic"],
  );
});

test("gets the current full article or null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "Article", publishedDate: "2026-09-09", topics: [], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "Fact", concepts: [] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);

  assert.equal(getArticle(db, "a1").item.title, "Article");
  assert.equal(getArticle(db, "missing"), null);
});

test("backfills historical card topics from their cited local article sources idempotently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "Article", publishedDate: "2026-09-09", topics: ["可追溯主题"], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "Fact", concepts: [] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);
  persistKnowledgeBundle(db, {
    sources: [{ publisher: "官方", title: "Article", type: "官方公告", url: "https://example.com/a", excerpt: "Fact" }],
    cards: [{ id: "historical", type: "fact", text: "历史卡片", sources: ["https://example.com/a"] }],
  });

  await syncIssueDirectory(db, dir);
  await syncIssueDirectory(db, dir);
  assert.deepEqual(
    db.prepare("SELECT topic FROM card_topics WHERE card_id = ?").all("historical").map((row) => row.topic),
    ["可追溯主题"],
  );
});

test("legacy provenance stays bound to its first articles when a same-URL article arrives later", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  const first = { id: "a1", title: "Article A", topics: ["Topic A"], source: { url: "https://example.com/shared" } };
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({ date: "2026-09-09", items: [first] }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  persistKnowledgeBundle(db, {
    sources: [{ url: "https://example.com/shared", excerpt: "Article A fact" }],
    cards: [{ id: "legacy", type: "fact", text: "Historical card", sources: ["https://example.com/shared"] }],
  });
  backfillCardTopics(db);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ?").all("legacy"), []);
  assert.equal(db.prepare("SELECT origin FROM knowledge_card_topic_origins WHERE card_id = ?").get("legacy"), undefined);
  await syncIssueDirectory(db, dir);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ?").all("legacy").map((row) => row.topic), ["Topic A"]);
  assert.deepEqual(db.prepare("SELECT article_id FROM knowledge_card_article_provenance WHERE card_id = ?").all("legacy").map((row) => row.article_id), ["a1"]);
  assert.equal(db.prepare("SELECT origin FROM knowledge_card_topic_origins WHERE card_id = ?").get("legacy").origin, "legacy");

  const second = { id: "a2", title: "Article B", topics: ["Topic B"], source: { url: "https://example.com/shared?utm_source=later" } };
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({ date: "2026-09-09", items: [first, second] }));
  await syncIssueDirectory(db, dir);
  await syncIssueDirectory(db, dir);
  assert.deepEqual({
    topics: db.prepare("SELECT topic FROM card_topics WHERE card_id = ? ORDER BY topic").all("legacy").map((row) => row.topic),
    articleIds: db.prepare("SELECT article_id FROM knowledge_card_article_provenance WHERE card_id = ? ORDER BY article_id").all("legacy").map((row) => row.article_id),
  }, { topics: ["Topic A"], articleIds: ["a1"] });
});

test("backfills a normalized knowledge source against an article URL with tracking parameters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "Article", publishedDate: "2026-09-09", topics: ["规范主题"], source: { name: "官方", type: "公告", url: "https://example.com/a?utm_source=feed&version=2" }, fact: "Fact", concepts: [] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);
  persistKnowledgeBundle(db, {
    sources: [{ publisher: "官方", title: "Article", type: "官方公告", url: "https://example.com/a?version=2", excerpt: "Fact" }],
    cards: [{ id: "normalized", type: "fact", text: "规范化来源卡片", sources: ["https://example.com/a?version=2"] }],
  });
  await syncIssueDirectory(db, dir);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ?").all("normalized").map((row) => row.topic), ["规范主题"]);
});

test("rebuilds historical card topics from current cited-source relationships", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  const issue = (firstTopic) => ({
    date: "2026-09-09",
    items: [
      { id: "a1", title: "First", publishedDate: "2026-09-09", topics: [firstTopic], source: { name: "官方", type: "公告", url: "https://example.com/first" }, fact: "First fact", concepts: [] },
      { id: "a2", title: "Second", publishedDate: "2026-09-09", topics: ["保留主题"], source: { name: "官方", type: "公告", url: "https://example.com/second" }, fact: "Second fact", concepts: [] },
    ],
  });
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify(issue("旧主题")));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);
  persistKnowledgeBundle(db, {
    sources: [
      { publisher: "官方", title: "First", type: "官方公告", url: "https://example.com/first", excerpt: "First fact" },
      { publisher: "官方", title: "Second", type: "官方公告", url: "https://example.com/second", excerpt: "Second fact" },
    ],
    cards: [{ id: "projection", type: "fact", text: "双来源卡片", sources: ["https://example.com/first", "https://example.com/second"] }],
  });
  await syncIssueDirectory(db, dir);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ? ORDER BY topic").all("projection").map((row) => row.topic), ["保留主题", "旧主题"]);

  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify(issue("新主题")));
  await syncIssueDirectory(db, dir);
  await syncIssueDirectory(db, dir);
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ? ORDER BY topic").all("projection").map((row) => row.topic), ["保留主题", "新主题"]);
});

test("keeps explicit card topics while refreshing article-derived topics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  const issue = (topic) => ({ date: "2026-09-09", items: [{ id: "a1", title: "Article", publishedDate: "2026-09-09", topics: [topic], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "Fact", concepts: [] }] });
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify(issue("派生旧主题")));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);
  persistKnowledgeBundle(db, {
    sources: [{ publisher: "官方", title: "Article", type: "官方公告", url: "https://example.com/a", excerpt: "Fact" }],
    cards: [{ id: "explicit", type: "fact", text: "显式卡片", topics: ["手工主题"], sources: ["https://example.com/a"] }],
  });
  await syncIssueDirectory(db, dir);
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify(issue("派生新主题")));
  await syncIssueDirectory(db, dir);
  assert.deepEqual(
    db.prepare("SELECT topic FROM card_topics WHERE card_id = ? ORDER BY topic").all("explicit").map((row) => row.topic),
    ["手工主题", "派生新主题"],
  );
});

test("migrates existing card topics into explicit provenance without dropping old-schema data", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  db.exec(`
    DROP TABLE knowledge_card_article_provenance;
    DROP TABLE knowledge_card_topic_origins;
    DROP TABLE knowledge_card_explicit_topics;
    DROP TABLE knowledge_topic_migrations;
  `);
  db.prepare("INSERT INTO knowledge_sources (id, fingerprint, url, publisher, title, source_type, published_date, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("source", "fingerprint", "https://example.com/a", "官方", "Article", "官方公告", null, "Fact");
  db.prepare("INSERT INTO knowledge_cards VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("old-schema", "card-fingerprint", "fact", "verified", "旧数据卡片", 0, "2026-09-09T00:00:00.000Z");
  db.prepare("INSERT INTO knowledge_card_sources VALUES (?, ?)").run("old-schema", "source");
  db.prepare("INSERT INTO card_topics VALUES (?, ?)").run("old-schema", "旧主题");
  initializeSchema(db);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_card_explicit_topics'").get();
  assert.ok(table, "explicit-topic ledger table is required");
  assert.deepEqual(
    db.prepare("SELECT topic FROM knowledge_card_explicit_topics WHERE card_id = ?").all("old-schema").map((row) => row.topic),
    ["旧主题"],
  );
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics WHERE card_id = ?").all("old-schema").map((row) => row.topic), ["旧主题"]);
});

test("real archive Chinese substrings recall 截断 and 条码 with deterministic bounded results", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  await syncIssueDirectory(db, fileURLToPath(new URL("../data/", import.meta.url)));
  for (const term of ["截断", "条码"]) {
    const hits = searchArticles(db, term, 30);
    assert.ok(hits.length > 0, `missing substring ${term}`);
    assert.ok(hits.every((hit) => JSON.stringify(hit.item).includes(term)));
    assert.equal(new Set(hits.map((hit) => hit.id)).size, hits.length);
    assert.deepEqual(searchArticles(db, term, 1).map((hit) => hit.id), [hits[0].id]);
    assert.deepEqual(searchArticles(db, term, 30).map((hit) => hit.id), hits.map((hit) => hit.id));
  }
  assert.deepEqual(searchArticles(db, "条码' OR 1=1 --"), []);
  assert.deepEqual(searchArticles(db, "条码", 0), []);
  assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n, 48);
});

test("49-to-48 archive sync retires removed articles while preserving feedback and historical knowledge", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../data/", import.meta.url)), dir, { recursive: true });
  const issuePath = path.join(dir, "2026-09-09.json");
  const issue = JSON.parse(await readFile(issuePath, "utf8"));
  const extra = { id: "removed", title: "消失索引 vanishedentry", fact: "移除条目", topics: ["移除主题"], source: { url: "https://example.test/removed", type: "官方文档" } };
  await writeFile(issuePath, JSON.stringify({ ...issue, items: [...issue.items, extra] }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 3, articles: 49 });
  db.exec("INSERT INTO interest_signals VALUES ('removed', '移除主题', 'follow', '2026-09-09'); INSERT INTO conversations VALUES ('history', '2026-09-09'); INSERT INTO messages VALUES ('message', 'history', 'user', '旧问题', '2026-09-09')");
  persistKnowledgeBundle(db, { sources: [{ ...extra.source, excerpt: "旧证据" }], cards: [{ id: "historical-removed", type: "fact", text: "保留知识", topicOrigin: "agent", articleIds: [extra.id], topics: ["手工主题"], sources: [extra.source.url] }] });
  assert.equal(searchArticles(db, "vanishedentry").length, 1);
  await writeFile(issuePath, JSON.stringify(issue));
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 3, articles: 48 });
  await syncIssueDirectory(db, dir);
  assert.deepEqual(searchArticles(db, "vanishedentry"), []);
  assert.deepEqual(searchArticles(db, "消失索引"), []);
  assert.equal(getArticle(db, "removed"), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM article_topics WHERE article_id = 'removed'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM interest_signals").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_card_sources").get().n, 1);
  assert.equal(db.prepare("SELECT article_id FROM knowledge_card_article_provenance").get().article_id, "removed");
  assert.deepEqual(db.prepare("SELECT topic FROM card_topics").all().map((row) => row.topic), ["手工主题"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // The unchanged article can be reintroduced without leaving an empty FTS/topic projection.
  await writeFile(issuePath, JSON.stringify({ ...issue, items: [...issue.items, extra] }));
  await syncIssueDirectory(db, dir);
  assert.equal(searchArticles(db, "vanishedentry").length, 1);
  assert.equal(getArticle(db, "removed").id, "removed");
  assert.equal(db.prepare("SELECT topic FROM article_topics WHERE article_id = 'removed'").get().topic, "移除主题");
});

test("removing an entire issue from the manifest also retires its index rows", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../data/", import.meta.url)), dir, { recursive: true });
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  await syncIssueDirectory(db, dir);
  const removedId = db.prepare("SELECT id FROM articles WHERE issue_date = '2026-09-07' LIMIT 1").get().id;
  const manifest = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
  manifest.issues = manifest.issues.filter((issue) => issue.date !== "2026-09-07");
  await writeFile(path.join(dir, "index.json"), JSON.stringify(manifest));
  await syncIssueDirectory(db, dir);
  assert.equal(getArticle(db, removedId), null);
  assert.ok(searchArticles(db, "Agent").every((hit) => hit.issueDate !== "2026-09-07"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [] }));
  await syncIssueDirectory(db, dir);
  const result = await createLearningAgent({ db, doubao: { embeddingModel: "test", embed() { assert.fail("retired archive must not be embedded"); }, chat() { assert.fail("retired archive is not answer evidence"); } } }).answer({ question: "Agent" });
  assert.deepEqual(result.sources, []);
});

test("signal schema upgrades article-only rows and supports unique topic-level signals without a second profile store", (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  db.exec(`INSERT INTO issues VALUES ('2026-09-09', 'fixture.json', '{}');
    INSERT INTO articles (id, issue_date, title, payload_json, fingerprint, fts_title, fts_body) VALUES ('legacy', '2026-09-09', 'Legacy', '{}', 'legacy', 'Legacy', '');
    DROP TABLE interest_signals;
    CREATE TABLE interest_signals (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, topic TEXT NOT NULL, signal TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(article_id, topic, signal));
    INSERT INTO interest_signals VALUES ('legacy', '主题', 'follow', '2026-09-08');`);
  initializeSchema(db);
  initializeSchema(db);
  assert.doesNotThrow(() => db.prepare("INSERT INTO interest_signals VALUES (NULL, ?, ?, ?)").run("主题", "lessLikeThis", "2026-09-09"));
  assert.throws(() => db.prepare("INSERT INTO interest_signals VALUES (NULL, ?, ?, ?)").run("主题", "lessLikeThis", "2026-09-10"));
  assert.equal(db.prepare("SELECT created_at FROM interest_signals WHERE article_id = 'legacy'").get().created_at, "2026-09-08");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("archive revision invalidates the cached article vector before semantic retrieval", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-vector-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ file: "issue.json" }] }));
  const issue = { date: "2026-09-09", items: [{ id: "article", title: "Old", fact: "Old fact", topics: [], source: { url: "https://example.test/vector" } }] };
  await writeFile(path.join(dir, "issue.json"), JSON.stringify(issue));
  await syncIssueDirectory(db, dir);
  db.exec("INSERT INTO embeddings VALUES ('old-vector', 'article', NULL, 'model', '[1,0]', 'old-vector')");
  await syncIssueDirectory(db, dir);
  assert.equal(db.prepare("SELECT count(*) AS n FROM embeddings").get().n, 1);
  issue.items[0].fact = "New fact";
  await writeFile(path.join(dir, "issue.json"), JSON.stringify(issue));
  await syncIssueDirectory(db, dir);
  assert.equal(db.prepare("SELECT count(*) AS n FROM embeddings").get().n, 0);
});
