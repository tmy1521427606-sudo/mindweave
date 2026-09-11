import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DailyContentError, extractCommentSignals, generateIssueContent } from "./daily-content.mjs";
import { BASE_DAILY_TOPICS, getDecayedCommentWeights, saveCommentSignals } from "./daily-preferences.mjs";
import { buildSearchPlan, collectCandidates } from "./daily-search.mjs";
import { listIssueVersions, publishIssueVersion, readIssueManifest } from "./issue-versions.mjs";
import { getProfile } from "./personalization.mjs";

const TERMINAL = new Set(["completed", "failed"]);
const MODES = new Set(["full", "supplement"]);

export function createDailyGenerationService({
  db,
  dataDir,
  doubao,
  search,
  clock = () => new Date(),
  syncIssues,
  hardTimeoutMs = 10 * 60 * 1000,
}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  if (typeof dataDir !== "string" || !dataDir) throw new TypeError("dataDir is required");
  if (typeof doubao?.chat !== "function") throw new TypeError("doubao is required");
  if (typeof search !== "function") throw new TypeError("search is required");
  if (typeof clock !== "function" || typeof syncIssues !== "function") throw new TypeError("clock and syncIssues are required");
  if (!Number.isInteger(hardTimeoutMs) || hardTimeoutMs < 1) throw new TypeError("hardTimeoutMs must be positive");

  const jobs = new Map();
  let activeJob = null;

  return {
    start(input) {
      const normalized = validateInput(input);
      if (activeJob && !TERMINAL.has(activeJob.stage)) throw serviceError("generation_in_progress", "已有日报生成任务正在运行");
      const started = currentDate();
      const job = {
        id: randomUUID(),
        stage: "preparing",
        date: normalized.date,
        mode: normalized.mode,
        startedAt: started.toISOString(),
        updatedAt: started.toISOString(),
        candidates: 0,
        completedItems: 0,
        searchCalls: 0,
        modelCalls: 0,
        input: normalized,
        cancelled: false,
      };
      jobs.set(job.id, job);
      activeJob = job;
      queueMicrotask(() => run(job));
      return { jobId: job.id };
    },

    get(jobId) {
      if (typeof jobId !== "string") return null;
      const job = jobs.get(jobId);
      return job ? snapshot(job) : null;
    },

    listVersions(date) {
      return listIssueVersions(dataDir, date);
    },
  };

  async function run(job) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        job.cancelled = true;
        reject(serviceError("generation_timeout", "日报生成超过十分钟"));
      }, hardTimeoutMs);
    });
    try {
      await Promise.race([execute(job), timeout]);
    } catch (error) {
      if (job.stage !== "completed") {
        job.stage = "failed";
        job.updatedAt = currentDate().toISOString();
        job.error = safeError(error, job.stageBeforeFailure);
      }
    } finally {
      clearTimeout(timeoutId);
      delete job.input;
      delete job.cancelled;
    }
  }

  async function execute(job) {
    const profile = getProfile(db);
    const knownTopics = [...new Set([...BASE_DAILY_TOPICS, ...Object.keys(profile.topics ?? {})])];
    const countedDoubao = {
      chat: async (...args) => {
        job.modelCalls += 1;
        touch(job);
        return doubao.chat(...args);
      },
    };

    if (job.input.yesterdayComment) {
      const signals = await extractCommentSignals({ doubao: countedDoubao, comment: job.input.yesterdayComment, knownTopics });
      ensureActive(job);
      saveCommentSignals(db, {
        issueDate: addUtcDays(job.date, -1),
        comment: job.input.yesterdayComment,
        signals,
        createdAt: currentDate().toISOString(),
      });
    }
    const commentWeights = getDecayedCommentWeights(db, { asOf: currentDate().toISOString() });
    const preferences = {
      longTermTopics: profile.topics ?? {},
      explanationDepth: profile.depth ?? 0,
      commentWeights,
      focusMore: job.input.focusMore,
      focusLess: job.input.focusLess,
      temporaryFocus: job.input.temporaryFocus,
    };

    setStage(job, "searching");
    const plan = buildSearchPlan({
      date: job.date,
      focusMore: job.input.focusMore,
      focusLess: job.input.focusLess,
      temporaryFocus: job.input.temporaryFocus,
      profile,
    });
    const candidates = await collectCandidates({
      search,
      plan,
      onProgress: (progress) => {
        job.searchCalls = progress.searchCalls;
        job.candidates = progress.candidates;
        touch(job);
      },
    });
    ensureActive(job);
    setStage(job, "filtering");
    job.candidates = candidates.length;

    let existingItems = [];
    if (job.mode === "supplement") existingItems = await readCurrentItems(dataDir, job.date);
    ensureActive(job);
    setStage(job, "verifying");
    setStage(job, "generating");
    const issue = await generateIssueContent({
      doubao: countedDoubao,
      date: job.date,
      candidates,
      preferences,
      existingItems,
      now: clock,
      onProgress: ({ completedItems }) => {
        job.completedItems = completedItems;
        touch(job);
      },
    });
    ensureActive(job);
    setStage(job, "saving");
    job.stageBeforeFailure = "saving";
    const result = await publishIssueVersion({
      dataDir,
      issue,
      mode: job.mode,
      afterPublish: async () => {
        ensureActive(job);
        await syncIssues();
        ensureActive(job);
      },
    });
    ensureActive(job);
    job.result = result;
    job.completedItems = issue.items.length;
    setStage(job, "completed");
    delete job.stageBeforeFailure;
  }

  function snapshot(job) {
    const value = {
      jobId: job.id,
      stage: job.stage,
      date: job.date,
      mode: job.mode,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      elapsedMs: Math.max(0, currentDate().getTime() - Date.parse(job.startedAt)),
      candidates: job.candidates,
      completedItems: job.completedItems,
      searchCalls: job.searchCalls,
      modelCalls: job.modelCalls,
    };
    if (job.result) value.result = structuredClone(job.result);
    if (job.error) value.error = { ...job.error };
    return value;
  }

  function currentDate() {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("clock must return a valid Date");
    return value;
  }

  function setStage(job, stage) {
    job.stage = stage;
    touch(job);
  }

  function touch(job) {
    job.updatedAt = currentDate().toISOString();
  }
}

async function readCurrentItems(dataDir, date) {
  const manifest = await readIssueManifest(dataDir);
  const entry = manifest.issues.find((issue) => issue.date === date);
  if (!entry) return [];
  const issue = JSON.parse(await readFile(path.join(dataDir, entry.file), "utf8"));
  return Array.isArray(issue.items) ? issue.items : [];
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid generation input");
  if (!MODES.has(input.mode)) throw new TypeError("invalid mode");
  assertDate(input.date);
  for (const key of ["focusMore", "focusLess"]) {
    if (!Array.isArray(input[key]) || input[key].length > 20 || input[key].some((value) => typeof value !== "string" || !value.trim() || value.length > 120)) {
      throw new TypeError(`invalid ${key}`);
    }
  }
  if (input.focusMore.some((topic) => input.focusLess.includes(topic))) throw new TypeError("focus topics overlap");
  if (typeof input.temporaryFocus !== "string" || input.temporaryFocus.length > 300) throw new TypeError("invalid temporaryFocus");
  if (typeof input.yesterdayComment !== "string" || input.yesterdayComment.length > 1000) throw new TypeError("invalid yesterdayComment");
  return {
    mode: input.mode,
    date: input.date,
    focusMore: [...new Set(input.focusMore.map((value) => value.trim()))],
    focusLess: [...new Set(input.focusLess.map((value) => value.trim()))],
    temporaryFocus: input.temporaryFocus.trim(),
    yesterdayComment: input.yesterdayComment.trim(),
  };
}

function safeError(error, stage) {
  if (error?.code === "generation_timeout") return { code: "generation_timeout", message: "生成超时，请稍后重试" };
  if (error instanceof DailyContentError) return { code: error.code, message: error.message };
  if (error?.code === "provider_timeout") return { code: "provider_timeout", message: "外部服务响应超时" };
  if (stage === "saving") return { code: "save_failed", message: "日报保存失败，原版本未改变" };
  return { code: "generation_failed", message: "日报生成失败，请稍后重试" };
}

function ensureActive(job) {
  if (job.cancelled || TERMINAL.has(job.stage)) throw serviceError("generation_timeout", "日报生成已停止");
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("invalid date");
  try {
    if (new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new TypeError("invalid date");
  } catch {
    throw new TypeError("invalid date");
  }
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
