import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { knowledgeCardFingerprint, normalizeSource, sourceFingerprint } from "./knowledge.mjs";

export function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return db;
}

export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      date TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      url TEXT PRIMARY KEY,
      name TEXT,
      type TEXT
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      issue_date TEXT NOT NULL REFERENCES issues(date),
      title TEXT NOT NULL,
      published_date TEXT,
      source_name TEXT,
      source_url TEXT REFERENCES sources(url),
      payload_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      fts_title TEXT NOT NULL,
      fts_body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS article_topics (
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      PRIMARY KEY (article_id, topic)
    );
    CREATE TABLE IF NOT EXISTS retired_articles (
      article_id TEXT PRIMARY KEY REFERENCES articles(id)
    );
    CREATE TABLE IF NOT EXISTS interest_signals (
      article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      signal TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (article_id, topic, signal)
    );
    CREATE TABLE IF NOT EXISTS daily_comment_preferences (
      id TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      comment TEXT NOT NULL,
      topic TEXT NOT NULL,
      weight INTEGER NOT NULL CHECK (weight IN (-1, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, topic)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
      fts_title,
      fts_body,
      content='articles',
      content_rowid='rowid'
    );
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      publisher TEXT,
      title TEXT,
      source_type TEXT,
      published_date TEXT,
      excerpt TEXT NOT NULL,
      content_fingerprint TEXT
    );
    CREATE TABLE IF NOT EXISTS knowledge_cards (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('fact', 'concept', 'event', 'comparison', 'relation', 'inference')),
      status TEXT NOT NULL CHECK (status IN ('verified', 'needs_review', 'rejected', 'superseded')),
      text TEXT NOT NULL,
      conflicted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_card_sources (
      card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
      PRIMARY KEY (card_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS card_topics (
      card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      PRIMARY KEY (card_id, topic)
    );
    CREATE TABLE IF NOT EXISTS knowledge_card_explicit_topics (
      card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      PRIMARY KEY (card_id, topic)
    );
    CREATE TABLE IF NOT EXISTS knowledge_card_topic_origins (
      card_id TEXT PRIMARY KEY REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin IN ('agent', 'legacy'))
    );
    CREATE TABLE IF NOT EXISTS knowledge_card_article_provenance (
      card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, article_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_topic_migrations (
      name TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
      card_id TEXT REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      CHECK ((article_id IS NOT NULL) != (card_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS card_relations (
      id TEXT PRIMARY KEY,
      from_card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      to_card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'conflicts_with', 'supports', 'related_to')),
      UNIQUE (from_card_id, to_card_id, relation_type)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateSourceVersions(db);
  migrateTopicSignals(db);
  migrateEmbeddingsSchema(db);
  migrateKnowledgeTopicLedger(db);
}

function migrateTopicSignals(db) {
  if (db.prepare("PRAGMA table_info(interest_signals)").all().find((column) => column.name === "article_id").notnull) {
    db.exec(`SAVEPOINT topic_signals;
      ALTER TABLE interest_signals RENAME TO interest_signals_legacy;
      CREATE TABLE interest_signals (article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
        topic TEXT NOT NULL, signal TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (article_id, topic, signal));
      INSERT INTO interest_signals SELECT * FROM interest_signals_legacy;
      DROP TABLE interest_signals_legacy;
      RELEASE topic_signals;`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS topic_signal_once ON interest_signals(topic, signal) WHERE article_id IS NULL");
}

function migrateSourceVersions(db) {
  if (db.prepare("PRAGMA table_info(knowledge_sources)").all().some((column) => column.name === "content_fingerprint")) return;
  // Rebuild the parent table under its original name so existing citation FKs and IDs survive.
  db.exec("PRAGMA foreign_keys = OFF; BEGIN");
  try {
    db.exec(`CREATE TABLE knowledge_sources_versioned (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
      publisher TEXT, title TEXT, source_type TEXT, published_date TEXT, excerpt TEXT NOT NULL, content_fingerprint TEXT
    )`);
    const rows = db.prepare(`SELECT id, url, publisher, title, source_type AS type, published_date AS publishedDate, excerpt FROM knowledge_sources`).all();
    const insert = db.prepare("INSERT INTO knowledge_sources_versioned VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const source of rows) insert.run(source.id, sourceFingerprint(source), source.url, source.publisher, source.title, source.type, source.publishedDate, source.excerpt, null);
    db.exec("DROP TABLE knowledge_sources; ALTER TABLE knowledge_sources_versioned RENAME TO knowledge_sources");
    for (const card of db.prepare("SELECT id, type, text FROM knowledge_cards").all()) {
      const sources = db.prepare(`SELECT s.url, s.publisher, s.title, s.source_type AS type, s.published_date AS publishedDate, s.excerpt
        FROM knowledge_card_sources cs JOIN knowledge_sources s ON s.id = cs.source_id WHERE cs.card_id = ?`).all(card.id);
      db.prepare("UPDATE knowledge_cards SET fingerprint = ? WHERE id = ?").run(knowledgeCardFingerprint(card, sources), card.id);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Source migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateEmbeddingsSchema(db) {
  const columns = db.prepare("PRAGMA table_info(embeddings)").all().map((column) => column.name);
  if (columns.includes("article_id")) return;

  db.exec(`
    ALTER TABLE embeddings RENAME TO embeddings_legacy;
    CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
      card_id TEXT REFERENCES knowledge_cards(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      CHECK ((article_id IS NOT NULL) != (card_id IS NOT NULL))
    );
    INSERT INTO embeddings (id, card_id, model, vector_json, fingerprint)
      SELECT id, card_id, model, vector_json, fingerprint FROM embeddings_legacy;
    DROP TABLE embeddings_legacy;
  `);
}

export async function syncIssueDirectory(db, dataDir) {
  const index = JSON.parse(await readFile(path.join(dataDir, "index.json"), "utf8"));
  let articles = 0;
  const presentIds = new Set();

  for (const issueEntry of index.issues) {
    const issue = JSON.parse(await readFile(path.join(dataDir, issueEntry.file), "utf8"));
    const issuePayload = JSON.stringify(issue);

    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO issues (date, file, payload_json) VALUES (?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET file = excluded.file, payload_json = excluded.payload_json
      `).run(issue.date, issueEntry.file, issuePayload);

      for (const item of issue.items) {
        presentIds.add(item.id);
        const payloadJson = JSON.stringify(item);
        const fingerprint = createHash("sha256").update(payloadJson).digest("hex");
        const source = item.source ?? {};
        const sourceUrl = articleSourceUrl(source, item.id);
        const existing = db.prepare(`SELECT fingerprint, rowid,
          EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = articles.id) AS retired FROM articles WHERE id = ?`).get(item.id);

        db.prepare(`
          INSERT INTO sources (url, name, type) VALUES (?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET name = excluded.name, type = excluded.type
        `).run(sourceUrl, source.name ?? null, source.type ?? null);

        if (!existing || existing.retired || existing.fingerprint !== fingerprint) {
          const ftsBody = searchableText(item);
          db.prepare("DELETE FROM embeddings WHERE article_id = ?").run(item.id);
          if (existing && !existing.retired) db.prepare("DELETE FROM article_fts WHERE rowid = ?").run(existing.rowid);
          db.prepare(`
            INSERT INTO articles (
              id, issue_date, title, published_date, source_name, source_url,
              payload_json, fingerprint, fts_title, fts_body
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              issue_date = excluded.issue_date,
              title = excluded.title,
              published_date = excluded.published_date,
              source_name = excluded.source_name,
              source_url = excluded.source_url,
              payload_json = excluded.payload_json,
              fingerprint = excluded.fingerprint,
              fts_title = excluded.fts_title,
              fts_body = excluded.fts_body
          `).run(
            item.id,
            issue.date,
            item.title ?? "",
            item.publishedDate ?? null,
            source.name ?? null,
            sourceUrl,
            payloadJson,
            fingerprint,
            item.title ?? "",
            ftsBody,
          );

          const row = db.prepare("SELECT rowid FROM articles WHERE id = ?").get(item.id);
          db.prepare("INSERT INTO article_fts (rowid, fts_title, fts_body) VALUES (?, ?, ?)")
            .run(row.rowid, item.title ?? "", ftsBody);
          db.prepare("DELETE FROM article_topics WHERE article_id = ?").run(item.id);
          const insertTopic = db.prepare("INSERT INTO article_topics (article_id, topic) VALUES (?, ?)");
          for (const topic of item.topics ?? []) insertTopic.run(item.id, topic);
        } else {
          db.prepare("UPDATE articles SET source_url = ? WHERE id = ?").run(sourceUrl, item.id);
        }
        db.prepare("DELETE FROM retired_articles WHERE article_id = ?").run(item.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    articles += issue.items.length;
  }

  db.exec("SAVEPOINT reconcile_archive");
  try {
    const current = db.prepare("SELECT a.id, a.rowid FROM articles a WHERE NOT EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = a.id)").all();
    for (const row of current) {
      if (presentIds.has(row.id)) continue;
      db.prepare("DELETE FROM article_fts WHERE rowid = ?").run(row.rowid);
      db.prepare("DELETE FROM article_topics WHERE article_id = ?").run(row.id);
      db.prepare("INSERT INTO retired_articles (article_id) VALUES (?)").run(row.id);
    }
    backfillCardTopics(db);
    db.exec("RELEASE reconcile_archive");
  } catch (error) {
    db.exec("ROLLBACK TO reconcile_archive; RELEASE reconcile_archive");
    throw error;
  }
  return { issues: index.issues.length, articles };
}

export function backfillCardTopics(db) {
  db.exec("SAVEPOINT card_topic_backfill");
  try {
    db.exec(`
      INSERT OR IGNORE INTO knowledge_card_article_provenance (card_id, article_id)
      SELECT kcs.card_id, a.id
      FROM knowledge_card_sources kcs
      JOIN knowledge_sources ks ON ks.id = kcs.source_id
      JOIN articles a ON a.source_url = ks.url
      WHERE NOT EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = a.id) AND NOT EXISTS (
        SELECT 1 FROM knowledge_card_topic_origins origin WHERE origin.card_id = kcs.card_id
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO knowledge_card_topic_origins (card_id, origin)
      SELECT DISTINCT card_id, 'legacy'
      FROM knowledge_card_article_provenance
    `);
    rebuildCardTopicProjection(db);
    db.exec("RELEASE card_topic_backfill");
  } catch (error) {
    db.exec("ROLLBACK TO card_topic_backfill; RELEASE card_topic_backfill");
    throw error;
  }
}

function migrateKnowledgeTopicLedger(db) {
  if (db.prepare("SELECT 1 FROM knowledge_topic_migrations WHERE name = ?").get("explicit_topics_v1")) return;
  db.exec("SAVEPOINT knowledge_topic_migration");
  try {
    db.exec(`
      INSERT OR IGNORE INTO knowledge_card_explicit_topics (card_id, topic)
      SELECT card_id, topic FROM card_topics
    `);
    db.prepare("INSERT INTO knowledge_topic_migrations (name) VALUES (?)").run("explicit_topics_v1");
    db.exec("RELEASE knowledge_topic_migration");
  } catch (error) {
    db.exec("ROLLBACK TO knowledge_topic_migration; RELEASE knowledge_topic_migration");
    throw error;
  }
}

function rebuildCardTopicProjection(db) {
  db.exec("DELETE FROM card_topics");
  db.exec(`
    INSERT OR IGNORE INTO card_topics (card_id, topic)
    SELECT card_id, topic FROM knowledge_card_explicit_topics
  `);
  db.exec(`
    INSERT OR IGNORE INTO card_topics (card_id, topic)
    SELECT provenance.card_id, topics.topic
    FROM knowledge_card_article_provenance provenance
    JOIN article_topics topics ON topics.article_id = provenance.article_id
  `);
}

function articleSourceUrl(source, articleId) {
  try {
    return normalizeSource({ url: source.url, excerpt: "" }).url;
  } catch {
    return `article:${articleId}`;
  }
}

export function searchArticles(db, query, limit = 30) {
  const normalized = String(query).trim().replace(/["']/g, " ");
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (!terms.length || limit === 0) return [];
  const rowLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 30;
  const fts = db.prepare(`
    SELECT a.id, a.issue_date AS issueDate, a.title, a.published_date AS publishedDate,
           a.source_name AS sourceName, a.payload_json AS payloadJson,
           bm25(article_fts) AS rank
    FROM article_fts JOIN articles a ON a.rowid = article_fts.rowid
    WHERE article_fts MATCH ? AND NOT EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = a.id)
    ORDER BY rank, a.issue_date DESC, a.id LIMIT ?
  `).all(terms.map((part) => `"${part}"*`).join(" AND "), rowLimit);
  const substrings = /\p{Script=Han}/u.test(normalized) ? db.prepare(`
    SELECT a.id, a.issue_date AS issueDate, a.title, a.published_date AS publishedDate,
      a.source_name AS sourceName, a.payload_json AS payloadJson, 0 AS rank
    FROM articles a WHERE NOT EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = a.id)
      AND ${terms.map(() => "instr(lower(a.fts_title || ' ' || a.fts_body), lower(?)) > 0").join(" AND ")}
    ORDER BY a.issue_date DESC, a.id LIMIT ?
  `).all(...terms, rowLimit) : [];
  return [...new Map([...fts, ...substrings].map((row) => [row.id, row])).values()].slice(0, rowLimit)
    .map((row) => ({ ...row, item: JSON.parse(row.payloadJson) }));
}

export function getArticle(db, articleId) {
  const row = db.prepare(`
    SELECT id, issue_date AS issueDate, title, published_date AS publishedDate,
           source_name AS sourceName, payload_json AS payloadJson
    FROM articles WHERE id = ? AND NOT EXISTS (SELECT 1 FROM retired_articles r WHERE r.article_id = articles.id)
  `).get(articleId);
  return row ? { ...row, item: JSON.parse(row.payloadJson) } : null;
}

function searchableText(item) {
  return [
    item.fact,
    item.relevance,
    item.oneLineValue,
    ...(item.topics ?? []),
    ...(item.concepts ?? []).flatMap((concept) => [concept.name, concept.explanation]),
  ].filter(Boolean).join(" ");
}
