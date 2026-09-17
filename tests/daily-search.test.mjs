import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchPlan, collectCandidates } from "../lib/daily-search.mjs";

function results(count, prefix = "official") {
  return Array.from({ length: count }, (_, index) => ({
    title: `${prefix} result ${index}`,
    url: `https://${prefix}.example.com/news/${index}`,
    content: `Result ${index} contains enough public source context for screening.`,
    published_date: "2026-09-10",
  }));
}

test("searches one calendar day with a non-empty Tavily range without expanding", async () => {
  const calls = [];
  const plan = buildSearchPlan({
    date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {},
  });
  const candidates = await collectCandidates({
    search: async (query, options) => {
      calls.push({ query, options });
      return results(2, `source${calls.length}`);
    },
    plan,
  });
  assert.ok(candidates.length >= 10);
  assert.ok(calls.every(({ options }) => options.topic === "news" && options.startDate === "2026-09-10" && options.endDate === "2026-09-11"));
  assert.equal(calls.length, plan.yesterday.queries.length);
});

test("starts catch-up coverage the day after the latest previous issue", () => {
  const plan = buildSearchPlan({
    date: "2026-09-11", lastIssueDate: "2026-09-07", focusMore: [], focusLess: [], temporaryFocus: "", profile: {},
  });
  assert.deepEqual(
    { startDate: plan.yesterday.startDate, endDate: plan.yesterday.endDate },
    { startDate: "2026-09-08", endDate: "2026-09-10" },
  );
});

test("limits catch-up coverage to the latest seven days", () => {
  const plan = buildSearchPlan({
    date: "2026-09-11", lastIssueDate: "2026-08-20", focusMore: [], focusLess: [], temporaryFocus: "", profile: {},
  });
  assert.deepEqual(
    { startDate: plan.yesterday.startDate, endDate: plan.yesterday.endDate },
    { startDate: "2026-09-04", endDate: "2026-09-10" },
  );
});

test("search plan includes dedicated domestic model and Agent coverage", () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const queries = plan.yesterday.queries.map((entry) => entry.query).join(" ");
  assert.match(queries, /豆包/);
  assert.match(queries, /通义/);
  assert.match(queries, /混元/);
  assert.match(queries, /DeepSeek/);
  assert.ok(plan.yesterday.queries.length >= 8);
});

test("expands to seven days only when yesterday has fewer than ten candidates", async () => {
  const calls = [];
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const candidates = await collectCandidates({
    search: async (query, options) => {
      calls.push({ query, options });
      return options.startDate === "2026-09-10" ? [] : results(2, `expanded${calls.length}`);
    },
    plan,
  });
  assert.ok(candidates.length >= 10);
  assert.ok(calls.some(({ options }) => options.startDate === "2026-09-04" && options.endDate === "2026-09-10"));
});

test("deduplicates tracking URLs and rejects unsafe result hosts", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const candidates = await collectCandidates({
    search: async () => [
      { title: "A", url: "https://openai.com/news/a?utm_source=x", content: "first", published_date: "2026-09-10" },
      { title: "A duplicate", url: "https://openai.com/news/a?utm_medium=y", content: "second", published_date: "2026-09-10" },
      { title: "Local", url: "https://127.0.0.1/a", content: "unsafe", published_date: "2026-09-10" },
      { title: "Private", url: "https://10.0.0.8/a", content: "unsafe", published_date: "2026-09-10" },
      { title: "Plain HTTP", url: "http://example.com/a", content: "unsafe", published_date: "2026-09-10" },
    ],
    plan,
  });
  assert.equal(candidates.filter((entry) => entry.url === "https://openai.com/news/a").length, 1);
  assert.ok(candidates.every((entry) => !/127\.0\.0\.1|10\.0\.0\.8/.test(entry.url)));
});

test("excludes normalized source URLs that appeared in earlier issues", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const progress = [];
  const candidates = await collectCandidates({
    search: async () => [
      { title: "Already covered", url: "https://openai.com/news/a?utm_source=again", content: "old source", published_date: "2026-09-10" },
      { title: "New follow-up", url: "https://openai.com/news/a-follow-up", content: "new source", published_date: "2026-09-10" },
    ],
    plan,
    excludedUrls: ["https://openai.com/news/a?ref=history"],
    onProgress: (value) => progress.push(value),
  });
  assert.ok(candidates.every((candidate) => candidate.url !== "https://openai.com/news/a"));
  assert.ok(candidates.some((candidate) => candidate.url === "https://openai.com/news/a-follow-up"));
  assert.ok(progress.at(-1).discarded.duplicate > 0);
});

test("rejects missing dates from news while retaining them only for technical learning", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const progress = [];
  const candidates = await collectCandidates({
    search: async () => [
      { title: "Undated", url: "https://example.com/undated", content: "The model must not invent a date." },
      { title: "Old", url: "https://example.com/old", content: "Outside the requested window.", published_date: "2026-08-01" },
      { title: "Dated", url: "https://example.com/dated", content: "A dated source.", published_date: "2026-09-10" },
    ],
    plan,
    onProgress: (value) => progress.push(value),
  });
  assert.ok(candidates.every((candidate) => candidate.publishedDate === "2026-09-10"
    || candidate.publishedDate === null && candidate.contentTypeHint === "learning" && candidate.dateStatus === "unverified"));
  assert.ok(candidates.every((candidate) => !candidate.url.endsWith("/undated") || candidate.contentTypeHint === "learning"));
  assert.ok(candidates.every((candidate) => !candidate.url.endsWith("/old")));
  assert.ok(progress.at(-1).discarded.missingDate > 0);
  assert.ok(progress.at(-1).discarded.outsideWindow > 0);
});

test("verifies a missing Tavily date from source metadata before accepting news", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const resolved = [];
  const candidates = await collectCandidates({
    search: async () => [{ title: "Official release", url: "https://example.com/release", content: "Release details." }],
    resolvePublishedDate: async (url) => { resolved.push(url); return "2026-09-10"; },
    plan,
  });
  assert.ok(resolved.length > 0);
  assert.ok(candidates.some((candidate) => candidate.publishedDate === "2026-09-10" && candidate.dateStatus === "verified"));
});

test("keeps an unresolved technical result only as an unverified learning candidate", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const candidates = await collectCandidates({
    search: async (query) => query.includes("framework")
      ? [{ title: "Agent architecture", url: "https://example.com/agent", content: "Technical architecture details." }]
      : [],
    resolvePublishedDate: async () => null,
    plan,
  });
  assert.ok(candidates.some((candidate) => candidate.url === "https://example.com/agent"
    && candidate.publishedDate === null
    && candidate.dateStatus === "unverified"
    && candidate.contentTypeHint === "learning"));
});

test("continues successful directions when one query fails and reports progress", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: ["数据 × Agent"], focusLess: [], temporaryFocus: "条码", profile: {} });
  const progress = [];
  let call = 0;
  const candidates = await collectCandidates({
    search: async () => {
      call += 1;
      if (call === 1) throw new Error("search failed with secret body");
      return results(2, `ok${call}`);
    },
    plan,
    onProgress: (value) => progress.push(value),
  });
  assert.ok(candidates.length >= 10);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((value) => !("error" in value)));
});

test("validates daily search inputs", () => {
  assert.throws(() => buildSearchPlan({ date: "2026-02-30", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} }), /date/);
  assert.throws(() => buildSearchPlan({ date: "2026-09-11", focusMore: ["A"], focusLess: ["A"], temporaryFocus: "", profile: {} }), /overlap/);
  assert.throws(() => buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "x".repeat(301), profile: {} }), /temporaryFocus/);
});
