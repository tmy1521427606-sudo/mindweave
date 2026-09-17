import assert from "node:assert/strict";
import test from "node:test";
import { initializeSchema, openDatabase } from "../lib/database.mjs";
import { getDecayedCommentWeights, saveCommentSignals } from "../lib/daily-preferences.mjs";

function database() {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  return db;
}

test("comment signals decay with a fourteen-day half-life", () => {
  const db = database();
  saveCommentSignals(db, {
    issueDate: "2026-09-10",
    comment: "模型对比有用",
    createdAt: "2026-09-11T00:00:00.000Z",
    signals: [{ topic: "模型发布与对比", weight: 1 }],
  });
  assert.deepEqual(getDecayedCommentWeights(db, { asOf: "2026-09-25T00:00:00.000Z" }), {
    模型发布与对比: 0.5,
  });
});

test("combined commentary preferences are clamped and future rows are ignored", () => {
  const db = database();
  for (let day = 1; day <= 3; day += 1) {
    saveCommentSignals(db, {
      issueDate: `2026-09-0${day}`,
      comment: "继续关注",
      createdAt: `2026-09-0${day}T00:00:00.000Z`,
      signals: [{ topic: "Agent 开发与大模型", weight: 1 }],
    });
  }
  saveCommentSignals(db, {
    issueDate: "2026-10-01",
    comment: "未来记录",
    createdAt: "2026-10-01T00:00:00.000Z",
    signals: [{ topic: "Agent 开发与大模型", weight: -1 }],
  });
  assert.equal(getDecayedCommentWeights(db, { asOf: "2026-09-03T00:00:00.000Z" })["Agent 开发与大模型"], 2);
});

test("validates comment, date, timestamp, signal count, topics and weights", () => {
  const db = database();
  const base = {
    issueDate: "2026-09-10",
    comment: "点评",
    createdAt: "2026-09-11T00:00:00.000Z",
    signals: [{ topic: "数据 × Agent", weight: 1 }],
  };
  assert.throws(() => saveCommentSignals(db, { ...base, issueDate: "2026-02-30" }), /issueDate/);
  assert.throws(() => saveCommentSignals(db, { ...base, createdAt: "yesterday" }), /createdAt/);
  assert.throws(() => saveCommentSignals(db, { ...base, comment: "x".repeat(1001) }), /comment/);
  assert.throws(() => saveCommentSignals(db, { ...base, signals: Array.from({ length: 6 }, (_, index) => ({ topic: `主题${index}`, weight: 1 })) }), /five/);
  assert.throws(() => saveCommentSignals(db, { ...base, signals: [{ topic: "未知主题", weight: 1 }] }), /unknown topic/);
  assert.throws(() => saveCommentSignals(db, { ...base, signals: [{ topic: "数据 × Agent", weight: 0 }] }), /weight/);
  assert.throws(() => saveCommentSignals(db, { ...base, signals: [{ topic: "数据 × Agent", weight: 1 }, { topic: "数据 × Agent", weight: -1 }] }), /duplicate topic/);
});

test("an empty comment persists no preference rows", () => {
  const db = database();
  assert.equal(saveCommentSignals(db, {
    issueDate: "2026-09-10", comment: "", createdAt: "2026-09-11T00:00:00.000Z", signals: [],
  }), null);
  assert.deepEqual(getDecayedCommentWeights(db, { asOf: "2026-09-11T00:00:00.000Z" }), {});
});
