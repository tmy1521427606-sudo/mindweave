import test from "node:test";
import assert from "node:assert/strict";
import { mountLearningAgent } from "../assets/agent.js";

class TestElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "";
    this._text = "";
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent).join("")}`;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  append(...children) {
    this._text = "";
    this.children.push(...children);
    for (const child of children) child.parentNode = this;
  }

  replaceChildren(...children) {
    this._text = "";
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class TestDocument {
  constructor() {
    this.activeElement = null;
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new TestElement(this, tagName);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function findButton(root, label) {
  return find(root, (element) => element.tagName === "BUTTON" && element.textContent === label);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("learning agent renders cited local and web answers without treating response text as markup", async (t) => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  const requests = [];
  globalThis.document = document;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({
      conversationId: "conversation-1",
      mode: requests.length === 1 ? "local" : "local+web",
      answerSections: [
        { kind: "fact", text: "<b>事实</b>", citationIds: ["source-1"] },
        { kind: "source_position", text: "来源认为值得关注", citationIds: ["source-1"] },
        { kind: "inference", text: "这是 Agent 推断", citationIds: ["source-1"] },
      ],
      sources: [{ id: "source-1", title: "示例来源", url: "https://example.test/source" }],
      savedCards: [{ id: "card-1", type: "concept", title: "知识卡", content: "保存内容", citationIds: ["source-1"] }],
      remainingUncertainty: [],
    });
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });

  mountLearningAgent({ container: root, articleId: "article-7" });
  const trigger = findButton(root, "问学习 Agent");
  trigger.focus();
  trigger.dispatch("click");
  const textarea = find(root, (element) => element.tagName === "TEXTAREA");
  const send = findButton(root, "发送");
  assert.equal(document.activeElement, textarea);

  textarea.value = "解释这篇文章";
  send.dispatch("click");
  assert.equal(send.disabled, true, "a request should disable a second send");
  await flush();
  assert.deepEqual(requests[0], { question: "解释这篇文章", articleId: "article-7" });
  assert.match(root.textContent, /仅本地/);
  assert.match(root.textContent, /事实/);
  assert.match(root.textContent, /来源观点/);
  assert.match(root.textContent, /Agent 推断/);
  assert.match(root.textContent, /知识卡/);
  assert.equal(find(root, (element) => element.tagName === "B"), null, "untrusted answer text must not create markup");

  textarea.value = "今天的新进展";
  send.dispatch("click");
  await flush();
  assert.deepEqual(requests[1], {
    question: "今天的新进展",
    articleId: "article-7",
    conversationId: "conversation-1",
  });
  assert.match(root.textContent, /本地 \+ 联网/);
  const citation = find(root, (element) => element.tagName === "A" && element.textContent === "示例来源");
  assert.equal(citation.href, "https://example.test/source");
});

test("learning agent restores focus and gives safe actionable provider errors", async (t) => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  let status = 503;
  globalThis.document = document;
  globalThis.fetch = async () => response({ error: { message: "secret diagnostic" } }, status);
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });

  mountLearningAgent({ container: root });
  const trigger = findButton(root, "问学习 Agent");
  trigger.focus();
  trigger.dispatch("click");
  const textarea = find(root, (element) => element.tagName === "TEXTAREA");
  textarea.value = "为什么失败";
  findButton(root, "发送").dispatch("click");
  await flush();
  assert.match(root.textContent, /豆包或联网 key 尚未配置/);
  assert.match(root.textContent, /本地搜索和兴趣功能仍可使用/);
  assert.doesNotMatch(root.textContent, /secret diagnostic/);

  status = 504;
  findButton(root, "发送").dispatch("click");
  await flush();
  assert.match(root.textContent, /服务响应超时，请重试/);
  assert.ok(findButton(root, "重试"));

  findButton(root, "关闭").dispatch("click");
  assert.equal(document.activeElement, trigger);
});

test("learning agent returns tab focus to its drawer when an outside control receives focus", () => {
  const previousDocument = globalThis.document;
  const document = new TestDocument();
  const root = document.createElement("div");
  globalThis.document = document;
  try {
    mountLearningAgent({ container: root });
    const trigger = findButton(root, "问学习 Agent");
    trigger.dispatch("click");
    const textarea = find(root, (element) => element.tagName === "TEXTAREA");
    document.activeElement = trigger;
    document.dispatch("keydown", { key: "Tab" });
    assert.equal(document.activeElement, textarea);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("learning agent keeps pending keyboard focus on an enabled drawer control", () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  globalThis.document = document;
  globalThis.fetch = () => new Promise(() => {});
  try {
    mountLearningAgent({ container: root });
    findButton(root, "问学习 Agent").dispatch("click");
    const textarea = find(root, (element) => element.tagName === "TEXTAREA");
    textarea.value = "等待中的问题";
    findButton(root, "发送").dispatch("click");
    document.activeElement = findButton(root, "问学习 Agent");
    document.dispatch("keydown", { key: "Tab" });
    assert.equal(document.activeElement, findButton(root, "关闭"));
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test("learning agent keeps every dynamic citation in the tab sequence", async (t) => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  globalThis.document = document;
  globalThis.fetch = async () => response({
    conversationId: "conversation-2",
    mode: "local+web",
    answerSections: [
      { kind: "fact", text: "第一条事实", citationIds: ["source-1"] },
      { kind: "source_position", text: "第二条观点", citationIds: ["source-2"] },
    ],
    sources: [
      { id: "source-1", title: "第一来源", url: "https://example.test/one" },
      { id: "source-2", title: "第二来源", url: "https://example.test/two" },
    ],
    savedCards: [],
    remainingUncertainty: [],
  });
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });

  mountLearningAgent({ container: root });
  findButton(root, "问学习 Agent").dispatch("click");
  const textarea = find(root, (element) => element.tagName === "TEXTAREA");
  textarea.value = "给出两个来源";
  findButton(root, "发送").dispatch("click");
  await flush();

  const citations = root.querySelectorAll().filter((element) => element.tagName === "A");
  assert.equal(citations.length, 2);
  citations[0].focus();
  const betweenCitations = document.dispatch("keydown", { key: "Tab" });
  assert.equal(document.activeElement, citations[0]);
  assert.equal(betweenCitations.defaultPrevented, false, "the browser must advance to the next citation");

  citations[1].focus();
  const afterLastCitation = document.dispatch("keydown", { key: "Tab" });
  assert.equal(document.activeElement, citations[1]);
  assert.equal(afterLastCitation.defaultPrevented, false, "the browser must retain the second citation in sequence");

  findButton(root, "发送").focus();
  const afterLastControl = document.dispatch("keydown", { key: "Tab" });
  assert.equal(afterLastControl.defaultPrevented, true);
  assert.equal(document.activeElement, findButton(root, "关闭"));
});

test("learning agent returns focus to the drawer after focusin escapes to the page", () => {
  const previousDocument = globalThis.document;
  const document = new TestDocument();
  const root = document.createElement("div");
  globalThis.document = document;
  try {
    mountLearningAgent({ container: root });
    const trigger = findButton(root, "问学习 Agent");
    trigger.dispatch("click");
    document.activeElement = trigger;
    document.dispatch("focusin", { target: trigger });
    assert.equal(document.activeElement, find(root, (element) => element.tagName === "TEXTAREA"));
  } finally {
    globalThis.document = previousDocument;
  }
});

test("learning agent reopens a pending drawer with an enabled control focused", () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  globalThis.document = document;
  globalThis.fetch = () => new Promise(() => {});
  try {
    mountLearningAgent({ container: root });
    const trigger = findButton(root, "问学习 Agent");
    trigger.dispatch("click");
    const textarea = find(root, (element) => element.tagName === "TEXTAREA");
    textarea.value = "还在等待";
    findButton(root, "发送").dispatch("click");
    findButton(root, "关闭").dispatch("click");
    trigger.dispatch("click");
    assert.equal(document.activeElement, findButton(root, "关闭"));
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test("Agent exposes local/web retrieval disclosure and explicit verification reuses the last question", async (t) => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  const requests = [];
  globalThis.document = document;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({ conversationId: "conv", mode: "local+web", answerSections: [], savedCards: [], remainingUncertainty: [],
      sources: [{ id: "local", title: "<img>本地卡片", url: "https://example.test/local" }, { id: "web", title: "联网来源", url: "https://example.test/web" }],
      retrieval: { localSourceIds: ["local"], webSourceIds: ["web"], webRequested: true, webStatus: "completed" },
    });
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  mountLearningAgent({ container: root, articleId: "a1" });
  findButton(root, "问学习 Agent").dispatch("click");
  const textarea = find(root, (element) => element.tagName === "TEXTAREA");
  textarea.value = "解释幂等";
  findButton(root, "发送").dispatch("click");
  await flush();
  const disclosure = find(root, (element) => element.tagName === "DETAILS");
  assert.ok(disclosure, "retrieval basis must be expandable");
  assert.equal(find(disclosure, (element) => element.tagName === "SUMMARY").textContent, "本次检索依据");
  assert.match(disclosure.textContent, /本地资料/);
  assert.match(disclosure.textContent, /联网资料/);
  assert.match(disclosure.textContent, /<img>本地卡片/);
  assert.equal(find(root, (element) => element.tagName === "IMG"), null);
  const verify = findButton(root, "联网核实");
  assert.ok(verify.getAttribute("aria-label"));
  verify.dispatch("click");
  assert.equal(verify.disabled, true);
  await flush();
  assert.deepEqual(requests[1], { question: "解释幂等", articleId: "a1", conversationId: "conv", verifyWeb: true });
});

test("504 retry is visible and resends the original question even after input changes", async (t) => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = new TestDocument();
  const root = document.createElement("div");
  const requests = [];
  globalThis.document = document;
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return response({}, 504); };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  mountLearningAgent({ container: root });
  const input = find(root, (element) => element.tagName === "TEXTAREA");
  input.value = "最初的问题";
  findButton(root, "发送").dispatch("click");
  await flush();
  const retry = findButton(root, "重试");
  assert.equal(retry.hidden, false);
  input.value = "正在编辑的另一问题";
  retry.dispatch("click");
  await flush();
  assert.deepEqual(requests, [{ question: "最初的问题" }, { question: "最初的问题" }]);
});
