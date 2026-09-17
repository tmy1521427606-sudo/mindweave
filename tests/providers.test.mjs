import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ProviderUnavailableError,
  createDoubaoClient,
  createSourceDateResolver,
  createTavilyClient,
} from "../lib/providers.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Doubao endpoint IDs use Chat Completions and parse cited JSON content", async () => {
  const requests = [];
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "ep-team-chat-model",
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
  assert.equal(JSON.parse(requests[0].options.body).model, "ep-team-chat-model");
});

test("GLM model IDs use Chat Completions with a schema instruction", async () => {
  const requests = [];
  const schema = { name: "brief", strict: false, schema: { type: "object", required: ["items"] } };
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "glm-5-3-flash-260828",
    baseUrl: "https://ark.example.test/api/v3",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] });
    },
  });

  assert.deepEqual(await client.chat({ messages: [{ role: "user", content: "生成日报" }], responseSchema: schema }), { items: [] });
  assert.equal(requests[0].url, "https://ark.example.test/api/v3/chat/completions");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.response_format, undefined);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /只输出 JSON/);
  assert.match(body.messages[0].content, /"required":\["items"\]/);
});

test("Doubao model IDs use Responses API and parse structured output", async () => {
  const requests = [];
  const schema = { name: "brief", strict: true, schema: { type: "object" } };
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "deepseek-v4-flash-260425",
    baseUrl: "https://ark.example.test/api/v3",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: '{"items":[]}' }] }] });
    },
  });

  assert.deepEqual(await client.chat({ messages: [{ role: "user", content: "生成日报" }], responseSchema: schema }), { items: [] });
  assert.equal(requests[0].url, "https://ark.example.test/api/v3/responses");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "deepseek-v4-flash-260425",
    input: [{ role: "user", content: "生成日报" }],
    stream: false,
    text: { format: { type: "json_schema", ...schema } },
  });
});

test("Doubao Responses API accepts top-level output text", async () => {
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "deepseek-v4-flash-260425",
    baseUrl: "https://ark.example.test/api/v3",
    fetchImpl: async () => jsonResponse({ output_text: '{"items":[]}' }),
  });

  assert.deepEqual(await client.chat({ messages: [] }), { items: [] });
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

test("Doubao invalid JSON exposes only a safe diagnostic code", async () => {
  const client = createDoubaoClient({
    apiKey: "ark-secret-key",
    chatModel: "glm-5-3-flash-260828",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "private malformed output" } }] }),
  });

  await assert.rejects(
    () => client.chat({ messages: [] }),
    (error) => error instanceof ProviderError
      && error.code === "invalid_json"
      && error.message.includes("private malformed output") === false,
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

test("source date resolver reads a structured publication date from a public page", async () => {
  const resolver = createSourceDateResolver({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response(`<!doctype html><html><head>
      <script type="application/ld+json">{"datePublished":"2026-09-10T08:30:00+08:00"}</script>
    </head></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });

  assert.equal(await resolver("https://official.example.com/release"), "2026-09-10");
});

test("source date resolver recognizes GitHub-style relative-time metadata", async () => {
  const resolver = createSourceDateResolver({
    lookup: async () => [{ address: "140.82.114.4", family: 4 }],
    fetchImpl: async () => new Response('<relative-time datetime="2026-09-09T15:45:00Z">Sep 9</relative-time>', {
      headers: { "content-type": "text/html" },
    }),
  });
  assert.equal(await resolver("https://github.com/example/project/releases/tag/v1"), "2026-09-09");
});

test("source date resolver refuses private destinations before fetching", async () => {
  let fetched = false;
  const resolver = createSourceDateResolver({
    lookup: async () => [{ address: "192.168.1.20", family: 4 }],
    fetchImpl: async () => { fetched = true; return new Response(""); },
  });

  assert.equal(await resolver("https://internal.example.com/release"), null);
  assert.equal(fetched, false);
});

test("source date resolver safely rejects a malformed redirect", async () => {
  const resolver = createSourceDateResolver({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://[invalid" } }),
  });
  assert.equal(await resolver("https://official.example.com/release"), null);
});

test("provider timeouts retain a sanitized timeout code for API mapping", async () => {
  const client = createDoubaoClient({ apiKey: "fake", chatModel: "fake", embeddingModel: "fake", fetchImpl: async () => {
    throw Object.assign(new Error("secret-token"), { name: "TimeoutError" });
  } });
  await assert.rejects(() => client.chat({ messages: [] }), (error) => error.code === "provider_timeout" && !error.message.includes("secret-token"));
});

test("Doubao chat allows slow generation without extending other provider requests", async () => {
  const timeoutCalls = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeoutCalls.push(milliseconds);
    return originalTimeout(milliseconds);
  };
  try {
    const doubao = createDoubaoClient({
      apiKey: "fake",
      chatModel: "glm-5-3-flash-260828",
      embeddingModel: "fake-embedding",
      fetchImpl: async (url) => url.endsWith("/embeddings")
        ? jsonResponse({ data: [{ embedding: [1] }] })
        : jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] }),
    });
    const tavily = createTavilyClient({
      apiKey: "fake",
      fetchImpl: async () => jsonResponse({ results: [] }),
    });

    await doubao.chat({ messages: [] });
    await doubao.embed(["test"]);
    await tavily.search("test");

    assert.deepEqual(timeoutCalls, [180_000, 20_000, 20_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
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
