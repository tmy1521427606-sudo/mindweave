import { getArticle } from "./database.mjs";

export const SIGNAL_WEIGHTS = Object.freeze({
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

export function assertSignal(signal) {
  if (!Object.hasOwn(SIGNAL_WEIGHTS, signal)) throw new TypeError("未知兴趣信号");
  return signal;
}

export function scoreSignals(signals) {
  const profile = {
    topics: {},
    depth: 0,
    angles: { technical: 0, business: 0 },
    evidenceCount: 0,
  };

  for (const { topic, signal, enabled } of signals) {
    assertSignal(signal);
    if (!enabled) continue;
    profile.topics[topic] = (profile.topics[topic] ?? 0) + SIGNAL_WEIGHTS[signal];
    if (signal === "needFoundation") profile.depth -= 1;
    if (signal === "known") profile.depth += 1;
    if (signal === "wantTechnical") profile.angles.technical += 2;
    if (signal === "wantBusiness") profile.angles.business += 2;
    profile.evidenceCount += 1;
  }

  return profile;
}

export function setInterestSignal(db, articleId, signal, enabled, now = new Date().toISOString()) {
  assertSignal(signal);
  const article = getArticle(db, articleId);
  if (!article) throw new RangeError("文章不存在");

  const topics = [...new Set(article.item.topics ?? [])];
  if (enabled) {
    if (["moreLikeThis", "lessLikeThis", "irrelevant"].includes(signal)) {
      db.prepare(`
        DELETE FROM interest_signals
        WHERE article_id = ? AND signal IN ('moreLikeThis', 'lessLikeThis', 'irrelevant')
      `).run(articleId);
    }
    const insert = db.prepare(`
      INSERT INTO interest_signals (article_id, topic, signal, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(article_id, topic, signal) DO UPDATE SET created_at = excluded.created_at
    `);
    for (const topic of topics) insert.run(articleId, topic, signal, String(now));
  } else {
    const remove = db.prepare("DELETE FROM interest_signals WHERE article_id = ? AND signal = ?");
    remove.run(articleId, signal);
  }
}

export function getProfile(db) {
  const signals = db.prepare(`
    SELECT article_id AS articleId, topic, signal, 1 AS enabled
    FROM interest_signals ORDER BY created_at, article_id, topic, signal
  `).all();
  const profile = scoreSignals(signals);
  const grouped = new Map();
  for (const { articleId, signal } of signals) {
    if (articleId === null) continue;
    if (!grouped.has(articleId)) grouped.set(articleId, new Set());
    grouped.get(articleId).add(signal);
  }
  profile.articleSignals = Object.fromEntries(
    [...grouped].map(([articleId, values]) => [articleId, [...values]]),
  );
  return profile;
}

export function setTopicPreference(db, topic, action, now = new Date().toISOString()) {
  if (!["lower", "reset", "unfollow"].includes(action)) throw new TypeError("未知主题操作");
  if (!db.prepare("SELECT 1 FROM article_topics WHERE topic = ? UNION SELECT 1 FROM interest_signals WHERE topic = ? LIMIT 1").get(topic, topic)) throw new RangeError("主题不存在");
  if (action === "lower") {
    db.prepare(`INSERT INTO interest_signals (article_id, topic, signal, created_at) VALUES (NULL, ?, 'lessLikeThis', ?)
      ON CONFLICT(topic, signal) WHERE article_id IS NULL DO UPDATE SET created_at = excluded.created_at`).run(topic, now);
  } else if (action === "unfollow") {
    db.prepare("DELETE FROM interest_signals WHERE topic = ? AND signal = 'follow'").run(topic);
  } else {
    db.prepare("DELETE FROM interest_signals WHERE topic = ?").run(topic);
  }
}

export function personalizedBoost(item, profile) {
  const raw = (item.topics ?? []).reduce(
    (sum, topic) => sum + (profile.topics?.[topic] ?? 0),
    0,
  );
  return Math.max(-6, Math.min(6, raw));
}
