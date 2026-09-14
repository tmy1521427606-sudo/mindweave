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
  resolvePublishedDate = async () => null,
  clock = () => new Date(),
  syncIssues,
  onFailure = () => {},
  hardTimeoutMs = 10 * 60 * 1000,
}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  if (typeof dataDir !== "string" || !dataDir) throw new TypeError("dataDir is required");
  if (typeof doubao?.chat !== "function") throw new TypeError("doubao is required");
  if (typeof search !== "function") throw new TypeError("search is required");
  if (typeof resolvePublishedDate !== "function") throw new TypeError("resolvePublishedDate is required");
  if (typeof clock !== "function" || typeof syncIssues !== "function") throw new TypeError("clock and syncIssues are required");
  if (typeof onFailure !== "function") throw new TypeError("onFailure must be a function");
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
        failedBatches: 0,
        searchCalls: 0,
        modelCalls: 0,
        discarded: { missingDate: 0, outsideWindow: 0, duplicate: 0, invalid: 0 },
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
    } catch (caught) {
      let error = caught;
      if (job.initialPublishPromise && !job.initialResult) {
        try { await job.initialPublishPromise; }
        catch (publishError) {
          if (error?.code !== "generation_timeout") error = publishError;
        }
      }
      if (error?.code === "generation_timeout" && job.stage === "generating" && job.partialIssue) {
        try {
          await completeWithPartialIssue(job);
          return;
        } catch (saveError) {
          error = saveError;
          job.stageBeforeFailure = "saving";
        }
      }
      if (job.initialResult) {
        const failedStage = job.stageBeforeFailure ?? job.stage;
        const failedAt = currentDate().toISOString();
        try { onFailure(failureRecord(job, error, failedStage, failedAt)); }
        catch { console.error("[MindWeave] failed to write generation diagnostic"); }
        job.backgroundError = safeError(error, job.stageBeforeFailure);
        job.result = { ...job.initialResult, reason: error?.code === "generation_timeout" ? "generation_timeout" : "background_failed" };
        job.updatedAt = failedAt;
        job.stage = "completed";
        return;
      }
      if (job.stage !== "completed") {
        const failedStage = job.stageBeforeFailure ?? job.stage;
        const failedAt = currentDate().toISOString();
        try { onFailure(failureRecord(job, error, failedStage, failedAt)); }
        catch { console.error("[MindWeave] failed to write generation diagnostic"); }
        job.stage = "failed";
        job.updatedAt = failedAt;
        job.error = safeError(error, job.stageBeforeFailure);
      }
    } finally {
      clearTimeout(timeoutId);
      delete job.input;
      delete job.partialIssue;
      delete job.initialPublishPromise;
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

    const history = await readPreviousIssueContext(dataDir, job.date);

    setStage(job, "searching");
    const plan = buildSearchPlan({
      date: job.date,
      lastIssueDate: history.lastIssueDate,
      focusMore: job.input.focusMore,
      focusLess: job.input.focusLess,
      temporaryFocus: job.input.temporaryFocus,
      profile,
    });
    const candidates = await collectCandidates({
      search,
      plan,
      excludedUrls: history.sourceUrls,
      resolvePublishedDate,
      onProgress: (progress) => {
        job.searchCalls = progress.searchCalls;
        job.candidates = progress.candidates;
        job.discarded = { ...progress.discarded };
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
      minimumItems: 5,
      now: clock,
      onProgress: async ({ completedItems, failedBatches, partialIssue, initialIssue }) => {
        ensureActive(job);
        job.completedItems = completedItems;
        job.failedBatches = failedBatches;
        if (partialIssue) job.partialIssue = partialIssue;
        touch(job);
        if (job.mode === "full" && initialIssue && !job.initialResult) {
          job.initialPublishPromise ??= publishInitialIssue(job, initialIssue);
          await job.initialPublishPromise;
        }
      },
    });
    ensureActive(job);
    if (job.initialPublishPromise) await job.initialPublishPromise;
    if (job.initialResult && issue.items.length <= job.initialPublishedItems) {
      job.result = { ...job.initialResult };
      setStage(job, "completed");
      return;
    }
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
    job.result = issue.generation
      ? { ...result, partial: true, reason: issue.generation.status, failedBatches: issue.generation.failedBatches }
      : result;
    job.completedItems = issue.items.length;
    setStage(job, "completed");
    delete job.stageBeforeFailure;
  }

  async function publishInitialIssue(job, issue) {
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
    job.initialPublishedItems = issue.items.length;
    job.initialResult = { ...result, partial: true, reason: "background_generating" };
    delete job.stageBeforeFailure;
    touch(job);
  }

  async function completeWithPartialIssue(job) {
    const issue = job.partialIssue;
    if (job.initialResult && issue.items.length <= job.initialPublishedItems) {
      job.result = { ...job.initialResult, reason: "generation_timeout" };
      setStage(job, "completed");
      return;
    }
    setStage(job, "saving");
    const result = await publishIssueVersion({
      dataDir,
      issue,
      mode: job.mode,
      afterPublish: syncIssues,
    });
    job.result = { ...result, partial: true, reason: "generation_timeout", failedBatches: issue.generation.failedBatches };
    job.completedItems = issue.items.length;
    job.failedBatches = issue.generation.failedBatches;
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
      failedBatches: job.failedBatches,
      searchCalls: job.searchCalls,
      modelCalls: job.modelCalls,
      discarded: { ...job.discarded },
    };
    if (job.result) value.result = structuredClone(job.result);
    if (job.initialResult) {
      value.initialResult = structuredClone(job.initialResult);
      value.backgroundGenerating = !TERMINAL.has(job.stage);
    }
    if (job.backgroundError) value.backgroundError = { ...job.backgroundError };
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

async function readPreviousIssueContext(dataDir, date) {
  const manifest = await readIssueManifest(dataDir);
  const previous = manifest.issues
    .filter((issue) => issue.date < date)
    .sort((left, right) => right.date.localeCompare(left.date));
  const issues = await Promise.all(previous.map(async (entry) =>
    JSON.parse(await readFile(path.join(dataDir, entry.file), "utf8"))));
  return {
    lastIssueDate: previous[0]?.date ?? null,
    sourceUrls: issues.flatMap((issue) => (Array.isArray(issue.items) ? issue.items : []))
      .map((item) => item?.source?.url)
      .filter((url) => typeof url === "string"),
  };
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

function failureRecord(job, error, stage, timestamp) {
  return {
    timestamp,
    jobId: job.id,
    date: job.date,
    mode: job.mode,
    stage,
    candidates: job.candidates,
    completedItems: job.completedItems,
    failedBatches: job.failedBatches,
    searchCalls: job.searchCalls,
    modelCalls: job.modelCalls,
    discarded: { ...job.discarded },
    error: diagnosticError(error),
    cause: diagnosticError(error?.cause),
  };
}

function diagnosticError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    name: safeDiagnosticText(error.name),
    code: safeDiagnosticText(error.code),
    status: Number.isInteger(error.status) ? error.status : null,
  };
}

function safeDiagnosticText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) || null : null;
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
