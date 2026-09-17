import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiHandler } from "../lib/api.mjs";
import { initializeSchema, openDatabase, syncIssueDirectory } from "../lib/database.mjs";
import { persistKnowledgeBundle } from "../lib/knowledge.mjs";
import { ProviderUnavailableError, createDoubaoClient, createTavilyClient } from "../lib/providers.mjs";
import { createLearningAgent } from "../lib/agent.mjs";

async function createTestServer(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-api-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({
    issues: [{ date: "2026-09-09", file: "2026-09-09.json" }],
  }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{
      id: "a1",
      title: "Agent 商品检索",
      publishedDate: "2026-09-09",
      topics: ["电商 × Agent"],
      source: { name: "官方", type: "公告", url: "https://example.com/a" },
      fact: "商品检索支持新协议",
      concepts: [],
    }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  await syncIssueDirectory(db, dir);
  persistKnowledgeBundle(db, {
    sources: [
      {
        publisher: "OpenAI",
        title: "Agent guide",
        type: "官方文档",
        url: "https://example.com/agent-guide",
        publishedDate: "2026-09-08",
        excerpt: "Agent definitions and tool events.",
      },
      {
        publisher: "Research Lab",
        title: "RAG note",
        type: "论文",
        url: "https://example.com/rag-note",
        publishedDate: "2026-09-07",
        excerpt: "RAG retrieval evidence.",
      },
    ],
    cards: [
      { id: "agent-definition", type: "concept", text: "Agent 是能调用工具的系统。", topics: ["Agent"], sources: ["https://example.com/agent-guide"] },
      { id: "agent-event", type: "event", text: "Agent 工具调用已发布。", topics: ["Agent"], sources: ["https://example.com/agent-guide"] },
      { id: "agent-relation", type: "relation", text: "Agent 与 RAG 可以协作。", topics: ["Agent", "RAG"], sources: ["https://example.com/agent-guide"] },
      { id: "rag-inference", type: "inference", text: "RAG 可能提升 Agent 的检索质量。", topics: ["RAG"], sources: ["https://example.com/rag-note"] },
      ...(options.extraKnowledgeCards ?? []),
    ],
  });
  const setCreatedAt = db.prepare("UPDATE knowledge_cards SET created_at = ? WHERE id = ?");
  setCreatedAt.run("2026-09-07T00:00:00.000Z", "agent-definition");
  setCreatedAt.run("2026-09-08T00:00:00.000Z", "agent-event");
  setCreatedAt.run("2026-09-09T00:00:00.000Z", "agent-relation");
  return createServer(createApiHandler({ db, agent: null, ...options }));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function withServer(options, run) {
  const server = await createTestServer(options);
  try {
    return await run(await listen(server));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("searches the archive and sends non-cacheable JSON", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/search?q=Agent`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(body.results.map((item) => item.id), ["a1"]);
  });
});

test("starts, polls, and lists versions for daily generation", async () => {
  const starts = [];
  const dailyGeneration = {
    start(value) { starts.push(value); return { jobId: "job-1" }; },
    get(jobId) { return jobId === "job-1" ? { jobId, stage: "searching", candidates: 4 } : null; },
  };
  await withServer({
    dailyGeneration,
    issueVersions: async (date) => ({ date, currentVersion: 2, versions: [{ version: 2, current: true }] }),
  }, async (base) => {
    const started = await fetch(`${base}/api/daily-generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "full", date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", yesterdayComment: "" }),
    });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { jobId: "job-1" });
    assert.equal(starts.length, 1);
    assert.equal((await fetch(`${base}/api/daily-generations/job-1`).then((response) => response.json())).stage, "searching");
    assert.equal((await fetch(`${base}/api/issues/2026-09-11/versions`).then((response) => response.json())).currentVersion, 2);
    assert.equal((await fetch(`${base}/api/daily-generations/missing`)).status, 404);
  });
});

test("daily generation API validates requests and maps configuration and concurrency", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/daily-generations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(response.status, 503);
  });
  const dailyGeneration = {
    start() { throw Object.assign(new Error("internal detail"), { code: "generation_in_progress" }); },
    get() { return null; },
  };
  await withServer({ dailyGeneration }, async (base) => {
    const response = await fetch(`${base}/api/daily-generations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "full" }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(JSON.stringify(body).includes("internal detail"), false);
  });
});

test("lists only matching knowledge cards in most-recent-first order", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/knowledge?topic=Agent&status=verified`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.cards.map((card) => card.id), ["agent-relation", "agent-event", "agent-definition"]);
    assert.deepEqual(body.cards[1].topics, ["Agent"]);
    assert.equal(body.cards[0].sources[0].id.length > 0, true);
    const events = await fetch(`${base}/api/knowledge?topic=Agent&type=event&status=verified`)
      .then((result) => result.json());
    assert.deepEqual(events.cards.map((card) => card.id), ["agent-event"]);
  });
});

test("returns a stable topic facet even when current card filters have no matches", async () => {
  await withServer({}, async (base) => {
    const body = await fetch(`${base}/api/knowledge?type=event&status=needs_review`)
      .then((response) => response.json());
    assert.deepEqual(body.cards, []);
    assert.deepEqual(body.topics, ["Agent", "RAG"]);
  });
});

test("projects a decoded Wiki topic into cited definitions, events, and relations", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/wiki/${encodeURIComponent("Agent")}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.topic, "Agent");
    assert.deepEqual(body.verified.definitions.map((card) => card.id), ["agent-definition"]);
    assert.deepEqual(body.verified.events.map((card) => card.id), ["agent-event"]);
    assert.deepEqual(body.verified.relations.map((card) => card.id), ["agent-relation"]);
    assert.equal(body.verified.definitions[0].sources[0].id.length > 0, true);
    assert.equal((await fetch(`${base}/api/wiki/%E0%A4%A`)).status, 400);
  });
});

test("projects every matching Wiki card without the knowledge-list cap", async () => {
  const extraKnowledgeCards = Array.from({ length: 205 }, (_, index) => ({
    id: `wiki-${index}`,
    type: "fact",
    text: `Wiki card ${index}`,
    topics: ["完整 Wiki"],
    sources: ["https://example.com/agent-guide"],
  }));
  await withServer({ extraKnowledgeCards }, async (base) => {
    const facets = await fetch(`${base}/api/knowledge?type=event&status=needs_review`)
      .then((response) => response.json());
    assert.deepEqual(facets.cards, []);
    assert.deepEqual(facets.topics, ["Agent", "RAG", "完整 Wiki"]);
    const body = await fetch(`${base}/api/wiki/${encodeURIComponent("完整 Wiki")}`)
      .then((response) => response.json());
    assert.equal(body.verified.other.length, 205);
  });
});

test("exports recoverable knowledge, signals, and conversations without process secrets", async () => {
  const original = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = "do-not-export-this";
  try {
    await withServer({}, async (base) => {
      const response = await fetch(`${base}/api/knowledge/export`, { method: "POST" });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition"), /^attachment; filename="cognitive-daily-export-\d{4}-\d{2}-\d{2}\.json"$/);
      assert.equal(body.sources.length, 2);
      assert.equal(body.cards.length, 4);
      assert.deepEqual(body.signals, []);
      assert.deepEqual(body.conversations, []);
      assert.equal(JSON.stringify(body).includes("do-not-export-this"), false);
    });
  } finally {
    if (original === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = original;
  }
});

test("exports every recoverable card even when the knowledge list is capped", async () => {
  const extraKnowledgeCards = Array.from({ length: 201 }, (_, index) => ({
    id: `export-${index}`,
    type: "fact",
    text: `Export card ${index}`,
    topics: ["Export"],
    sources: ["https://example.com/agent-guide"],
  }));
  await withServer({ extraKnowledgeCards }, async (base) => {
    const listed = await fetch(`${base}/api/knowledge`).then((response) => response.json());
    assert.equal(listed.cards.length, 200);
    const exported = await fetch(`${base}/api/knowledge/export`, { method: "POST" }).then((response) => response.json());
    assert.equal(exported.cards.length, 205);
  });
});

test("updates and removes a valid interest signal", async () => {
  await withServer({}, async (base) => {
    const enabled = await fetch(`${base}/api/articles/a1/signals/follow`, { method: "PUT" });
    assert.equal(enabled.status, 200);
    const enabledProfile = (await enabled.json()).profile;
    assert.equal(enabledProfile.topics["电商 × Agent"], 3);
    assert.deepEqual(enabledProfile.articleSignals, { a1: ["follow"] });

    const loaded = await fetch(`${base}/api/profile`).then((response) => response.json());
    assert.deepEqual(loaded.profile.articleSignals, { a1: ["follow"] });

    const disabled = await fetch(`${base}/api/articles/a1/signals/follow`, { method: "DELETE" });
    assert.equal(disabled.status, 200);
    assert.deepEqual((await disabled.json()).profile.topics, {});
  });
});

test("persists less-like-this and replaces competing topic-preference signals", async () => {
  await withServer({}, async (base) => {
    const more = await fetch(`${base}/api/articles/a1/signals/moreLikeThis`, { method: "PUT" });
    assert.equal(more.status, 200);
    assert.deepEqual((await more.json()).profile.articleSignals, { a1: ["moreLikeThis"] });

    const less = await fetch(`${base}/api/articles/a1/signals/lessLikeThis`, { method: "PUT" });
    assert.equal(less.status, 200);
    assert.deepEqual((await less.json()).profile.articleSignals, { a1: ["lessLikeThis"] });
    assert.equal((await fetch(`${base}/api/profile`).then((response) => response.json())).profile.topics["电商 × Agent"], -1);

    const cancelledLess = await fetch(`${base}/api/articles/a1/signals/lessLikeThis`, { method: "DELETE" });
    assert.equal(cancelledLess.status, 200);
    assert.deepEqual((await cancelledLess.json()).profile.articleSignals, {});
    assert.deepEqual(
      (await fetch(`${base}/api/profile`).then((response) => response.json())).profile.topics,
      {},
    );

    const uninterested = await fetch(`${base}/api/articles/a1/signals/irrelevant`, { method: "PUT" });
    assert.equal(uninterested.status, 200);
    assert.deepEqual((await uninterested.json()).profile.articleSignals, { a1: ["irrelevant"] });

    const cancelled = await fetch(`${base}/api/articles/a1/signals/irrelevant`, { method: "DELETE" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await cancelled.json()).profile.articleSignals, {});
  });
});

test("rejects malformed API requests without implementation details", async () => {
  await withServer({ maxBodyBytes: 20 }, async (base) => {
    const unknownSignal = await fetch(`${base}/api/articles/a1/signals/not-real`, { method: "PUT" });
    assert.equal(unknownSignal.status, 400);
    assert.equal((await unknownSignal.json()).error.code, "invalid_signal");

    const missingArticle = await fetch(`${base}/api/articles/missing/signals/follow`, { method: "PUT" });
    assert.equal(missingArticle.status, 404);
    assert.equal((await missingArticle.json()).error.code, "article_not_found");

    const wrongContentType = await fetch(`${base}/api/articles/a1/signals/follow`, {
      method: "PUT",
      body: "not-json",
    });
    assert.equal(wrongContentType.status, 415);

    const lookalikeContentType = await fetch(`${base}/api/articles/a1/signals/follow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json-evil" },
      body: "{}",
    });
    assert.equal(lookalikeContentType.status, 415);
    assert.equal((await lookalikeContentType.json()).error.code, "unsupported_media_type");

    const tooLarge = await fetch(`${base}/api/articles/a1/signals/follow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: "this is longer than twenty bytes" }),
    });
    assert.equal(tooLarge.status, 413);

    const unknownRoute = await fetch(`${base}/api/nope`);
    const body = await unknownRoute.json();
    assert.equal(unknownRoute.status, 404);
    assert.equal("stack" in body.error, false);
  });
});

test("health never exposes configured secrets", async () => {
  const original = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = "secret-test-key";
  try {
    await withServer({}, async (base) => {
      const body = JSON.stringify(await fetch(`${base}/api/health`).then((response) => response.json()));
      assert.equal(body.includes("secret-test-key"), false);
      assert.equal(JSON.parse(body).database, "ready");
    });
  } finally {
    if (original === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = original;
  }
});

test("chat validates input, delegates once and returns the answer", async () => {
  let calls = 0;
  await withServer({ agent: { async answer(input) {
    calls += 1;
    assert.equal(input.question, "Agent 是什么");
    return { conversationId: "c1", mode: "local", answerSections: [], sources: [], savedCards: [], remainingUncertainty: [] };
  } } }, async (base) => {
    for (const body of [{ question: " " }, { question: "a".repeat(4001) }, null, [], { question: 2 }]) {
      const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error.requestId);
    }
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Agent 是什么" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).conversationId, "c1");
    assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/api/chat`)).status, 405);
  });
});

test("chat maps configuration, timeout and unexpected failures without leaking details", async () => {
  for (const [agent, expected] of [
    [null, 503],
    [{ answer() { throw new ProviderUnavailableError("Doubao"); } }, 503],
    [{ answer() { throw Object.assign(new Error("secret-token"), { name: "TimeoutError" }); } }, 504],
    [{ answer() { throw new Error("secret-token"); } }, 500],
  ]) {
    await withServer({ agent }, async (base) => {
      const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Agent" }) });
      const body = await response.json();
      assert.equal(response.status, expected);
      assert.ok(body.error.requestId);
      assert.equal(JSON.stringify(body).includes("secret-token"), false);
    });
  }
});

for (const provider of ["Doubao", "Tavily"]) {
  for (const name of ["AbortError", "TimeoutError"]) {
    test(`chat maps ${provider} body ${name} through the real Agent to HTTP 504`, async (t) => {
      const db = openDatabase(":memory:");
      initializeSchema(db);
      t.after(() => db.close());
      const fetchImpl = async () => ({ ok: true, status: 200, async json() {
        throw Object.assign(new Error("secret-body-token"), { name });
      } });
      const doubao = provider === "Doubao"
        ? createDoubaoClient({ apiKey: "fake", chatModel: "fake", fetchImpl })
        : { chat() { assert.fail("search timeout must stop before model invocation"); } };
      const webSearch = provider === "Tavily"
        ? createTavilyClient({ apiKey: "fake", fetchImpl })
        : { search: async () => [{ url: "https://example.test/new", content: "模型发布" }] };
      await withServer({ db, agent: createLearningAgent({ db, doubao, webSearch }) }, async (base) => {
        const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "今天有什么新模型" }) });
        const body = await response.json();
        assert.equal(response.status, 504);
        assert.equal(body.error.code, "provider_timeout");
        assert.ok(body.error.requestId);
        assert.equal(JSON.stringify(body).includes("secret-body-token"), false);
        assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_cards").get().n, 0);
      });
    });
  }
}

test("chat accepts a boolean explicit verification flag and rejects ambiguous flag values", async () => {
  const inputs = [];
  await withServer({ agent: { async answer(input) { inputs.push(input); return { answerSections: [] }; } } }, async (base) => {
    const send = (verifyWeb) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "核验", verifyWeb }) });
    assert.equal((await send(true)).status, 200);
    assert.equal(inputs[0].verifyWeb, true);
    assert.equal((await send(false)).status, 200);
    assert.equal(inputs[1].verifyWeb, false);
    for (const value of ["true", 1, {}, null]) assert.equal((await send(value)).status, 400);
    assert.equal(inputs.length, 2);
  });
});

test("knowledge creation-date filter combines with topic/type/status and rejects impossible dates", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/knowledge?date=2026-09-08&topic=Agent&status=verified`);
    assert.deepEqual((await response.json()).cards.map((card) => card.id), ["agent-event"]);
    assert.equal((await fetch(`${base}/api/knowledge?date=2026-02-30`)).status, 400);
    assert.equal((await fetch(`${base}/api/knowledge?date=not-a-date`)).status, 400);
    assert.deepEqual((await fetch(`${base}/api/knowledge?date=2026-09-08&type=fact`).then((r) => r.json())).cards, []);
  });
});

test("topic controls lower once, reset, and stop following through SQLite without altering another topic", async () => {
  await withServer({}, async (base) => {
    const topic = encodeURIComponent("电商 × Agent");
    const signal = (name) => fetch(`${base}/api/articles/a1/signals/${name}`, { method: "PUT" });
    const action = (name, value = topic) => fetch(`${base}/api/profile/topics/${value}/${name}`, { method: "POST" });
    await signal("follow");
    await signal("known");
    const lower = await action("lower");
    assert.equal(lower.status, 200);
    const lowered = (await lower.json()).profile;
    assert.equal(lowered.topics["电商 × Agent"], 2);
    assert.deepEqual(lowered.articleSignals.a1.sort(), ["follow", "known"]);
    assert.equal((await action("lower").then((r) => r.json())).profile.topics["电商 × Agent"], 2);
    const stopped = (await action("unfollow").then((r) => r.json())).profile;
    assert.equal(stopped.topics["电商 × Agent"], -1);
    assert.deepEqual(stopped.articleSignals.a1, ["known"]);
    const reset = (await action("reset").then((r) => r.json())).profile;
    assert.equal(reset.topics["电商 × Agent"] ?? 0, 0);
    assert.deepEqual(reset.articleSignals, {});
    assert.equal((await action("delete-everything")).status, 400);
    assert.equal((await action("lower", encodeURIComponent("不存在的主题"))).status, 404);
    assert.equal((await action("lower", encodeURIComponent("\u0000"))).status, 400);
    assert.equal((await fetch(`${base}/api/profile/topics/${topic}/lower`)).status, 405);
  });
});

test("topic reset and unfollow preserve the other topic of a multi-topic article", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  db.exec(`INSERT INTO issues VALUES ('2026-09-09', 'fixture.json', '{}');
    INSERT INTO articles (id, issue_date, title, payload_json, fingerprint, fts_title, fts_body) VALUES ('multi', '2026-09-09', 'Multi', '{"topics":["A","B"]}', 'multi', 'Multi', '');
    INSERT INTO article_topics VALUES ('multi', 'A'), ('multi', 'B');
    INSERT INTO interest_signals VALUES ('multi', 'A', 'follow', '2026-09-09'), ('multi', 'B', 'follow', '2026-09-09'), ('multi', 'A', 'known', '2026-09-09'), ('multi', 'B', 'known', '2026-09-09');`);
  await withServer({ db }, async (base) => {
    const act = (action) => fetch(`${base}/api/profile/topics/A/${action}`, { method: "POST" }).then((r) => r.json());
    const lower = await act("lower");
    assert.deepEqual(lower.profile?.topics, { A: 2, B: 3 });
    assert.deepEqual((await act("unfollow")).profile.topics, { A: -1, B: 3 });
    const reset = (await act("reset")).profile;
    assert.deepEqual(reset.topics, { B: 3 });
    assert.deepEqual(reset.articleSignals.multi.sort(), ["follow", "known"]);
    assert.equal(reset.depth, 1);
  });
});

test("export closes card relations, source-version links, and explicit/article topic provenance for recovery", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  db.exec(`INSERT INTO issues VALUES ('2026-09-09', 'fixture.json', '{}');
    INSERT INTO articles (id, issue_date, title, source_url, payload_json, fingerprint, fts_title, fts_body) VALUES ('origin', '2026-09-09', 'Original article', NULL, '{"privateFullText":"DO_NOT_EXPORT_FULL_ARTICLE"}', 'origin', 'Original article', '');
    INSERT INTO article_topics VALUES ('origin', '派生主题');`);
  const source = { url: "https://example.test/version", title: "价格", type: "官方文档", excerpt: "10" };
  persistKnowledgeBundle(db, { sources: [source], cards: [{ id: "before", type: "fact", text: "旧价格", topics: ["手工主题"], topicOrigin: "agent", articleIds: ["origin"], sources: [source.url] }] });
  persistKnowledgeBundle(db, { sources: [{ ...source, excerpt: "20", contentFingerprint: "v2" }], cards: [{ id: "after", type: "fact", text: "新价格", topicOrigin: "agent", sources: [source.url] }], relations: [{ fromCardId: "after", toCardId: "before", type: "supersedes" }] });
  db.exec("INSERT INTO embeddings VALUES ('private-vector', 'origin', NULL, 'test-model', '[0.1234,0.5678]', 'private-vector')");
  await withServer({ db }, async (base) => {
    const response = await fetch(`${base}/api/knowledge/export`, { method: "POST" });
    const output = await response.json();
    assert.deepEqual((output.cardRelations ?? []).map(({ fromCardId, toCardId, type }) => ({ fromCardId, toCardId, type })), [{ fromCardId: "after", toCardId: "before", type: "supersedes" }]);
    assert.equal(output.schemaVersion, 2);
    assert.deepEqual(output.topicProvenance.explicit, [{ cardId: "before", topic: "手工主题" }]);
    assert.deepEqual(output.topicProvenance.articles, [{ cardId: "before", articleId: "origin" }]);
    assert.deepEqual(output.topicProvenance.origins, [{ cardId: "after", origin: "agent" }, { cardId: "before", origin: "agent" }]);
    assert.equal(output.articleReferences[0].id, "origin");
    assert.deepEqual(output.articleReferences[0].topics, ["派生主题"]);
    assert.equal(output.cardSourceLinks.length, 2);
    for (const [cardId, excerpt] of [["before", "10"], ["after", "20"]]) {
      const link = output.cardSourceLinks.find((link) => link.cardId === cardId);
      assert.equal(output.sources.find((row) => row.id === link.sourceId).excerpt, excerpt);
    }
    assert.equal(output.sources.find((row) => row.excerpt === "20").contentFingerprint, "v2");
    assert.ok(output.cards.every((card) => card.fingerprint));
    const serialized = JSON.stringify(output);
    assert.doesNotMatch(serialized, /DO_NOT_EXPORT_FULL_ARTICLE|private-vector|vector_json|ARK_API_KEY|TAVILY_API_KEY/);
    assert.equal(output.embeddings, undefined);
  });
});
