import { apiJson } from "./shared.js";

const elements = Object.fromEntries([
  "cards-tab", "wiki-tab", "profile-tab", "cards-panel", "wiki-panel", "profile-panel",
  "knowledge-filters", "knowledge-topic", "knowledge-type", "knowledge-status", "knowledge-status-message",
  "knowledge-card-list", "knowledge-empty", "wiki-form", "wiki-topic", "wiki-status-message", "wiki-content",
  "profile-status-message", "profile-content", "export-knowledge",
].map((id) => [id, document.getElementById(id)]));

const tabNames = ["cards", "wiki", "profile"];
let knownTopics = [];

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function setChildren(parent, children) {
  parent.replaceChildren(...children);
}

function typeLabel(type) {
  return ({ fact: "事实", concept: "概念", event: "事件", comparison: "比较", relation: "关系", inference: "Agent 推断" })[type] ?? "未分类";
}

function statusLabel(status) {
  return ({ verified: "已核验", needs_review: "待核验", rejected: "已拒绝", superseded: "已替代" })[status] ?? "未知状态";
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function citationList(sources) {
  const list = document.createElement("ol");
  list.className = "knowledge-citations";
  for (const source of Array.isArray(sources) ? sources : []) {
    const item = document.createElement("li");
    const label = `${source.publisher || "来源未提供"} · ${source.title || source.id || "资料"}`;
    const href = safeExternalUrl(source.url);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = label;
      item.append(link);
    } else {
      item.textContent = label;
    }
    list.append(item);
  }
  return list;
}

function knowledgeCard(card) {
  const item = document.createElement("li");
  item.className = "knowledge-card";
  const meta = textElement("p", "knowledge-card-meta", `${typeLabel(card.type)} · ${statusLabel(card.status)} · ${card.updatedAt || "时间未提供"}`);
  const claim = textElement("p", "knowledge-card-text", card.text || "卡片内容未提供");
  const topicText = Array.isArray(card.topics) && card.topics.length ? card.topics.join(" · ") : "主题未提供";
  const topics = textElement("p", "knowledge-card-topics", `主题：${topicText}`);
  const citationHeading = textElement("h3", "knowledge-citation-heading", "来源引用");
  item.append(meta, claim, topics, citationHeading, citationList(card.sources));
  return item;
}

function setTopicOptions(select, selected, placeholder) {
  const options = [textElement("option", "", placeholder)];
  options[0].value = "";
  for (const topic of knownTopics) {
    const option = textElement("option", "", topic);
    option.value = topic;
    option.selected = topic === selected;
    options.push(option);
  }
  setChildren(select, options);
}

function updateTopics(topics) {
  knownTopics = [...new Set((Array.isArray(topics) ? topics : []).filter((topic) => typeof topic === "string" && topic))];
  setTopicOptions(elements["knowledge-topic"], elements["knowledge-topic"].value, "全部主题");
  setTopicOptions(elements["wiki-topic"], elements["wiki-topic"].value, "请选择主题");
}

function filterPath() {
  const params = new URLSearchParams();
  for (const input of elements["knowledge-filters"].elements) {
    if (input.name && input.value) params.set(input.name, input.value);
  }
  return `/api/knowledge${params.size ? `?${params}` : ""}`;
}

async function loadCards() {
  elements["knowledge-status-message"].textContent = "正在读取知识卡片…";
  try {
    const body = await apiJson(filterPath());
    const cards = Array.isArray(body.cards) ? body.cards : [];
    updateTopics(body.topics);
    setChildren(elements["knowledge-card-list"], cards.map(knowledgeCard));
    elements["knowledge-empty"].hidden = cards.length > 0;
    elements["knowledge-status-message"].textContent = cards.length ? `已显示 ${cards.length} 张可追溯卡片。` : "没有匹配的知识卡片。";
  } catch (error) {
    setChildren(elements["knowledge-card-list"], []);
    elements["knowledge-empty"].hidden = false;
    elements["knowledge-status-message"].textContent = `知识卡片读取失败：${error.message}`;
  }
}

function wikiSection(title, cards) {
  const section = document.createElement("section");
  section.className = "wiki-section";
  section.append(textElement("h3", "", title));
  if (!cards.length) {
    section.append(textElement("p", "panel-note", "暂无此类内容。"));
  } else {
    const list = document.createElement("ol");
    list.className = "knowledge-card-list";
    setChildren(list, cards.map(knowledgeCard));
    section.append(list);
  }
  return section;
}

function renderWiki(body) {
  const groups = [["已核验", body.verified], ["待核验", body.needs_review]];
  const content = [];
  for (const [label, group] of groups) {
    const section = document.createElement("section");
    section.className = "wiki-status-group";
    section.append(textElement("h2", "", label));
    const definitions = Array.isArray(group?.definitions) ? group.definitions : [];
    const events = Array.isArray(group?.events) ? group.events : [];
    const relations = Array.isArray(group?.relations) ? group.relations : [];
    const represented = new Set([...definitions, ...events, ...relations].map((card) => card.id));
    const other = Array.isArray(group?.other) ? group.other : [];
    section.append(wikiSection("定义", definitions), wikiSection("事件", events), wikiSection("关系", relations));
    if (other.length) section.append(wikiSection("其他可追溯卡片", other.filter((card) => !represented.has(card.id))));
    content.push(section);
  }
  setChildren(elements["wiki-content"], content);
}

async function loadWiki() {
  const topic = elements["wiki-topic"].value;
  if (!topic) return;
  elements["wiki-status-message"].textContent = "正在读取主题 Wiki…";
  try {
    const body = await apiJson(`/api/wiki/${encodeURIComponent(topic)}`);
    renderWiki(body);
    elements["wiki-status-message"].textContent = `正在查看“${body.topic}”的可追溯资料。`;
  } catch (error) {
    setChildren(elements["wiki-content"], []);
    elements["wiki-status-message"].textContent = `主题 Wiki 读取失败：${error.message}`;
  }
}

function profileMetric(label, value) {
  const card = document.createElement("section");
  card.className = "profile-metric";
  card.append(textElement("h3", "", label), textElement("p", "", value));
  return card;
}

function topicPreference(topic, score) {
  const row = profileMetric(topic, `主题分：${score >= 0 ? "+" : ""}${score}`);
  const controls = document.createElement("div");
  controls.className = "interest-buttons";
  for (const [action, label] of [["lower", "降低推荐"], ["reset", "清零"], ["unfollow", "停止跟踪"]]) {
    const button = textElement("button", "quiet-button", label);
    button.type = "button";
    button.dataset.topicAction = action;
    button.setAttribute("aria-label", `${topic}：${label}`);
    button.addEventListener("click", async () => {
      for (const control of controls.children) control.disabled = true;
      try {
        await apiJson(`/api/profile/topics/${encodeURIComponent(topic)}/${action}`, { method: "POST" });
        await loadProfile();
        elements["profile-status-message"].textContent = `“${topic}”已${label}。`;
      } catch {
        elements["profile-status-message"].textContent = "主题设置保存失败，请重试。";
      } finally {
        for (const control of controls.children) control.disabled = false;
      }
    });
    controls.append(button);
  }
  row.append(controls);
  return row;
}

async function loadProfile() {
  elements["profile-status-message"].textContent = "正在读取本地兴趣信号…";
  try {
    const { profile } = await apiJson("/api/profile");
    const topics = Object.entries(profile?.topics ?? {}).sort((left, right) => right[1] - left[1]);
    const topicText = topics.length ? topics.map(([topic, score]) => `${topic}（${score >= 0 ? "+" : ""}${score}）`).join(" · ") : "尚无足够信号";
    const angles = profile?.angles ?? {};
    setChildren(elements["profile-content"], [
      profileMetric("主题偏好", topicText),
      profileMetric("学习深度信号", String(profile?.depth ?? 0)),
      profileMetric("技术 / 商业视角", `${angles.technical ?? 0} / ${angles.business ?? 0}`),
      profileMetric("有效兴趣信号", String(profile?.evidenceCount ?? 0)),
      ...topics.map(([topic, score]) => topicPreference(topic, score)),
    ]);
    elements["profile-status-message"].textContent = "兴趣画像由本地反馈信号汇总，不是事实结论。";
  } catch (error) {
    setChildren(elements["profile-content"], []);
    elements["profile-status-message"].textContent = `兴趣画像读取失败：${error.message}`;
  }
}

function selectTab(name) {
  for (const tabName of tabNames) {
    const selected = tabName === name;
    elements[`${tabName}-tab`].setAttribute("aria-selected", String(selected));
    elements[`${tabName}-tab`].tabIndex = selected ? 0 : -1;
    elements[`${tabName}-panel`].hidden = !selected;
  }
  if (name === "wiki" && elements["wiki-topic"].value) loadWiki();
  if (name === "profile") loadProfile();
}

for (const [index, name] of tabNames.entries()) {
  elements[`${name}-tab`].addEventListener("click", () => selectTab(name));
  elements[`${name}-tab`].addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : tabNames.length - 1)) % tabNames.length;
    elements[`${tabNames[next]}-tab`].focus();
    selectTab(tabNames[next]);
  });
}

elements["knowledge-filters"].addEventListener("submit", (event) => { event.preventDefault(); loadCards(); });
elements["wiki-form"].addEventListener("submit", (event) => { event.preventDefault(); loadWiki(); });
elements["export-knowledge"].addEventListener("click", async () => {
  elements["export-knowledge"].disabled = true;
  try {
    const response = await fetch("/api/knowledge/export", { method: "POST", cache: "no-store" });
    if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "cognitive-daily-export.json";
    link.click();
    URL.revokeObjectURL(link.href);
    elements["knowledge-status-message"].textContent = "本地数据已开始下载。";
  } catch (error) {
    elements["knowledge-status-message"].textContent = error.message;
  } finally {
    elements["export-knowledge"].disabled = false;
  }
});

loadCards();
