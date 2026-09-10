const sectionLabels = {
  fact: "事实",
  source_position: "来源观点",
  inference: "Agent 推断",
};

const modeLabels = {
  local: "仅本地",
  "local+web": "本地 + 联网",
};

function textElement(document, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = typeof text === "string" ? text : "";
  return element;
}

function safeSources(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value
      .filter((source) => source && typeof source.id === "string")
      .map((source) => [source.id, source]),
  );
}

function citationLink(document, source) {
  if (!source || typeof source.url !== "string") return null;
  let url;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const link = document.createElement("a");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = typeof source.title === "string" && source.title.trim()
    ? source.title
    : "查看来源";
  return link;
}

function appendCitations(document, parent, citationIds, sources) {
  const citations = Array.isArray(citationIds)
    ? citationIds.map((id) => citationLink(document, sources.get(id))).filter(Boolean)
    : [];
  if (!citations.length) return;
  const list = document.createElement("ul");
  list.className = "learning-agent-citations";
  for (const citation of citations) {
    const item = document.createElement("li");
    item.append(citation);
    list.append(item);
  }
  parent.append(list);
}

function answerMessage(document, result) {
  const message = document.createElement("section");
  message.className = "learning-agent-answer";
  const mode = textElement(document, "p", "learning-agent-mode", modeLabels[result.mode] ?? "仅本地");
  const sources = safeSources(result.sources);
  message.append(mode);
  const disclosure = document.createElement("details");
  disclosure.className = "learning-agent-retrieval";
  const summary = textElement(document, "summary", "", "本次检索依据");
  disclosure.append(summary);
  for (const [label, ids] of [["本地资料", result.retrieval?.localSourceIds], ["联网资料", result.retrieval?.webSourceIds]]) {
    const group = document.createElement("section");
    group.append(textElement(document, "h3", "learning-agent-section-label", label));
    if (Array.isArray(ids) && ids.length) appendCitations(document, group, ids, sources);
    else group.append(textElement(document, "p", "", "本次未使用"));
    disclosure.append(group);
  }
  if (result.retrieval?.webStatus === "unavailable") disclosure.append(textElement(document, "p", "", "联网核实未完成，搜索未配置或不可用。"));
  message.append(disclosure);

  for (const section of Array.isArray(result.answerSections) ? result.answerSections : []) {
    if (!section || typeof section.text !== "string") continue;
    const item = document.createElement("section");
    item.className = "learning-agent-section";
    item.append(
      textElement(document, "h3", "learning-agent-section-label", sectionLabels[section.kind] ?? "说明"),
      textElement(document, "p", "", section.text),
    );
    appendCitations(document, item, section.citationIds, sources);
    message.append(item);
  }

  const cards = Array.isArray(result.savedCards) ? result.savedCards : [];
  if (cards.length) {
    const saved = document.createElement("section");
    saved.className = "learning-agent-saved-cards";
    saved.append(textElement(document, "h3", "", "已保存的知识卡"));
    for (const card of cards) {
      if (!card || typeof card.title !== "string" || typeof card.content !== "string") continue;
      const item = document.createElement("article");
      item.className = "learning-agent-card";
      item.append(
        textElement(document, "h4", "", card.title),
        textElement(document, "p", "", card.content),
      );
      appendCitations(document, item, card.citationIds, sources);
      saved.append(item);
    }
    message.append(saved);
  }

  const uncertainty = Array.isArray(result.remainingUncertainty)
    ? result.remainingUncertainty.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  if (uncertainty.length) {
    const note = document.createElement("section");
    note.className = "learning-agent-uncertainty";
    note.append(textElement(document, "h3", "", "仍待核验"));
    const list = document.createElement("ul");
    for (const entry of uncertainty) list.append(textElement(document, "li", "", entry));
    note.append(list);
    message.append(note);
  }
  return message;
}

export function mountLearningAgent({ container, articleId } = {}) {
  if (!container || typeof container.append !== "function") {
    throw new TypeError("container is required");
  }
  const document = container.ownerDocument ?? globalThis.document;
  if (!document) throw new TypeError("document is required");

  const trigger = textElement(document, "button", "learning-agent-trigger", "问学习 Agent");
  trigger.type = "button";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "learning-agent-drawer");

  const drawer = document.createElement("aside");
  drawer.id = "learning-agent-drawer";
  drawer.className = "learning-agent-drawer";
  drawer.hidden = true;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", "learning-agent-heading");

  const heading = textElement(document, "h2", "", "学习 Agent");
  heading.id = "learning-agent-heading";
  const close = textElement(document, "button", "text-button learning-agent-close", "关闭");
  close.type = "button";
  close.setAttribute("aria-label", "关闭学习 Agent");
  const header = document.createElement("div");
  header.className = "learning-agent-heading-row";
  header.append(heading, close);

  const messages = document.createElement("div");
  messages.className = "learning-agent-messages";
  messages.setAttribute("aria-live", "polite");

  const form = document.createElement("form");
  form.className = "learning-agent-form";
  const label = textElement(document, "label", "", "向学习 Agent 提问");
  label.htmlFor = "learning-agent-question";
  const textarea = document.createElement("textarea");
  textarea.id = "learning-agent-question";
  textarea.name = "question";
  textarea.rows = 4;
  textarea.maxLength = 4000;
  textarea.required = true;
  const send = textElement(document, "button", "primary-button", "发送");
  send.type = "submit";
  const verify = textElement(document, "button", "quiet-button", "联网核实");
  verify.type = "button";
  verify.setAttribute("aria-label", "联网核实当前问题或上一条问题");
  const retry = textElement(document, "button", "quiet-button", "重试");
  retry.type = "button";
  retry.hidden = true;
  const status = textElement(document, "p", "learning-agent-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  form.append(label, textarea, verify, send, retry, status);
  drawer.append(header, messages, form);
  container.append(trigger, drawer);

  let openedFrom = null;
  let pending = false;
  let conversationId;
  let lastQuestion = "";
  let lastVerifyWeb = false;

  function setPending(value) {
    pending = value;
    send.disabled = value;
    textarea.disabled = value;
    retry.disabled = value;
    verify.disabled = value;
  }

  function focusableControls() {
    return [...drawer.querySelectorAll("a, button, summary, textarea, input, select, [tabindex]")]
      .filter((control) => {
        if (control.disabled || control.getAttribute("tabindex") === "-1") return false;
        for (let ancestor = control; ancestor && ancestor !== drawer; ancestor = ancestor.parentNode) {
          if (ancestor.hidden) return false;
          if (ancestor.tagName === "DETAILS" && !ancestor.open && control !== ancestor.children[0]) return false;
        }
        if (control.tagName === "A") return Boolean(control.href || control.getAttribute("href"));
        return ["BUTTON", "SUMMARY", "TEXTAREA", "INPUT", "SELECT"].includes(control.tagName)
          || control.getAttribute("tabindex") !== null;
      });
  }

  function focusDrawerControl(reverse = false) {
    const controls = focusableControls();
    (reverse ? controls.at(-1) : controls.includes(textarea) ? textarea : controls[0])?.focus();
    return controls;
  }

  function open() {
    openedFrom = document.activeElement;
    drawer.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    focusDrawerControl();
  }

  function closeDrawer() {
    drawer.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    (openedFrom ?? trigger).focus();
  }

  function setError(responseStatus) {
    retry.hidden = responseStatus !== 504;
    if (responseStatus === 503) {
      status.textContent = "豆包或联网 key 尚未配置；本地搜索和兴趣功能仍可使用。";
    } else if (responseStatus === 504) {
      status.textContent = "服务响应超时，请重试。";
    } else {
      status.textContent = "暂时无法获取回答，请稍后再试。";
    }
  }

  async function submit(question, verifyWeb = false) {
    const trimmed = typeof question === "string" ? question.trim() : "";
    if (!trimmed || pending) return;
    lastQuestion = trimmed;
    lastVerifyWeb = verifyWeb;
    retry.hidden = true;
    status.textContent = "正在整理回答…";
    setPending(true);
    try {
      const body = { question: trimmed };
      if (verifyWeb) body.verifyWeb = true;
      if (articleId) body.articleId = articleId;
      if (conversationId) body.conversationId = conversationId;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(response.status);
        return;
      }
      const result = await response.json();
      conversationId = typeof result.conversationId === "string" ? result.conversationId : conversationId;
      messages.append(answerMessage(document, result));
      status.textContent = "回答已生成。";
      textarea.value = "";
    } catch {
      setError(0);
    } finally {
      setPending(false);
    }
  }

  trigger.addEventListener("click", open);
  close.addEventListener("click", closeDrawer);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(textarea.value);
  });
  send.addEventListener("click", (event) => {
    event.preventDefault();
    submit(textarea.value);
  });
  verify.addEventListener("click", () => submit(textarea.value || lastQuestion, true));
  retry.addEventListener("click", () => submit(lastQuestion, lastVerifyWeb));
  document.addEventListener("keydown", (event) => {
    if (drawer.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableControls();
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    if (index === -1) {
      event.preventDefault();
      focusDrawerControl(event.shiftKey);
    } else if (event.shiftKey && index === 0) {
      event.preventDefault();
      controls.at(-1).focus();
    } else if (!event.shiftKey && index === controls.length - 1) {
      event.preventDefault();
      controls[0].focus();
    }
  });
  document.addEventListener("focusin", (event) => {
    if (!drawer.hidden && !drawer.contains(event.target)) focusDrawerControl();
  });
}
