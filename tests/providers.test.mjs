import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ProviderUnavailableError,
  createDoubaoClient,
  createTavilyClient,
} from "../lib/providers.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Doubao sends configured model and parses cited JSON content", async () => {
  const requests = [];
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "team-chat-model",
    embeddingModel: "team-embedding-model",
    baseUrl: "https://ark.example.test/api/v3",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        choices: [{ message: { content: '{"answer":"答案","citations":[{"url":"https://example.test/a"}]}' } }],
      });
    },
  });

  const result = await client.chat({ messages: [{ role: "user", content: "请总结" }] });

  assert.deepEqual(result, { answer: "答案", citations: [{ url: "https://example.test/a" }] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://ark.example.test/api/v3/chat/completions");
  assert.equal(requests[0].options.headers.Authorization, "Bearer ark-secret-key");
  assert.equal(JSON.parse(requests[0].options.body).model, "team-chat-model");
});

test("Doubao uses the configured embedding model", async () => {
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "team-chat-model",
    embeddingModel: "team-embedding-model",
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).model, "team-embedding-model");
      return jsonResponse({ data: [{ embedding: [3, 4] }, { embedding: [0, 5] }] });
    },
  });

  assert.deepEqual(await client.embed(["甲", "乙"]), [[3, 4], [0, 5]]);
});

test("Doubao response errors are sanitized and typed", async () => {
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "team-chat-model",
    embeddingModel: "team-embedding-model",
    fetchImpl: async () => jsonResponse({ error: { message: "bad request ark-secret-key" } }, 401),
  });

  await assert.rejects(
    () => client.chat({ messages: [{ role: "user", content: "测试" }] }),
    (error) => error instanceof ProviderError
      && error.message.includes("ark-secret-key") === false
      && error.status === 401,
  );
});

test("Tavily limits results to five and preserves a Chinese query", async () => {
  const requests = [];
  const client = createTavilyClient({
    apiKey: "tavily-secret-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ results: [{ title: "结果", url: "https://example.test/result", content: "外部文本" }] });
    },
  });

  assert.deepEqual(await client.search("豆包今天发布了什么"), [
    { title: "结果", url: "https://example.test/result", content: "外部文本" },
  ]);
  assert.equal(requests[0].url, "https://api.tavily.com/search");
  assert.equal(JSON.parse(requests[0].options.body).query, "豆包今天发布了什么");
  assert.equal(JSON.parse(requests[0].options.body).max_results, 5);
});

test("Tavily accepts bounded daily-search options", async () => {
  let body;
  const client = createTavilyClient({
    apiKey: "fake",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ results: Array.from({ length: 12 }, (_, index) => ({ title: String(index) })) });
    },
  });
  const results = await client.search("昨日 Agent", {
    maxResults: 10,
    topic: "news",
    startDate: "2026-09-10",
    endDate: "2026-09-10",
    includeRawContent: true,
  });
  assert.equal(results.length, 10);
  assert.deepEqual(body, {
    query: "昨日 Agent",
    max_results: 10,
    topic: "news",
    start_date: "2026-09-10",
    end_date: "2026-09-10",
    include_raw_content: "markdown",
  });
  await assert.rejects(() => client.search("x", { maxResults: 11 }), /maxResults/);
  await assert.rejects(() => client.search("x", { topic: "video" }), /topic/);
});

test("Tavily without an API key is explicitly unavailable before fetch", async () => {
  let called = false;
  const client = createTavilyClient({ fetchImpl: async () => { called = true; } });

  await assert.rejects(() => client.search("需要联网验证"), ProviderUnavailableError);
  assert.equal(called, false);
});

test("provider timeouts retain a sanitized timeout code for API mapping", async () => {
  const client = createDoubaoClient({ apiKey: "fake", chatModel: "fake", embeddingModel: "fake", fetchImpl: async () => {
    throw Object.assign(new Error("secret-token"), { name: "TimeoutError" });
  } });
  await assert.rejects(() => client.chat({ messages: [] }), (error) => error.code === "provider_timeout" && !error.message.includes("secret-token"));
});

for (const provider of ["Doubao", "Tavily"]) {
  for (const name of ["AbortError", "TimeoutError"]) {
    test(`${provider} preserves ${name} from response body reading as provider_timeout`, async () => {
      const fetchImpl = async () => ({ ok: true, status: 200, async json() {
        throw Object.assign(new Error("secret-body-token"), { name });
      } });
      const request = provider === "Doubao"
        ? () => createDoubaoClient({ apiKey: "fake", chatModel: "fake", fetchImpl }).chat({ messages: [] })
        : () => createTavilyClient({ apiKey: "fake", fetchImpl }).search("今天的新模型");
      await assert.rejects(request, (error) => error instanceof ProviderError
        && error.provider === provider && error.code === "provider_timeout"
        && !error.message.includes("secret-body-token"));
    });
  }
}
