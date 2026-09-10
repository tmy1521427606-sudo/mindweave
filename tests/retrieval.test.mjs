import assert from "node:assert/strict";
import test from "node:test";
import { cosineSimilarity, mergeEvidence, shouldSearchWeb } from "../lib/retrieval.mjs";

test("Chinese comparisons require complete and recent evidence", () => {
  const options = { query: "豆包和扣子", requiredObjects: ["豆包", "扣子"], now: new Date("2026-09-09") };
  assert.equal(shouldSearchWeb({ ...options, evidence: [{ score: 0.9, namedObjects: ["豆包"], publishedDate: "2026-09-09" }] }), true);
  assert.equal(shouldSearchWeb({ ...options, evidence: [{ score: 0.9, namedObjects: ["豆包", "扣子"], publishedDate: "2020-01-01" }] }), true);
  assert.equal(shouldSearchWeb({ ...options, evidence: [{ score: 0.9, namedObjects: ["豆包", "扣子"], publishedDate: "2026-09-09" }] }), false);
});

test("cosine similarity normalizes vectors", () => {
  assert.equal(cosineSimilarity([3, 4], [0, 5]), 0.8);
});

test("cosine similarity rejects unequal dimensions and non-finite values", () => {
  assert.throws(() => cosineSimilarity([1], [1, 2]), RangeError);
  assert.throws(() => cosineSimilarity([1, Infinity], [1, 2]), TypeError);
});

test("mergeEvidence deduplicates source URLs and retains the best score", () => {
  const result = mergeEvidence({
    ftsHits: [
      { id: "a", sourceUrl: "https://example.test/a", score: 0.7 },
      { id: "b", score: 0.8 },
    ],
    vectorHits: [
      { id: "a", sourceUrl: "https://example.test/a", score: 0.9 },
      { id: "b", score: 0.5 },
    ],
  });

  assert.deepEqual(result, [
    { id: "a", sourceUrl: "https://example.test/a", score: 0.9 },
    { id: "b", score: 0.8 },
  ]);
});

test("mergeEvidence joins evidence sharing either article ID or source URL", () => {
  const result = mergeEvidence({
    ftsHits: [
      { id: "article-a", sourceUrl: "https://example.test/a", score: 0.7 },
      { id: "article-c", sourceUrl: "https://example.test/c", score: 0.6 },
    ],
    vectorHits: [
      { id: "article-a", sourceUrl: "https://example.test/b", score: 0.9 },
      { id: "article-d", sourceUrl: "https://example.test/c", score: 0.8 },
    ],
  });

  assert.deepEqual(result, [
    { id: "article-a", sourceUrl: "https://example.test/b", score: 0.9 },
    { id: "article-d", sourceUrl: "https://example.test/c", score: 0.8 },
  ]);
});

test("freshness language forces web search even with local evidence", () => {
  assert.equal(shouldSearchWeb({ query: "豆包今天发布了什么", evidence: [{ score: 0.95, publishedDate: "2026-09-08" }], now: new Date("2026-09-09") }), true);
});

test("strong fresh local coverage stays local", () => {
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2026-09-08" }], now: new Date("2026-09-09") }), false);
});

test("explicit required Chinese objects require complete evidence coverage", () => {
  const common = { query: "豆包和扣子有什么关系", now: new Date("2026-09-09"), requiredObjects: ["豆包", "扣子"] };
  assert.equal(shouldSearchWeb({ ...common, evidence: [{ score: 0.9, publishedDate: "2026-09-08", namedObjects: ["豆包"] }] }), true);
  assert.equal(shouldSearchWeb({ ...common, evidence: [{ score: 0.9, publishedDate: "2026-09-08", namedObjects: ["豆包", "扣子"] }] }), false);
});

test("required objects are incomplete when evidence has no coverage metadata", () => {
  assert.equal(shouldSearchWeb({
    query: "豆包和扣子有什么关系",
    requiredObjects: ["豆包", "扣子"],
    evidence: [{ score: 0.9, publishedDate: "2026-09-08" }],
    now: new Date("2026-09-09"),
  }), true);
});

test("stale or invalid evidence triggers web search unless age policy permits it", () => {
  const now = new Date("2026-09-09");
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2020-01-01" }], now }), true);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "not-a-date" }], now }), true);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2026-09-08" }], now }), false);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2020-01-01" }], now, maxEvidenceAgeDays: Infinity }), false);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2026-09-07" }], now, maxEvidenceAgeDays: 1 }), true);
});

test("an impossible February 30 date cannot be normalized into fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2026-02-30" }],
    now: new Date("2026-03-02"),
  }), true);
});

test("an impossible April 31 date cannot be normalized into fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2026-04-31" }],
    now: new Date("2026-05-01"),
  }), true);
});

test("a non-leap-year February 29 date cannot be normalized into fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2025-02-29" }],
    now: new Date("2025-03-01"),
  }), true);
});

test("a legal leap day and the previous day remain fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2024-02-29" }],
    now: new Date("2024-03-01"),
  }), false);
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2026-04-30" }],
    now: new Date("2026-05-01"),
  }), false);
});

test("a strict UTC datetime without seconds remains fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2026-09-08T12:30Z" }],
    now: new Date("2026-09-09T12:30Z"),
  }), false);
});

test("a strict offset datetime without seconds remains fresh evidence", () => {
  assert.equal(shouldSearchWeb({
    query: "解释 RAG",
    evidence: [{ score: 0.9, publishedDate: "2026-09-08T20:30+08:00" }],
    now: new Date("2026-09-09T12:30Z"),
  }), false);
});

test("weak, absent, incomplete, and conflicting coverage searches the web", () => {
  const now = new Date("2026-09-09");
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [], now }), true);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.61, publishedDate: "2026-09-08" }], now }), true);
  assert.equal(shouldSearchWeb({ query: "OpenAI 和 Anthropic 的关系", evidence: [{ score: 0.9, publishedDate: "2026-09-08", namedObjects: ["OpenAI"] }], now }), true);
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2026-09-08", sourceConflict: true }], now }), true);
});
