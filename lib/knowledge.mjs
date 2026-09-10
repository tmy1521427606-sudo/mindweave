import { createHash, randomUUID } from "node:crypto";

const CARD_TYPES = new Set(["fact", "concept", "event", "comparison", "relation", "inference"]);
const CARD_STATUSES = new Set(["verified", "needs_review", "rejected", "superseded"]);
const TRUSTED_SOURCE_TYPES = new Set(["官方公告", "官方产品公告", "官方文档", "论文", "政府机构", "GitHub Release", "GitHub Commit"]);
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga"]);

export function normalizeSource(candidate) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("Source is required");
  let parsed;
  try {
    parsed = new URL(candidate.url);
  } catch {
    throw new TypeError("Source URL must be http or https");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Source URL must be http or https");
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const excerpt = String(candidate.excerpt ?? candidate.body ?? "");
  if ([...excerpt].length > 1000) throw new RangeError("Source excerpt must be at most 1,000 Unicode code points");

  return {
    publisher: candidate.publisher ?? candidate.name ?? null,
    title: candidate.title ?? null,
    type: candidate.type ?? null,
    url: parsed.toString(),
    publishedDate: candidate.publishedDate ?? null,
    excerpt,
    contentFingerprint: candidate.contentFingerprint ?? null,
    conflicted: candidate.conflicted === true || candidate.sourceConflict === true || candidate.conflict === true,
  };
}

export function sourceFingerprint(source) {
  const normalized = normalizeSource(source);
  return fingerprint([normalized.publisher, normalized.title, normalized.url, normalized.publishedDate, normalized.type, normalized.excerpt, normalized.contentFingerprint]);
}

export function knowledgeCardFingerprint(card, sources) {
  return fingerprint([card.type, card.text, ...sources.map(sourceFingerprint).sort()]);
}

export function validateKnowledgeCard(candidate) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("Knowledge card is required");
  if (!CARD_TYPES.has(candidate.type)) throw new TypeError("Unsupported knowledge card type");
  if (candidate.status !== undefined && !CARD_STATUSES.has(candidate.status)) throw new TypeError("Unsupported knowledge card status");
  if (typeof candidate.text !== "string" || !candidate.text.trim()) throw new TypeError("Knowledge card text is required");
  const sources = candidate.sources ?? candidate.sourceUrls;
  if (!Array.isArray(sources) || sources.length === 0) throw new TypeError("Knowledge card requires at least one source");
  return { ...candidate, sources };
}

export function decideInitialStatus(card, sources) {
  if (card.type === "inference") return "needs_review";
  const trusted = sources.some(isEligibleSource);
  return trusted && !card.conflicted && !sources.some((source) => source.conflicted) ? "verified" : "needs_review";
}

export function isEligibleSource(source) {
  return TRUSTED_SOURCE_TYPES.has(source.type) && !source.conflicted;
}

export function classifyWebSource(candidate) {
  if (typeof candidate.type === "string" && candidate.type.trim()) return candidate.type;
  const url = new URL(candidate.url);
  if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/releases\/tag\/[^/]+/.test(url.pathname)) return "GitHub Release";
  if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/commit\/[a-f0-9]+$/i.test(url.pathname)) return "GitHub Commit";
  if (url.hostname === "arxiv.org" && /^\/(abs|pdf)\/\d/.test(url.pathname)) return "论文";
  if (/(?:^|\.)gov(?:\.cn)?$/.test(url.hostname)) return "政府机构";
  return "未知来源";
}

export function persistKnowledgeBundle(db, { sources = [], cards = [], relations = [] }) {
  const sourcesByUrl = new Map();
  const sourcesByFingerprint = new Map();
  const sourcesByReference = new Map();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    const previous = sourcesByUrl.get(normalized.url);
    sourcesByUrl.set(normalized.url, previous === null || (previous && sourceFingerprint(previous) !== sourceFingerprint(normalized)) ? null : normalized);
    sourcesByFingerprint.set(sourceFingerprint(normalized), normalized);
    if (source.id) sourcesByReference.set(source.id, normalized);
  }

  db.exec("SAVEPOINT knowledge_bundle");
  try {
    let insertedSources = 0;
    const sourceIds = new Map();
    for (const source of sourcesByFingerprint.values()) {
      const fingerprintValue = sourceFingerprint(source);
      let row = db.prepare("SELECT id FROM knowledge_sources WHERE fingerprint = ?").get(fingerprintValue);
      if (!row) {
        row = { id: randomUUID() };
        db.prepare(`INSERT INTO knowledge_sources (id, fingerprint, url, publisher, title, source_type, published_date, excerpt, content_fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, fingerprintValue, source.url, source.publisher, source.title, source.type, source.publishedDate, source.excerpt, source.contentFingerprint);
        insertedSources += 1;
      }
      sourceIds.set(fingerprintValue, row.id);
    }

    const cardIds = new Map();
    let insertedCards = 0;
    for (const candidate of cards) {
      const card = validateKnowledgeCard(candidate);
      const cardSources = card.sources.map((value) => sourceForReference(value, sourcesByUrl, sourcesByFingerprint, sourcesByReference));
      if (cardSources.some((source) => !source)) throw new TypeError("Knowledge card references an unknown source");
      const conflicted = Boolean(card.conflicted || cardSources.some((source) => source.conflicted));
      const cardFingerprint = knowledgeCardFingerprint(card, cardSources);
      let row = db.prepare("SELECT id FROM knowledge_cards WHERE fingerprint = ?").get(cardFingerprint);
      if (!row) {
        row = { id: card.id ?? randomUUID() };
        if (db.prepare("SELECT 1 FROM knowledge_cards WHERE id = ?").get(row.id)) row.id = randomUUID();
        db.prepare(`INSERT INTO knowledge_cards (id, fingerprint, type, status, text, conflicted, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, cardFingerprint, card.type, decideInitialStatus(card, cardSources), card.text, conflicted ? 1 : 0, new Date().toISOString());
        insertedCards += 1;
      }
      if (conflicted) db.prepare("UPDATE knowledge_cards SET conflicted = 1, status = CASE WHEN status = 'verified' THEN 'needs_review' ELSE status END WHERE id = ?").run(row.id);
      cardIds.set(card.id ?? row.id, row.id);
      for (const source of cardSources) {
        db.prepare("INSERT OR IGNORE INTO knowledge_card_sources (card_id, source_id) VALUES (?, ?)").run(row.id, sourceIds.get(sourceFingerprint(source)));
      }
      for (const topic of card.topics ?? []) {
        if (typeof topic === "string" && topic.trim()) {
          db.prepare("INSERT OR IGNORE INTO knowledge_card_explicit_topics (card_id, topic) VALUES (?, ?)").run(row.id, topic.trim());
          db.prepare("INSERT OR IGNORE INTO card_topics (card_id, topic) VALUES (?, ?)").run(row.id, topic.trim());
        }
      }
      if (card.topicOrigin === "agent") {
        db.prepare("INSERT OR IGNORE INTO knowledge_card_topic_origins (card_id, origin) VALUES (?, 'agent')").run(row.id);
        for (const articleId of card.articleIds ?? []) {
          if (typeof articleId !== "string") continue;
          db.prepare("INSERT OR IGNORE INTO knowledge_card_article_provenance (card_id, article_id) VALUES (?, ?)").run(row.id, articleId);
          db.prepare(`
            INSERT OR IGNORE INTO card_topics (card_id, topic)
            SELECT ?, topic FROM article_topics WHERE article_id = ?
          `).run(row.id, articleId);
        }
      }
    }

    for (const relation of relations) {
      const fromId = cardIds.get(relation.fromCardId ?? relation.from ?? relation.cardId) ?? relation.fromCardId ?? relation.from ?? relation.cardId;
      const toId = relation.toCardId ?? relation.to ?? relation.relatedCardId;
      const relationType = relation.type ?? relation.relationType;
      if (!fromId || !toId || !["supersedes", "conflicts_with", "supports", "related_to"].includes(relationType)) {
        throw new TypeError("Invalid card relation");
      }
      db.prepare("INSERT OR IGNORE INTO card_relations (id, from_card_id, to_card_id, relation_type) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), fromId, toId, relationType);
    }
    db.exec("RELEASE knowledge_bundle");
    return { sources: insertedSources, cards: insertedCards };
  } catch (error) {
    db.exec("ROLLBACK TO knowledge_bundle; RELEASE knowledge_bundle");
    throw error;
  }
}

function sourceForReference(reference, sourcesByUrl, sourcesByFingerprint, sourcesByReference) {
  if (typeof reference === "string") {
    if (sourcesByReference.has(reference)) return sourcesByReference.get(reference);
    try {
      return sourcesByUrl.get(normalizeSource({ url: reference }).url);
    } catch {
      return undefined;
    }
  }
  if (reference && typeof reference === "object") return sourcesByFingerprint.get(sourceFingerprint(reference));
  return undefined;
}

function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
