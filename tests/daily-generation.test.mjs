import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeSchema, openDatabase } from "../lib/database.mjs";
import { createDailyGenerationService } from "../lib/daily-generation.mjs";
import { readIssueManifest } from "../lib/issue-versions.mjs";

async function fixture({ searchFailure = false, hardTimeoutMs = 10_000, onFailure, doubaoOverride } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mindweave-generation-"));
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ issues: [] }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let searches = 0;
  let syncCalls = 0;
  const search = async () => {
    searches += 1;
    if (searchFailure) throw new Error("private provider failure");
    return Array.from({ length: 2 }, (_, index) => ({
      title: `Source ${searches}-${index}`,
      url: `https://official${searches}-${index}.example.com/release`,
      content: "A sufficiently detailed official source excerpt for generation.",
      published_date: "2026-09-10",
    }));
  };
  const doubao = doubaoOverride ?? { async chat(request) {
    if (request.responseSchema?.name === "daily_comment_signals") return { signals: [] };
    const body = JSON.parse(request.messages.at(-1).content);
    return { items: body.untrustedCandidates.map((candidate) => ({
      candidateId: candidate.id,
      title: `解读 ${candidate.title}`,
      publishedDate: candidate.publishedDate ?? "2026-09-10",
      contentType: "news",
      region: "全球",
      priority: "关注",
      topics: candidate.topics,
      fact: "候选来源明确记录了这一项近期变化。",
      sourceView: null,
      background: "这是用于解释事件背景的完整文字，帮助读者理解其技术边界、行业位置以及为什么现在值得关注。",
      development: ["此前处于旧状态。", "当前来源记录了新变化。"],
      impact: [{ audience: "行业学习者", text: "应结合真实任务评估影响。" }],
      relevance: "它连接个人关注方向与近期变化。",
      concepts: [{ name: "可核验来源", explanation: "能够回到原始页面检查的资料。" }],
      connections: "可连接电商、数据、金融和 Agent 工程。",
      uncertainty: "尚未进行独立效果复测。",
      action: "打开来源并记录一项可验证结论。",
      oneLineValue: `理解 ${candidate.title} 的实际边界。`,
      score: { interest: 20, impact: 15, source: 20, novelty: 10, crossDomain: 8, actionability: 5 },
    })) };
  } };
  const service = createDailyGenerationService({
    db, dataDir, doubao, search, hardTimeoutMs,
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
    syncIssues: async () => { syncCalls += 1; },
    onFailure,
  });
  return { dataDir, db, service, get syncCalls() { return syncCalls; } };
}

const input = (overrides = {}) => ({
  mode: "full",
  date: "2026-09-11",
  focusMore: [],
  focusLess: [],
  temporaryFocus: "",
  yesterdayComment: "",
  ...overrides,
});

function generatedItem(candidate) {
  return {
    candidateId: candidate.id,
    title: `解读 ${candidate.title}`,
    publishedDate: candidate.publishedDate,
    contentType: "news",
    region: "全球",
    priority: "关注",
    topics: candidate.topics,
    fact: "候选来源明确记录了这一项近期变化。",
    sourceView: null,
    background: "这是用于解释事件背景的完整文字，帮助读者理解其技术边界、行业位置以及为什么现在值得关注。",
    development: ["此前处于旧状态。", "当前来源记录了新变化。"],
    impact: [{ audience: "行业学习者", text: "应结合真实任务评估影响。" }],
    relevance: "它连接个人关注方向与近期变化。",
    concepts: [{ name: "可核验来源", explanation: "能够回到原始页面检查的资料。" }],
    connections: "可连接电商、数据、金融和 Agent 工程。",
    uncertainty: "尚未进行独立效果复测。",
    action: "打开来源并记录一项可验证结论。",
    oneLineValue: `理解 ${candidate.title} 的实际边界。`,
    score: { interest: 20, impact: 15, source: 20, novelty: 10, crossDomain: 8, actionability: 5 },
  };
}

async function terminal(service, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = service.get(jobId);
    if (["completed", "failed"].includes(snapshot?.stage)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not finish");
}

test("publishes and indexes only after every generation stage succeeds", async () => {
  const context = await fixture();
  const { jobId } = context.service.start(input());
  const final = await terminal(context.service, jobId);
  assert.equal(final.stage, "completed");
  assert.equal(final.result.version, 1);
  assert.equal(final.completedItems, 16);
  assert.ok(final.searchCalls >= 6);
  assert.ok(final.modelCalls >= 3);
  assert.deepEqual(final.discarded, { missingDate: 0, outsideWindow: 0, duplicate: 0, invalid: 0 });
  assert.equal(context.syncCalls, 1);
  assert.equal((await readIssueManifest(context.dataDir)).issues[0].date, "2026-09-11");
});

test("publishes a marked issue after one model batch fails twice", async () => {
  const context = await fixture({
    doubaoOverride: { async chat(request) {
      const body = JSON.parse(request.messages.at(-1).content);
      if (body.untrustedCandidates.some((candidate) => candidate.id === "candidate-1")) {
        throw Object.assign(new Error("slow batch"), { code: "provider_timeout" });
      }
      return { items: body.untrustedCandidates.map((candidate) => generatedItem(candidate)) };
    } },
  });

  const final = await terminal(context.service, context.service.start(input()).jobId);
  const manifest = await readIssueManifest(context.dataDir);
  assert.equal(manifest.issues.length, 1);
  const issue = JSON.parse(await readFile(path.join(context.dataDir, manifest.issues[0].file), "utf8"));

  assert.equal(final.stage, "completed");
  assert.equal(final.failedBatches, 1);
  assert.deepEqual({ partial: final.result.partial, reason: final.result.reason, failedBatches: final.result.failedBatches }, {
    partial: true, reason: "partial_failures", failedBatches: 1,
  });
  assert.deepEqual(issue.generation, { status: "partial_failures", targetItems: 16, failedBatches: 1 });
});

test("wires the latest issue date and historical sources into candidate collection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mindweave-catch-up-"));
  const previousFile = "2026-09-07.json";
  const historicalUrl = "https://official.example.com/already-covered";
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ issues: [
    { date: "2026-09-07", file: previousFile, itemCount: 1, status: "final" },
  ] }));
  await writeFile(path.join(dataDir, previousFile), JSON.stringify({
    date: "2026-09-07",
    items: [{ source: { url: `${historicalUrl}?utm_source=old` } }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  const searchCalls = [];
  const modelUrls = [];
  let call = 0;
  const service = createDailyGenerationService({
    db,
    dataDir,
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
    syncIssues: async () => {},
    search: async (_query, options) => {
      call += 1;
      searchCalls.push(options);
      return [
        { title: "Covered", url: historicalUrl, content: "Previously covered source.", published_date: "2026-09-08" },
        { title: `New ${call}-1`, url: `https://new-${call}-1.example.com/release`, content: "New source details.", published_date: "2026-09-08" },
        { title: `New ${call}-2`, url: `https://new-${call}-2.example.com/release`, content: "New source details.", published_date: "2026-09-10" },
      ];
    },
    doubao: { chat: async (request) => {
      const body = JSON.parse(request.messages.at(-1).content);
      for (const candidate of body.untrustedCandidates) modelUrls.push(candidate.url);
      return { items: body.untrustedCandidates.map((candidate) => generatedItem(candidate)) };
    } },
  });

  const final = await terminal(service, service.start(input()).jobId);

  assert.equal(final.stage, "completed");
  assert.ok(searchCalls.every((options) => options.startDate === "2026-09-08" && options.endDate === "2026-09-10"));
  assert.ok(modelUrls.every((url) => url !== historicalUrl));
  assert.ok(final.discarded.duplicate > 0);
});

test("rejects a concurrent job while one is active", async () => {
  const context = await fixture();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const service = createDailyGenerationService({
    db: context.db,
    dataDir: context.dataDir,
    doubao: { chat: async () => ({ items: [] }) },
    search: async () => waiting,
    syncIssues: async () => {},
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
  });
  service.start(input());
  assert.throws(() => service.start(input()), (error) => error.code === "generation_in_progress");
  release([]);
});

test("maps provider failure safely and never publishes a partial issue", async () => {
  const context = await fixture({ searchFailure: true });
  const { jobId } = context.service.start(input());
  const final = await terminal(context.service, jobId);
  assert.equal(final.stage, "failed");
  assert.equal(final.error.code, "insufficient_content");
  assert.equal(JSON.stringify(final).includes("private provider failure"), false);
  assert.deepEqual((await readIssueManifest(context.dataDir)).issues, []);
  assert.equal(context.syncCalls, 0);
});

test("reports sanitized failure diagnostics without exposing provider messages", async () => {
  const failures = [];
  const context = await fixture({ onFailure: async (record) => failures.push(record) });
  const providerError = Object.assign(new Error("secret-key and private response body"), {
    name: "ProviderError",
    code: "invalid_json",
    status: 400,
  });
  let searchCall = 0;
  const service = createDailyGenerationService({
    db: context.db,
    dataDir: context.dataDir,
    search: async () => {
      searchCall += 1;
      return Array.from({ length: 2 }, (_, index) => ({
        title: `Source ${index}`,
        url: `https://diagnostic-${searchCall}-${index}.example.com/release`,
        content: "Public source context.",
        published_date: "2026-09-10",
      }));
    },
    doubao: { chat: async () => { throw providerError; } },
    syncIssues: async () => {},
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
    onFailure: async (record) => failures.push(record),
  });

  const final = await terminal(service, service.start(input()).jobId);

  assert.equal(final.stage, "failed");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].error, { name: "DailyContentError", code: "model_failed", status: null });
  assert.deepEqual(failures[0].cause, { name: "ProviderError", code: "invalid_json", status: 400 });
  assert.equal(failures[0].stage, "generating");
  assert.equal(failures[0].modelCalls, 16);
  assert.equal(JSON.stringify(failures[0]).includes("secret-key"), false);
});

test("restores the previous manifest when database synchronization fails", async () => {
  const context = await fixture();
  let searchCall = 0;
  const service = createDailyGenerationService({
    db: context.db,
    dataDir: context.dataDir,
    doubao: { chat: async (request) => {
      const body = JSON.parse(request.messages.at(-1).content);
      return { items: body.untrustedCandidates.map((candidate) => generatedItem(candidate)) };
    } },
    search: async () => {
      searchCall += 1;
      return Array.from({ length: 2 }, (_, index) => ({
        title: `Source ${index}`,
        url: `https://sync-failure-${searchCall}-${index}.example.com/release`,
        content: "A sufficiently detailed official source excerpt for generation.",
        published_date: "2026-09-10",
      }));
    },
    syncIssues: async () => { throw new Error("database unavailable"); },
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
  });
  const { jobId } = service.start(input());
  const final = await terminal(service, jobId);
  assert.equal(final.stage, "failed");
  assert.equal(final.error.code, "save_failed");
  assert.deepEqual((await readIssueManifest(context.dataDir)).issues, []);
  assert.equal((await readdir(context.dataDir)).some((file) => /-v\d+\.json$/.test(file)), false);
});

test("hard timeout fails the job without publishing later", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mindweave-timeout-"));
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ issues: [] }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  const service = createDailyGenerationService({
    db, dataDir,
    doubao: { chat: async () => ({ items: [] }) },
    search: async () => new Promise(() => {}),
    syncIssues: async () => assert.fail("must not sync"),
    hardTimeoutMs: 10,
  });
  const { jobId } = service.start(input());
  const final = await terminal(service, jobId);
  assert.equal(final.error.code, "generation_timeout");
  assert.deepEqual((await readIssueManifest(dataDir)).issues, []);
});

test("hard timeout publishes at least ten completed items instead of discarding them", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mindweave-partial-timeout-"));
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ issues: [] }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let searchCall = 0;
  let modelCall = 0;
  const service = createDailyGenerationService({
    db, dataDir,
    search: async () => {
      searchCall += 1;
      return Array.from({ length: 2 }, (_, index) => ({
        title: `Source ${searchCall}-${index}`,
        url: `https://partial-${searchCall}-${index}.example.com/release`,
        content: "A sufficiently detailed official source excerpt for generation.",
        published_date: "2026-09-10",
      }));
    },
    doubao: { chat: async (request) => {
      modelCall += 1;
      if (modelCall > 5) return new Promise(() => {});
      const body = JSON.parse(request.messages.at(-1).content);
      return { items: body.untrustedCandidates.map((candidate) => generatedItem(candidate)) };
    } },
    syncIssues: async () => {},
    clock: () => new Date("2026-09-11T01:00:00.000Z"),
    hardTimeoutMs: 200,
  });

  const final = await terminal(service, service.start(input()).jobId);
  const manifest = await readIssueManifest(dataDir);
  assert.equal(manifest.issues.length, 1);
  const issue = JSON.parse(await readFile(path.join(dataDir, manifest.issues[0].file), "utf8"));

  assert.equal(final.stage, "completed");
  assert.equal(final.result.partial, true);
  assert.equal(final.result.reason, "generation_timeout");
  assert.equal(final.completedItems, 10);
  assert.equal(issue.items.length, 10);
  assert.deepEqual(issue.generation, { status: "time_limited", targetItems: 16, failedBatches: 0 });
});

test("full and supplement create immutable successive versions", async () => {
  const context = await fixture();
  const first = context.service.start(input());
  assert.equal((await terminal(context.service, first.jobId)).result.version, 1);
  const second = context.service.start(input({ mode: "supplement" }));
  assert.equal((await terminal(context.service, second.jobId)).result.version, 2);
  const manifest = JSON.parse(await readFile(path.join(context.dataDir, "index.json"), "utf8"));
  assert.equal(manifest.issues[0].versions.length, 2);
});

test("validates start input and returns null for unknown jobs", async () => {
  const { service } = await fixture();
  assert.equal(service.get("missing"), null);
  assert.throws(() => service.start(input({ mode: "replace" })), /mode/);
  assert.throws(() => service.start(input({ focusMore: ["A"], focusLess: ["A"] })), /overlap/);
  assert.throws(() => service.start(input({ yesterdayComment: "x".repeat(1001) })), /yesterdayComment/);
});
