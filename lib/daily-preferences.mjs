import { randomUUID } from "node:crypto";

export const BASE_DAILY_TOPICS = Object.freeze([
  "电商 × Agent",
  "数据 × Agent",
  "金融 × 科技",
  "Agent 开发与大模型",
  "模型发布与对比",
  "知识图谱 × Agent",
  "本体论",
  "Wiki × 知识库",
  "Multi-Agent × 工作流",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export function saveCommentSignals(db, { issueDate, comment, signals, createdAt }) {
  requireDatabase(db);
  assertDate(issueDate, "issueDate");
  if (typeof comment !== "string" || comment.length > 1000) throw new TypeError("invalid comment");
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) throw new TypeError("invalid createdAt");
  if (!Array.isArray(signals) || signals.length > 5) throw new TypeError("comment accepts at most five signals");
  if (!comment.trim()) {
    if (signals.length) throw new TypeError("empty comment cannot have signals");
    return null;
  }

  const knownTopics = new Set(BASE_DAILY_TOPICS);
  for (const row of db.prepare("SELECT DISTINCT topic FROM article_topics").all()) knownTopics.add(row.topic);
  const seen = new Set();
  for (const signal of signals) {
    if (!signal || typeof signal.topic !== "string" || !knownTopics.has(signal.topic)) throw new TypeError("unknown topic");
    if (seen.has(signal.topic)) throw new TypeError("duplicate topic");
    if (signal.weight !== -1 && signal.weight !== 1) throw new TypeError("invalid weight");
    seen.add(signal.topic);
  }

  if (signals.length === 0) return null;
  const id = randomUUID();
  const insert = db.prepare(`
    INSERT INTO daily_comment_preferences (id, issue_date, comment, topic, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const signal of signals) insert.run(id, issueDate, comment, signal.topic, signal.weight, new Date(createdTime).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return id;
}

export function getDecayedCommentWeights(db, { asOf }) {
  requireDatabase(db);
  const asOfTime = Date.parse(asOf);
  if (!Number.isFinite(asOfTime)) throw new TypeError("invalid asOf");
  const totals = {};
  for (const row of db.prepare("SELECT topic, weight, created_at AS createdAt FROM daily_comment_preferences").all()) {
    const createdTime = Date.parse(row.createdAt);
    if (!Number.isFinite(createdTime) || createdTime > asOfTime) continue;
    const ageDays = (asOfTime - createdTime) / DAY_MS;
    const decayed = row.weight * 0.5 ** (ageDays / 14);
    totals[row.topic] = Math.max(-2, Math.min(2, (totals[row.topic] ?? 0) + decayed));
  }
  return Object.fromEntries(Object.entries(totals).map(([topic, weight]) => [topic, Number(weight.toFixed(4))]));
}

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`invalid ${name}`);
  }
}

function requireDatabase(db) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
}
