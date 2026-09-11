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

test("searches the previous Shanghai calendar day without expanding when enough candidates exist", async () => {
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
  assert.ok(calls.every(({ options }) => options.startDate === "2026-09-10" && options.endDate === "2026-09-10"));
  assert.equal(calls.length, plan.yesterday.queries.length);
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

test("rejects candidates without a trustworthy publication date", async () => {
  const plan = buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} });
  const candidates = await collectCandidates({
    search: async () => [
      { title: "Undated", url: "https://example.com/undated", content: "The model must not invent a date." },
      { title: "Old", url: "https://example.com/old", content: "Outside the requested window.", published_date: "2026-08-01" },
      { title: "Dated", url: "https://example.com/dated", content: "A dated source.", published_date: "2026-09-10" },
    ],
    plan,
  });
  assert.ok(candidates.every((candidate) => candidate.publishedDate === "2026-09-10"));
  assert.ok(candidates.every((candidate) => !candidate.url.endsWith("/undated")));
  assert.ok(candidates.every((candidate) => !candidate.url.endsWith("/old")));
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
