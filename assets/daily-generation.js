import { apiJson } from "./shared.js";

export const DAILY_TOPICS = Object.freeze([
  "电商 × Agent", "数据 × Agent", "金融 × 科技", "Agent 开发与大模型", "模型发布与对比",
  "知识图谱 × Agent", "本体论", "Wiki × 知识库", "Multi-Agent × 工作流",
]);

const STAGES = Object.freeze({
  preparing: ["正在准备偏好", 1], searching: ["正在联网搜索", 2], filtering: ["正在去重筛选", 3],
  verifying: ["正在核验来源", 4], generating: ["正在生成解读", 5], saving: ["正在保存日报", 6],
  completed: ["日报生成完成", 6], failed: ["日报生成失败", 0],
});

export function generationStage(stage) {
  return STAGES[stage] ?? ["正在处理", 0];
}

export function generationCounts(job) {
  const base = `候选 ${job.candidates ?? 0} · 已完成 ${job.completedItems ?? 0} · 搜索 ${job.searchCalls ?? 0} 次 · 模型 ${job.modelCalls ?? 0} 次`;
  const discarded = job.discarded ?? {};
  const values = [discarded.missingDate, discarded.outsideWindow, discarded.duplicate, discarded.invalid].map((value) => value ?? 0);
  return values.some((value) => value > 0)
    ? `${base} · 淘汰：缺日期 ${values[0]}、超范围 ${values[1]}、重复 ${values[2]}、其他 ${values[3]}`
    : base;
}

export function generationPayload({ mode, date, focusMore, focusLess, temporaryFocus, yesterdayComment }) {
  return { mode, date, focusMore: [...new Set(focusMore)], focusLess: [...new Set(focusLess)], temporaryFocus: temporaryFocus.trim(), yesterdayComment: yesterdayComment.trim() };
}

export function generationTargetLabel(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `将生成 ${year}年${month}月${day}日日报`;
}

export function versionFileForEntry(issueRef, version) {
  if (!issueRef || !Number.isInteger(version) || version < 1) return issueRef?.file ?? null;
  return issueRef.versions?.find((entry) => entry.version === version)?.file ?? issueRef.file;
}

export async function initializeDailyGeneration({
  request = apiJson,
  today = shanghaiDate(),
  onCompleted = ({ date, version }) => { location.assign(`index.html?date=${encodeURIComponent(date)}&version=${version}`); },
} = {}) {
  const form = document.getElementById("generation-form");
  if (!form) return;
  const elements = Object.fromEntries([
    "generation-more-topics", "generation-less-topics", "generation-temporary-focus", "generation-yesterday-comment",
    "generation-focus-count", "generation-comment-count", "generation-submit", "generation-supplement", "generation-status",
    "generation-progress", "generation-progress-bar", "generation-stage", "generation-counts",
    "generation-version-controls", "generation-version",
    "generation-target-date",
  ].map((id) => [id, document.getElementById(id)]));

  elements["generation-target-date"].textContent = generationTargetLabel(today);

  renderTopicChoices(elements["generation-more-topics"], "daily-more");
  renderTopicChoices(elements["generation-less-topics"], "daily-less");
  bindMutualExclusion(form);
  bindCounter(elements["generation-temporary-focus"], elements["generation-focus-count"], 300);
  bindCounter(elements["generation-yesterday-comment"], elements["generation-comment-count"], 1000);

  let versions = { date: today, currentVersion: null, versions: [] };
  try {
    const [health, loadedVersions] = await Promise.all([
      request("/api/health"),
      request(`/api/issues/${encodeURIComponent(today)}/versions`).catch(() => versions),
    ]);
    versions = loadedVersions;
    renderVersions(elements, versions, today, onCompleted);
    const configured = Boolean(health.dailyGenerationConfigured);
    elements["generation-submit"].disabled = !configured;
    elements["generation-supplement"].disabled = !configured;
    elements["generation-status"].textContent = configured
      ? "已就绪。可以不选任何内容，直接生成。"
      : "日报生成尚未配置：请先设置豆包模型、ARK_API_KEY 和 TAVILY_API_KEY。现有日报仍可正常阅读。";
  } catch {
    elements["generation-submit"].disabled = true;
    elements["generation-supplement"].disabled = true;
    elements["generation-status"].textContent = "无法读取生成配置，现有日报仍可正常阅读。";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements["generation-submit"].disabled) return;
    const mode = event.submitter?.value === "supplement" ? "supplement" : "full";
    if (versions.versions.length && !confirm(mode === "supplement"
      ? "补充生成会再次调用搜索和模型，是否继续？"
      : "重新生成会创建新版本并再次产生 API 费用，是否继续？")) return;
    setFormDisabled(form, true);
    elements["generation-progress"].hidden = false;
    try {
      const body = generationPayload({
        mode, date: today, focusMore: checked(form, "daily-more"), focusLess: checked(form, "daily-less"),
        temporaryFocus: elements["generation-temporary-focus"].value,
        yesterdayComment: elements["generation-yesterday-comment"].value,
      });
      const { jobId } = await request("/api/daily-generations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      await pollJob(jobId);
    } catch (error) {
      elements["generation-status"].textContent = error.message || "日报生成失败，请稍后重试。";
      setFormDisabled(form, false);
    }
  });

  async function pollJob(jobId) {
    while (true) {
      const job = await request(`/api/daily-generations/${encodeURIComponent(jobId)}`);
      const [label, progress] = generationStage(job.stage);
      elements["generation-progress-bar"].value = progress;
      elements["generation-stage"].textContent = label;
      elements["generation-counts"].textContent = generationCounts(job);
      elements["generation-status"].textContent = job.stage === "failed"
        ? job.error?.message ?? "日报生成失败，请稍后重试。"
        : `${label}，已用时 ${formatElapsed(job.elapsedMs)}。`;
      if (job.stage === "completed") { onCompleted({ date: job.date, version: job.result.version }); return; }
      if (job.stage === "failed") { setFormDisabled(form, false); return; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function renderTopicChoices(container, name) {
  container.replaceChildren(...DAILY_TOPICS.map((topic) => {
    const label = document.createElement("label");
    label.className = "generation-topic";
    const input = document.createElement("input");
    input.type = "checkbox"; input.name = name; input.value = topic;
    label.append(input, document.createTextNode(topic));
    return label;
  }));
}

function bindMutualExclusion(form) {
  form.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox" || !input.checked) return;
    const counterpart = input.name === "daily-more" ? "daily-less" : input.name === "daily-less" ? "daily-more" : null;
    if (!counterpart) return;
    for (const other of form.querySelectorAll(`input[name="${counterpart}"]`)) if (other.value === input.value) other.checked = false;
  });
}

function bindCounter(input, output, limit) {
  const render = () => { output.textContent = `${input.value.length} / ${limit}`; };
  input.addEventListener("input", render);
  render();
}

function renderVersions(elements, versions, today, onCompleted) {
  const hasCurrent = versions.versions.length > 0;
  elements["generation-supplement"].hidden = !hasCurrent;
  elements["generation-submit"].textContent = hasCurrent ? "重新生成完整版本" : "生成今日日报";
  elements["generation-version-controls"].hidden = versions.versions.length < 2;
  elements["generation-version"].replaceChildren(...versions.versions.map((entry) => {
    const option = document.createElement("option");
    option.value = String(entry.version ?? "");
    option.textContent = entry.version ? `第 ${entry.version} 版${entry.current ? " · 当前" : ""}` : "旧版";
    option.selected = Boolean(entry.current);
    return option;
  }));
  elements["generation-version"].addEventListener("change", () => {
    const version = Number(elements["generation-version"].value);
    if (Number.isInteger(version) && version > 0) onCompleted({ date: today, version });
  });
}

function setFormDisabled(form, disabled) { for (const control of form.elements) control.disabled = disabled; }
function checked(form, name) { return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }
function formatElapsed(milliseconds) { const seconds = Math.max(0, Math.round((milliseconds ?? 0) / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function shanghaiDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
