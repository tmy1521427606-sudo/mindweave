import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, initializeSchema } from "../lib/database.mjs";
import {
  normalizeSource,
  sourceFingerprint,
  validateKnowledgeCard,
  persistKnowledgeBundle,
} from "../lib/knowledge.mjs";

const officialSource = {
  publisher: "OpenAI",
  title: "Model update",
  type: "官方公告",
  url: "https://openai.com/news/model?utm_source=newsletter&version=2",
  publishedDate: "2026-09-09",
  excerpt: "The model is now available.",
};

test("rejects sources whose URL is not HTTP or HTTPS", () => {
  assert.throws(
    () => normalizeSource({ ...officialSource, url: "javascript:alert(1)" }),
    /http or https/i,
  );
});

test("normalizes tracking parameters without merging different resources", () => {
  const normalized = normalizeSource(officialSource);
  assert.equal(normalized.url, "https://openai.com/news/model?version=2");
  assert.notEqual(
    sourceFingerprint(normalized),
    sourceFingerprint(normalizeSource({ ...officialSource, url: "https://openai.com/news/other?version=2" })),
  );
});

test("rejects a full-page source body larger than the excerpt limit", () => {
  assert.throws(
    () => normalizeSource({ ...officialSource, excerpt: "😀".repeat(1001) }),
    /1,000/i,
  );
});

test("requires each knowledge card to cite a source", () => {
  assert.throws(
    () => validateKnowledgeCard({ type: "fact", text: "A claim", sources: [] }),
    /source/i,
  );
});

test("rejects unsupported card types and statuses", () => {
  assert.throws(
    () => validateKnowledgeCard({ type: "opinion", text: "A claim", sources: ["https://example.com"] }),
    /type/i,
  );
  assert.throws(
    () => validateKnowledgeCard({ type: "fact", status: "published", text: "A claim", sources: ["https://example.com"] }),
    /status/i,
  );
});

test("deduplicates normalized source URLs and verifies facts from official sources", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  const result = persistKnowledgeBundle(db, {
    sources: [officialSource, { ...officialSource, url: "https://openai.com/news/model?version=2&utm_medium=email" }],
    cards: [{ type: "fact", text: "Model update is available.", sources: [officialSource.url] }],
    relations: [],
  });

  assert.equal(result.sources, 1);
  assert.equal(result.cards, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_card_sources").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM knowledge_cards").get().status, "verified");
});

test("always marks inference cards as needing review", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  persistKnowledgeBundle(db, {
    sources: [officialSource],
    cards: [{ type: "inference", status: "verified", text: "This implies a faster workflow.", sources: [officialSource.url] }],
    relations: [],
  });

  assert.equal(db.prepare("SELECT status FROM knowledge_cards").get().status, "needs_review");
});

test("preserves existing card text and relates a changed card to it", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  persistKnowledgeBundle(db, {
    sources: [officialSource],
    cards: [{ id: "old", type: "fact", text: "The original claim.", sources: [officialSource.url] }],
    relations: [],
  });
  persistKnowledgeBundle(db, {
    sources: [officialSource],
    cards: [{ id: "old", type: "fact", text: "The revised claim.", sources: [officialSource.url] }],
    relations: [{ fromCardId: "old", toCardId: "old", type: "supersedes" }],
  });

  assert.equal(db.prepare("SELECT text FROM knowledge_cards WHERE id = 'old'").get().text, "The original claim.");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_cards").get().count, 2);
  const relation = db.prepare("SELECT from_card_id AS fromCardId, to_card_id AS toCardId, relation_type AS relationType FROM card_relations").get();
  assert.equal(relation.relationType, "supersedes");
  assert.equal(relation.toCardId, "old");
  assert.notEqual(relation.fromCardId, "old");
});

test("embeddings require exactly one article or knowledge card owner", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  db.exec("INSERT INTO issues (date, file, payload_json) VALUES ('2026-09-09', 'issue.json', '{}')");
  db.exec(`INSERT INTO articles (id, issue_date, title, payload_json, fingerprint, fts_title, fts_body)
    VALUES ('article-1', '2026-09-09', 'Article', '{}', 'article-fingerprint', 'Article', '')`);
  db.exec(`INSERT INTO knowledge_cards (id, fingerprint, type, status, text, conflicted, created_at)
    VALUES ('card-1', 'card-fingerprint', 'fact', 'verified', 'Claim', 0, '2026-09-09T00:00:00.000Z')`);

  const insert = db.prepare("INSERT INTO embeddings (id, article_id, card_id, model, vector_json, fingerprint) VALUES (?, ?, ?, ?, ?, ?)");
  assert.doesNotThrow(() => insert.run("article-embedding", "article-1", null, "test", "[0.1]", "article-vector"));
  assert.doesNotThrow(() => insert.run("card-embedding", null, "card-1", "test", "[0.2]", "card-vector"));
  assert.throws(() => insert.run("missing-owner", null, null, "test", "[0.3]", "missing-vector"));
  assert.throws(() => insert.run("two-owners", "article-1", "card-1", "test", "[0.4]", "two-vector"));
});

test("same-URL price revisions retain each card's exact evidence snapshot and deduplicate repeats", (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  const oldSource = { ...officialSource, excerpt: "Price: 10" };
  const newSource = { ...officialSource, excerpt: "Price: 20", contentFingerprint: "revision-2" };
  for (const [id, source] of [["old-price", oldSource], ["new-price", newSource]]) {
    persistKnowledgeBundle(db, { sources: [source], cards: [{ id, type: "fact", text: source.excerpt, sources: [source.url] }] });
  }
  const rows = db.prepare(`SELECT c.id, s.id AS sourceId, s.excerpt FROM knowledge_cards c
    JOIN knowledge_card_sources cs ON cs.card_id = c.id JOIN knowledge_sources s ON s.id = cs.source_id ORDER BY c.id`).all();
  assert.deepEqual(rows.map(({ id, excerpt }) => [id, excerpt]), [["new-price", "Price: 20"], ["old-price", "Price: 10"]]);
  assert.notEqual(rows[0].sourceId, rows[1].sourceId);
  assert.deepEqual(persistKnowledgeBundle(db, { sources: [newSource], cards: [{ type: "fact", text: "Price: 20", sources: [newSource.url] }] }), { sources: 0, cards: 0 });
  assert.notEqual(sourceFingerprint(newSource), sourceFingerprint({ ...newSource, contentFingerprint: "revision-3" }));
});

test("migrates unique-URL sources without changing old citations and allows a later evidence version", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE knowledge_sources (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, url TEXT NOT NULL UNIQUE,
    publisher TEXT, title TEXT, source_type TEXT, published_date TEXT, excerpt TEXT NOT NULL);
    CREATE TABLE knowledge_cards (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      status TEXT NOT NULL, text TEXT NOT NULL, conflicted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE knowledge_card_sources (card_id TEXT NOT NULL REFERENCES knowledge_cards(id), source_id TEXT NOT NULL REFERENCES knowledge_sources(id), PRIMARY KEY (card_id, source_id));
    INSERT INTO knowledge_sources VALUES ('old-source', 'old-hash', 'https://example.test/price', '官方', 'Price', '官方文档', '2026-09-09', 'Price: 10');
    INSERT INTO knowledge_cards VALUES ('old-card', 'old-card-hash', 'fact', 'verified', 'Price: 10', 0, '2026-09-09');
    INSERT INTO knowledge_card_sources VALUES ('old-card', 'old-source');`);
  initializeSchema(db);
  initializeSchema(db);
  const oldSource = { url: "https://example.test/price", publisher: "官方", title: "Price", type: "官方文档", publishedDate: "2026-09-09", excerpt: "Price: 10" };
  assert.deepEqual(persistKnowledgeBundle(db, { sources: [oldSource], cards: [{ type: "fact", text: "Price: 10", sources: [oldSource.url] }] }), { sources: 0, cards: 0 });
  persistKnowledgeBundle(db, { sources: [{ ...oldSource, excerpt: "Price: 20" }], cards: [{ id: "new-card", type: "fact", text: "Price: 20", sources: [oldSource.url] }] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_sources").get().n, 2);
  assert.equal(db.prepare("SELECT source_id FROM knowledge_card_sources WHERE card_id = 'old-card'").get().source_id, "old-source");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a bundle can cite two same-URL versions by source ID without conflating them", (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  persistKnowledgeBundle(db, { sources: [
    { ...officialSource, id: "before", excerpt: "Price: 10" },
    { ...officialSource, id: "after", excerpt: "Price: 20" },
  ], cards: [{ id: "comparison", type: "comparison", text: "Price changed from 10 to 20", sources: ["before", "after"] }] });
  assert.deepEqual(db.prepare(`SELECT s.excerpt FROM knowledge_card_sources cs JOIN knowledge_sources s ON s.id = cs.source_id
    WHERE cs.card_id = 'comparison' ORDER BY s.excerpt`).all().map((row) => row.excerpt), ["Price: 10", "Price: 20"]);
});

test("legacy card-only embedding rows survive the dual-owner migration", (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  persistKnowledgeBundle(db, { sources: [officialSource], cards: [{ id: "legacy-vector-card", type: "concept", text: "Legacy vector", sources: [officialSource.url] }] });
  db.exec(`DROP TABLE embeddings;
    CREATE TABLE embeddings (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES knowledge_cards(id), model TEXT NOT NULL, vector_json TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE);
    INSERT INTO embeddings VALUES ('legacy-vector', 'legacy-vector-card', 'old-model', '[0.6,0.8]', 'legacy-hash');`);
  initializeSchema(db);
  initializeSchema(db);
  assert.deepEqual({ ...db.prepare("SELECT * FROM embeddings").get() }, { id: "legacy-vector", article_id: null, card_id: "legacy-vector-card", model: "old-model", vector_json: "[0.6,0.8]", fingerprint: "legacy-hash" });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("newly reported conflict downgrades a duplicate card without duplicating or overwriting it", (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  const card = { id: "conflict", type: "fact", text: "Available", sources: [officialSource.url] };
  persistKnowledgeBundle(db, { sources: [officialSource], cards: [card] });
  persistKnowledgeBundle(db, { sources: [{ ...officialSource, conflicted: true }], cards: [card] });
  const row = db.prepare("SELECT status, conflicted, text FROM knowledge_cards WHERE id = 'conflict'").get();
  assert.deepEqual({ ...row }, { status: "needs_review", conflicted: 1, text: "Available" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_cards").get().n, 1);
});
