import assert from "node:assert/strict";
import test from "node:test";
import {
  DailyContentError,
  extractCommentSignals,
  generateIssueContent,
  validateGeneratedIssue,
} from "../lib/daily-content.mjs";

const topics = ["电商 × Agent", "数据 × Agent", "金融 × 科技"];

function candidates(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://official${index}.example.com/news`,
    title: `Candidate ${index}`,
    publisher: `Official ${index}`,
    publishedDate: index < 8 ? "2026-09-11" : "2026-09-10",
    excerpt: `Primary source excerpt ${index}`,
    sourceType: "官方公告",
    topics: [topics[index % topics.length]],
    preference: 0,
    window: index < 8 ? "yesterday" : "expanded",
  }));
}

function generated(candidateId, index = 0) {
  return {
    candidateId,
    title: `Generated ${index}`,
    publishedDate: index < 8 ? "2026-09-11" : "2026-09-10",
    contentType: index >= 8 ? "learning" : "news",
    region: index % 2 ? "国内" : "海外",
    priority: "关注",
    topics: [topics[index % topics.length]],
    fact: `可核验事实 ${index}`,
    sourceView: null,
    background: `这是用于解释候选事件背景的完整说明，帮助读者区分事实、行业背景和可能产生的实际影响。${index}`,
    development: ["此前状态", "当前变化"],
    impact: [{ audience: "从业者", text: "需要评估真实任务影响。" }],
    relevance: "与个人学习方向有关。",
    concepts: [{ name: "概念", explanation: "可检查的基础解释。" }],
    connections: "连接其他行业。",
    uncertainty: "尚无独立效果验证。",
    action: "阅读原始来源并记录判断。",
    oneLineValue: `一句话价值 ${index}`,
    score: { interest: 20, impact: 15, source: 20, novelty: 10, crossDomain: 8, actionability: 5 },
  };
}

function fakeDoubao({ invalidSource = false, failFirst = false } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async chat(request) {
      calls += 1;
      if (failFirst && calls === 1) throw new Error("temporary model failure");
      const body = JSON.parse(request.messages.at(-1).content);
      return {
        items: body.untrustedCandidates.map((candidate, index) => generated(
          invalidSource && calls === 1 && index === 0 ? "unknown" : candidate.id,
          candidate.sequence,
        )),
      };
    },
  };
}

test("generates a validated 10-30 item issue and resolves trusted sources", async () => {
  const issue = await generateIssueContent({
    doubao: fakeDoubao(), date: "2026-09-11", candidates: candidates(), preferences: {}, existingItems: [],
  });
  assert.equal(issue.items.length, 12);
  assert.equal(issue.items[0].source.url, "https://official0.example.com/news");
  assert.equal(issue.items[0].score.total, 78);
  assert.ok(new Set(issue.items.flatMap((item) => item.topics)).size >= 3);
  assert.equal(issue.summary.length, 4);
});

test("limits detailed generation requests to two items so slow models can finish each batch", async () => {
  const batchSizes = [];
  const doubao = { async chat(request) {
    const body = JSON.parse(request.messages.at(-1).content);
    batchSizes.push(body.untrustedCandidates.length);
    return {
      items: body.untrustedCandidates.map((candidate) => generated(candidate.id, candidate.sequence)),
    };
  } };

  const issue = await generateIssueContent({
    doubao, date: "2026-09-11", candidates: candidates(10), preferences: {}, existingItems: [],
  });

  assert.equal(issue.items.length, 10);
  assert.deepEqual(batchSizes, [2, 2, 2, 2, 2]);
});

test("runs two detailed generation batches concurrently while preserving item order", async () => {
  let active = 0;
  let maximumActive = 0;
  const doubao = { async chat(request) {
    const body = JSON.parse(request.messages.at(-1).content);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return {
      items: body.untrustedCandidates.map((candidate) => generated(candidate.id, candidate.sequence)),
    };
  } };

  const issue = await generateIssueContent({
    doubao, date: "2026-09-11", candidates: candidates(10), preferences: {}, existingItems: [],
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(issue.items.map((item) => item.source.url), candidates(10).map((candidate) => candidate.url));
});

test("skips a batch that fails twice and continues generating enough reliable items", async () => {
  const progress = [];
  const doubao = { async chat(request) {
    const body = JSON.parse(request.messages.at(-1).content);
    if (body.untrustedCandidates.some((candidate) => candidate.id === "candidate-1")) {
      throw Object.assign(new Error("slow batch"), { code: "provider_timeout" });
    }
    return {
      items: body.untrustedCandidates.map((candidate) => generated(candidate.id, candidate.sequence)),
    };
  } };

  const issue = await generateIssueContent({
    doubao,
    date: "2026-09-11",
    candidates: candidates(12),
    preferences: {},
    existingItems: [],
    onProgress: (value) => progress.push(value),
  });

  assert.equal(issue.items.length, 10);
  assert.deepEqual(issue.generation, { status: "partial_failures", targetItems: 12, failedBatches: 1 });
  assert.equal(progress.at(-1).failedBatches, 1);
});

test("counts only individually valid items and keeps invalid items out of progress snapshots", async () => {
  const progress = [];
  let firstBatch = true;
  const doubao = { async chat(request) {
    const body = JSON.parse(request.messages.at(-1).content);
    const items = body.untrustedCandidates.map((candidate) => generated(candidate.id, candidate.sequence));
    if (firstBatch) {
      items[0].fact = "";
      firstBatch = false;
    }
    return { items };
  } };

  const issue = await generateIssueContent({
    doubao,
    date: "2026-09-11",
    candidates: candidates(12),
    preferences: {},
    existingItems: [],
    onProgress: (value) => progress.push(value),
  });

  assert.equal(issue.items.length, 11);
  assert.equal(progress.at(-1).completedItems, 11);
  assert.ok(progress.some((entry) => entry.initialIssue?.items.length === 5));
  assert.ok(progress.every((entry) => entry.initialIssue?.items.every((item) => item.fact) ?? true));
});

test("skips a generated item that cites an unknown candidate", async () => {
  const issue = await generateIssueContent({
    doubao: fakeDoubao({ invalidSource: true }), date: "2026-09-11", candidates: candidates(), preferences: {}, existingItems: [],
  });
  assert.equal(issue.items.length, 11);
});

test("does not keep an item when its trusted candidate has no verified publication date", async () => {
  const undated = candidates();
  delete undated[0].publishedDate;
  const issue = await generateIssueContent({ doubao: fakeDoubao(), date: "2026-09-11", candidates: undated, preferences: {}, existingItems: [] });
  assert.equal(issue.items.length, 11);
  assert.ok(issue.items.every((item) => item.source.url !== undated[0].url));
});

test("forces an undated technical candidate into a visibly unverified learning item", async () => {
  const inputCandidates = candidates();
  inputCandidates[0] = {
    ...inputCandidates[0],
    publishedDate: null,
    dateStatus: "unverified",
    contentTypeHint: "learning",
  };
  const issue = await generateIssueContent({
    doubao: fakeDoubao(), date: "2026-09-11", candidates: inputCandidates, preferences: {}, existingItems: [],
  });
  const item = issue.items.find((entry) => entry.source.url === inputCandidates[0].url);
  assert.equal(item.publishedDate, null);
  assert.equal(item.dateStatus, "unverified");
  assert.equal(item.contentType, "learning");
  assert.equal(item.isBackfill, false);
  assert.match(item.uncertainty, /发布日期待核验/);
});

test("retries a failed model batch once", async () => {
  const doubao = fakeDoubao({ failFirst: true });
  const issue = await generateIssueContent({ doubao, date: "2026-09-11", candidates: candidates(10), preferences: {}, existingItems: [] });
  assert.equal(issue.items.length, 10);
  assert.equal(doubao.calls, 6);
});

test("supplement mode keeps existing items and deduplicates their source URLs", async () => {
  const existing = validateGeneratedIssue(await generateIssueContent({
    doubao: fakeDoubao(), date: "2026-09-11", candidates: candidates(10), preferences: {}, existingItems: [],
  })).items.slice(0, 9);
  const additions = candidates(4);
  additions[0].url = existing[0].source.url;
  for (let index = 1; index < additions.length; index += 1) additions[index].url = `https://supplement${index}.example.com/news`;
  const issue = await generateIssueContent({ doubao: fakeDoubao(), date: "2026-09-11", candidates: additions, preferences: {}, existingItems: existing });
  assert.equal(issue.items.filter((item) => item.source.url === existing[0].source.url).length, 1);
  assert.ok(issue.items.length >= 10);
});

test("extracts at most five known low-weight comment signals", async () => {
  const doubao = { async chat() { return { signals: [
    { topic: "数据 × Agent", weight: 1 },
    { topic: "未知", weight: -1 },
    { topic: "金融 × 科技", weight: 0 },
  ] }; } };
  assert.deepEqual(await extractCommentSignals({
    doubao, comment: "数据内容有用，金融太浅", knownTopics: topics,
  }), [{ topic: "数据 × Agent", weight: 1 }]);
  assert.deepEqual(await extractCommentSignals({ doubao, comment: "", knownTopics: topics }), []);
});

test("validation rejects incomplete diversity normally but preserves a marked time-limited issue", () => {
  const base = generated("unused", 0);
  const item = (index, topic) => ({
    ...base,
    id: `2026-09-11-${index}`,
    topics: [topic],
    source: { name: "Official", type: "官方公告", url: `https://example.com/${index}` },
    isBackfill: false,
    score: { ...base.score, total: 78 },
  });
  const issue = { date: "2026-09-11", status: "tracking", generatedAt: "2026-09-11", updatedAt: "2026-09-11T01:00:00.000Z", readingMinutes: 10, summary: ["摘要"], items: Array.from({ length: 9 }, (_, index) => item(index, topics[index % 3])) };
  assert.throws(() => validateGeneratedIssue(issue), (error) => error.code === "insufficient_content");
  issue.items.push(item(9, topics[0]));
  issue.items = issue.items.map((entry, index) => ({ ...entry, topics: [index < 6 ? topics[0] : topics[1]] }));
  assert.throws(() => validateGeneratedIssue(issue), (error) => error.code === "invalid_generated_content");
  issue.generation = { status: "time_limited", targetItems: 20, failedBatches: 1 };
  assert.doesNotThrow(() => validateGeneratedIssue(issue));
});
