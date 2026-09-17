import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredAgent, createConfiguredDailyGeneration } from "../server.mjs";
import { initializeSchema, openDatabase } from "../lib/database.mjs";

test("server leaves chat unavailable without key or chat model", () => {
  for (const env of [{}, { ARK_API_KEY: "fake" }, { DOUBAO_CHAT_MODEL: "fake" }]) {
    assert.equal(createConfiguredAgent({ db: {}, env, fetchImpl() { assert.fail("no external calls"); } }), null);
  }
});

test("server configures chat without embeddings and performs cited fake web requests", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  const calls = [];
  const agent = createConfiguredAgent({ db, env: { ARK_API_KEY: "fake", DOUBAO_CHAT_MODEL: "ep-chat-v1", TAVILY_API_KEY: "fake" }, fetchImpl: async (url, options) => {
    calls.push(url);
    const payload = JSON.parse(options.body);
    if (url.includes("tavily")) return new Response(JSON.stringify({ results: [{ url: "https://example.test/new", content: "模型发布" }] }));
    assert.equal(payload.model, "ep-chat-v1");
    assert.equal(payload.response_format.type, "json_schema");
    const evidence = JSON.parse(payload.messages.at(-1).content).untrustedEvidence;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answerSections: [{ kind: "fact", text: "模型发布", citationIds: [evidence[0].id] }], knowledgeCards: [], remainingUncertainty: [] }) } }] }));
  } });
  const result = await agent.answer({ question: "今天有什么新模型" });
  assert.equal(result.mode, "local+web");
  assert.equal(calls.length, 2);
  assert.equal(result.answerSections[0].citationIds[0], result.sources[0].id);
});

test("missing Tavily configuration yields safe uncertainty with chat still configured", async (t) => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  t.after(() => db.close());
  const agent = createConfiguredAgent({ db, env: { ARK_API_KEY: "fake", DOUBAO_CHAT_MODEL: "fake" }, fetchImpl() { assert.fail("no search key"); } });
  const result = await agent.answer({ question: "今天有什么新模型" });
  assert.equal(result.savedCards.length, 0);
  assert.match(result.remainingUncertainty.join(""), /无法完成/);
});

test("daily generation requires model and search configuration", () => {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  for (const env of [
    {},
    { ARK_API_KEY: "fake", DOUBAO_CHAT_MODEL: "fake" },
    { TAVILY_API_KEY: "fake" },
  ]) {
    assert.equal(createConfiguredDailyGeneration({ db, env, fetchImpl() { assert.fail("no calls"); } }), null);
  }
  const configured = createConfiguredDailyGeneration({
    db,
    env: { ARK_API_KEY: "fake", DOUBAO_CHAT_MODEL: "chat", TAVILY_API_KEY: "search" },
    fetchImpl() { assert.fail("creation makes no calls"); },
    syncIssues: async () => {},
  });
  assert.equal(typeof configured.start, "function");
  assert.equal(typeof configured.get, "function");
});
