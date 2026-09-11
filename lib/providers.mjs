const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 20_000;

export class ProviderError extends Error {
  constructor(provider, status) {
    super(`${provider} request failed${status ? ` (${status})` : ""}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider) {
    super(provider);
    this.name = "ProviderUnavailableError";
  }
}

export function createDoubaoClient({ apiKey, chatModel, embeddingModel, baseUrl = ARK_BASE_URL, fetchImpl = fetch } = {}) {
  requireText(apiKey, "apiKey");
  requireText(chatModel, "chatModel");
  if (embeddingModel !== undefined) requireText(embeddingModel, "embeddingModel");
  requireText(baseUrl, "baseUrl");
  requireFetch(fetchImpl);

  const base = baseUrl.replace(/\/+$/, "");
  const request = (path, body) => postJson({
    fetchImpl,
    url: `${base}${path}`,
    provider: "Doubao",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });

  return {
    embeddingModel,
    async chat({ messages, responseSchema } = {}) {
      if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
      const body = { model: chatModel, messages };
      if (responseSchema !== undefined) {
        body.response_format = { type: "json_schema", json_schema: responseSchema };
      }
      const payload = await request("/chat/completions", body);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw invalidResponse("Doubao");
      try {
        return JSON.parse(content);
      } catch {
        throw invalidResponse("Doubao");
      }
    },

    async embed(texts) {
      if (!embeddingModel) throw new ProviderUnavailableError("Doubao embeddings");
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
        throw new TypeError("texts must be an array of strings");
      }
      const payload = await request("/embeddings", { model: embeddingModel, input: texts });
      if (!Array.isArray(payload?.data) || payload.data.some((item) => !Array.isArray(item?.embedding))) {
        throw invalidResponse("Doubao");
      }
      return payload.data.map((item) => item.embedding);
    },
  };
}

export function createTavilyClient({ apiKey = process.env.TAVILY_API_KEY, fetchImpl = fetch } = {}) {
  requireFetch(fetchImpl);

  return {
    async search(query, { maxResults = 5, startDate, endDate, includeRawContent = false } = {}) {
      if (!apiKey) throw new ProviderUnavailableError("Tavily");
      requireText(query, "query");
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new TypeError("maxResults must be between 1 and 10");
      if (startDate !== undefined) requireText(startDate, "startDate");
      if (endDate !== undefined) requireText(endDate, "endDate");
      if (typeof includeRawContent !== "boolean") throw new TypeError("includeRawContent must be a boolean");
      const body = { query, max_results: maxResults };
      if (startDate) body.start_date = startDate;
      if (endDate) body.end_date = endDate;
      if (includeRawContent) body.include_raw_content = "markdown";
      const payload = await postJson({
        fetchImpl,
        url: TAVILY_SEARCH_URL,
        provider: "Tavily",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      });
      if (!Array.isArray(payload?.results)) throw invalidResponse("Tavily");
      return payload.results.slice(0, maxResults);
    },
  };
}

async function postJson({ fetchImpl, url, provider, headers, body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const failure = new ProviderError(provider);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") failure.code = "provider_timeout";
    throw failure;
  }
  if (!response || typeof response.ok !== "boolean" || typeof response.json !== "function") {
    throw invalidResponse(provider);
  }
  if (!response.ok) throw new ProviderError(provider, response.status);
  try {
    return await response.json();
  } catch (error) {
    const failure = invalidResponse(provider);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") failure.code = "provider_timeout";
    throw failure;
  }
}

function invalidResponse(provider) {
  return new ProviderError(provider);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
}

function requireFetch(value) {
  if (typeof value !== "function") throw new TypeError("fetchImpl must be a function");
}
