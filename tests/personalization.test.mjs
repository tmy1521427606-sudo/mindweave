import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSignal,
  getProfile,
  personalizedBoost,
  scoreSignals,
  setInterestSignal,
} from "../lib/personalization.mjs";
import { initializeSchema, openDatabase } from "../lib/database.mjs";

test("follow outweighs bookmark while irrelevant reduces topic affinity", () => {
  const profile = scoreSignals([
    { topic: "Agent 开发", signal: "follow", enabled: true },
    { topic: "Agent 开发", signal: "bookmark", enabled: true },
    { topic: "金融 × 科技", signal: "irrelevant", enabled: true },
  ]);
  assert.equal(profile.topics["Agent 开发"], 4);
  assert.equal(profile.topics["金融 × 科技"], -3);
  assert.ok(personalizedBoost({ topics: ["Agent 开发"] }, profile) > 0);
});

test("profile separates learning depth and preferred angles from topic ranking", () => {
  const profile = scoreSignals([
    { topic: "Agent 开发", signal: "needFoundation", enabled: true },
    { topic: "Agent 开发", signal: "known", enabled: true },
    { topic: "Agent 开发", signal: "wantTechnical", enabled: true },
    { topic: "Agent 开发", signal: "wantBusiness", enabled: true },
    { topic: "Agent 开发", signal: "follow", enabled: false },
  ]);
  assert.equal(profile.topics["Agent 开发"], 0);
  assert.equal(profile.depth, 0);
  assert.deepEqual(profile.angles, { technical: 2, business: 2 });
  assert.equal(profile.evidenceCount, 4);
});

test("interest signals apply to every topic on an article and can be removed", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  db.exec(`
    INSERT INTO issues (date, file, payload_json) VALUES ('2026-09-09', 'issue.json', '{}');
    INSERT INTO sources (url) VALUES ('article:a1');
    INSERT INTO articles (
      id, issue_date, title, source_url, payload_json, fingerprint, fts_title, fts_body
    ) VALUES (
      'a1', '2026-09-09', 'Article', 'article:a1',
      '{"id":"a1","topics":["Agent 开发","金融 × 科技"]}', 'fingerprint', 'Article', ''
    );
  `);

  setInterestSignal(db, "a1", "follow", true, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(
    db.prepare("SELECT topic, signal, created_at FROM interest_signals ORDER BY topic").all().map((row) => ({ ...row })),
    [
      { topic: "Agent 开发", signal: "follow", created_at: "2026-09-09T00:00:00.000Z" },
      { topic: "金融 × 科技", signal: "follow", created_at: "2026-09-09T00:00:00.000Z" },
    ],
  );
  assert.deepEqual(getProfile(db).topics, { "Agent 开发": 3, "金融 × 科技": 3 });
  assert.deepEqual(getProfile(db).articleSignals, { a1: ["follow"] });

  setInterestSignal(db, "a1", "follow", true, "2026-09-10T00:00:00.000Z");
  assert.equal(db.prepare("SELECT count(*) AS n FROM interest_signals").get().n, 2);
  assert.deepEqual(db.prepare("SELECT DISTINCT created_at FROM interest_signals").all().map((row) => row.created_at), ["2026-09-10T00:00:00.000Z"]);

  setInterestSignal(db, "a1", "follow", false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interest_signals").get().count, 0);
  assert.deepEqual(getProfile(db).articleSignals, {});
});

test("unknown interest signals are rejected", () => {
  assert.throws(() => assertSignal("not-real"), { name: "TypeError", message: "未知兴趣信号" });
});

test("less-like-this reduces affinity and every article boost is capped at six", () => {
  const profile = scoreSignals([
    { topic: "Agent 开发", signal: "lessLikeThis", enabled: true },
    { topic: "Agent 开发", signal: "follow", enabled: true },
    { topic: "Agent 开发", signal: "moreLikeThis", enabled: true },
    { topic: "Agent 开发", signal: "bookmark", enabled: true },
    { topic: "超额主题", signal: "follow", enabled: true },
    { topic: "超额主题", signal: "follow", enabled: true },
    { topic: "超额主题", signal: "follow", enabled: true },
  ]);
  assert.equal(profile.topics["Agent 开发"], 5);
  assert.equal(personalizedBoost({ topics: ["超额主题", "超额主题", "超额主题"] }, profile), 6);
  assert.equal(personalizedBoost({ topics: ["负向", "负向", "负向"] }, { topics: { "负向": -3 } }), -6);
});

test("enabling a topic-preference choice replaces its competing choice only", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  db.exec(`
    INSERT INTO issues (date, file, payload_json) VALUES ('2026-09-09', 'issue.json', '{}');
    INSERT INTO sources (url) VALUES ('article:a1');
    INSERT INTO articles (
      id, issue_date, title, source_url, payload_json, fingerprint, fts_title, fts_body
    ) VALUES (
      'a1', '2026-09-09', 'Article', 'article:a1',
      '{"id":"a1","topics":["Agent 开发"]}', 'fingerprint', 'Article', ''
    );
  `);

  setInterestSignal(db, "a1", "follow", true);
  setInterestSignal(db, "a1", "moreLikeThis", true);
  setInterestSignal(db, "a1", "lessLikeThis", true);
  assert.deepEqual(getProfile(db).articleSignals, { a1: ["follow", "lessLikeThis"] });

  setInterestSignal(db, "a1", "irrelevant", true);
  assert.deepEqual(getProfile(db).articleSignals, { a1: ["follow", "irrelevant"] });
});
