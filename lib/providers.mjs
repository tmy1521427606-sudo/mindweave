import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 20_000;
const SOURCE_TIMEOUT_MS = 10_000;
const SOURCE_BODY_LIMIT = 256 * 1024;

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
  const endpointMode = chatModel.startsWith("ep-");
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
      const body = endpointMode
        ? { model: chatModel, messages }
        : { model: chatModel, input: messages, stream: false };
      if (responseSchema !== undefined) endpointMode
        ? body.response_format = { type: "json_schema", json_schema: responseSchema }
        : body.text = { format: { type: "json_schema", ...responseSchema } };
      const payload = await request(endpointMode ? "/chat/completions" : "/responses", body);
      const content = endpointMode ? payload?.choices?.[0]?.message?.content : responsesText(payload);
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

function responsesText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

export function createTavilyClient({ apiKey = process.env.TAVILY_API_KEY, fetchImpl = fetch } = {}) {
  requireFetch(fetchImpl);

  return {
    async search(query, { maxResults = 5, topic = "general", startDate, endDate, includeRawContent = false } = {}) {
      if (!apiKey) throw new ProviderUnavailableError("Tavily");
      requireText(query, "query");
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new TypeError("maxResults must be between 1 and 10");
      if (!["general", "news", "finance"].includes(topic)) throw new TypeError("invalid Tavily topic");
      if (startDate !== undefined) requireText(startDate, "startDate");
      if (endDate !== undefined) requireText(endDate, "endDate");
      if (typeof includeRawContent !== "boolean") throw new TypeError("includeRawContent must be a boolean");
      const body = { query, max_results: maxResults };
      if (topic !== "general") body.topic = topic;
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

export function createSourceDateResolver({ fetchImpl = fetch, lookup = dnsLookup } = {}) {
  requireFetch(fetchImpl);
  if (typeof lookup !== "function") throw new TypeError("lookup must be a function");

  return async (value) => {
    let url = publicHttpsUrl(value);
    if (!url) return null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!await hasOnlyPublicAddresses(url.hostname, lookup)) return null;
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "text/html,application/xhtml+xml", Range: `bytes=0-${SOURCE_BODY_LIMIT - 1}` },
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
        });
      } catch {
        return null;
      }
      if ([301, 302, 303, 307, 308].includes(response?.status)) {
        const location = response.headers?.get?.("location");
        let redirected;
        try { redirected = location ? new URL(location, url).toString() : null; }
        catch { return null; }
        url = publicHttpsUrl(redirected);
        if (!url) return null;
        continue;
      }
      if (!response?.ok) return null;
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
      const html = await limitedText(response, SOURCE_BODY_LIMIT);
      return html ? extractPublishedDate(html) : null;
    }
    return null;
  };
}

function extractPublishedDate(html) {
  const jsonLd = html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const time = html.match(/<(?:time|relative-time)\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1];
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)]
      .map((match) => [match[1].toLowerCase(), match[2]]));
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    return ["article:published_time", "datepublished", "date", "pubdate"].includes(key)
      ? attributes.content
      : null;
  }).find(Boolean);
  return normalizeDate(jsonLd ?? meta ?? time);
}

async function limitedText(response, limit) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return text.length <= limit ? text : text.slice(0, limit);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function publicHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

async function hasOnlyPublicAddresses(hostname, lookup) {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return !privateAddress(literal);
  let addresses;
  try { addresses = await lookup(literal, { all: true, verbatim: true }); }
  catch { return false; }
  return Array.isArray(addresses) && addresses.length > 0
    && addresses.every((entry) => typeof entry?.address === "string" && !privateAddress(entry.address));
}

function privateAddress(address) {
  const value = address.toLowerCase();
  if (value.includes(":")) {
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("::ffff:") && privateAddress(value.slice(7));
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168))
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51 && parts[2] === 100))
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const date = value.trim().slice(0, 10);
  try { return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date ? date : null; }
  catch { return null; }
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
