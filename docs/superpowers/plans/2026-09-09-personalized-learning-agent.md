# Personalized Learning Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing local cognitive daily into a detailed, searchable and interest-aware reading product with a Doubao-powered local-first learning Agent and a traceable personal knowledge base.

**Architecture:** Keep `data/*.json` as versionable daily archives and incrementally index them into local SQLite. Extend the existing Node server with a small JSON API; the browser never receives API keys. Retrieval combines SQLite FTS with optional embeddings, invokes web search only when evidence is insufficient or freshness is required, and persists sources plus atomic knowledge cards rather than treating model prose as fact.

**Tech Stack:** Node.js 24 (`node:http`, `node:sqlite`, built-in `fetch`), browser ES modules, HTML/CSS, Node test runner, Doubao/Volcengine Ark compatible API, Tavily Search API for the initial web-search adapter.

**Spec:** `docs/superpowers/specs/2026-09-09-personalized-learning-agent-design.md`

## Global Constraints

- Local-only first version: no accounts, cross-device sync, cloud database, payment, streaming response or multi-agent orchestration.
- `data/*.json` remains the recoverable daily archive; SQLite is a derived local index plus the store for feedback, conversations and knowledge cards.
- API keys exist only in process environment variables and must never be returned to the browser or written to logs.
- Model IDs are configured through `DOUBAO_CHAT_MODEL` and `DOUBAO_EMBEDDING_MODEL`; do not hard-code a current marketing model name.
- External pages are untrusted content, never instructions. Only `http` and `https` source URLs may be persisted.
- Do not copy full copyrighted articles; retain metadata, short excerpts and derived knowledge cards.
- Facts, source positions and Agent inferences remain visibly distinct and every factual answer has source citations.
- Existing archive navigation, filters, scoring, feedback and 48-item data validation must continue to pass.
- The current project is not a Git repository. Do not initialize one without user approval; each task therefore ends with a green automated or manual checkpoint instead of a commit.

---

## File Map

**Existing files to modify**

- `detail.html`: detailed story hierarchy, compact secondary material, interest actions and Agent mount point.
- `index.html`: archive-search trigger/dialog, card interest controls and Agent mount point.
- `assets/styles.css`: hierarchy, dialog, interest, Agent and knowledge-view styling.
- `assets/shared.js`: signal constants, personalized scoring and reusable API helpers.
- `assets/index.js`: cross-issue search UI, interest actions and personalized ranking.
- `assets/detail.js`: detailed fields, interest actions and article-scoped Agent context.
- `server.mjs`: compose static serving with `/api/*` routing and initialize the database.
- `tests/app.test.mjs`: preserve and extend frontend/shared behavior tests.
- `tests/validate-data.mjs`: validate detailed fields for newly generated news.
- `start.ps1`: document missing-key behavior while continuing to start offline features.
- `.gitignore`: exclude `var/*.sqlite*` and local `.env` files.

**Files to create**

- `lib/database.mjs`: schema, issue indexing, FTS search, signals, knowledge and conversation persistence.
- `lib/personalization.mjs`: signal validation, topic affinity and personalized ranking.
- `lib/retrieval.mjs`: local evidence merge, cosine scoring and web-fallback decision.
- `lib/providers.mjs`: Doubao chat/embedding client and Tavily search client using injected `fetch`.
- `lib/knowledge.mjs`: source normalization, fingerprints, card validation, deduplication and status rules.
- `lib/agent.mjs`: one-question orchestration from retrieval through cited answer and knowledge persistence.
- `lib/api.mjs`: request parsing, route dispatch, validation and safe JSON responses.
- `assets/agent.js`: reusable drawer UI for chat, citations and newly saved cards.
- `knowledge.html`: local knowledge-card, Wiki and interest-profile page.
- `assets/knowledge.js`: fetch and render knowledge/profile data.
- `tests/database.test.mjs`: SQLite synchronization/search/persistence tests.
- `tests/personalization.test.mjs`: signal and ranking tests.
- `tests/retrieval.test.mjs`: fallback and similarity tests.
- `tests/knowledge.test.mjs`: source/card safety and deduplication tests.
- `tests/providers.test.mjs`: provider request/response contract tests with fake fetch.
- `tests/agent.test.mjs`: local-only, web fallback and citation orchestration tests.
- `tests/api.test.mjs`: HTTP integration tests against a temporary database.

---

### Task 1: Establish the SQLite archive index

**Files:**
- Create: `lib/database.mjs`
- Create: `tests/database.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `openDatabase(filePath: string): DatabaseSync`
- Produces: `initializeSchema(db: DatabaseSync): void`
- Produces: `syncIssueDirectory(db: DatabaseSync, dataDir: string): Promise<{issues: number, articles: number}>`
- Produces: `searchArticles(db: DatabaseSync, query: string, limit?: number): ArticleSearchHit[]`
- Produces: `getArticle(db: DatabaseSync, articleId: string): ArticleRecord | null`

- [ ] **Step 1: Write database synchronization and search tests**

```js
// tests/database.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, initializeSchema, syncIssueDirectory, searchArticles } from "../lib/database.mjs";

test("syncs JSON issues idempotently and searches all dates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognitive-db-"));
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ issues: [{ date: "2026-09-09", file: "2026-09-09.json" }] }));
  await writeFile(path.join(dir, "2026-09-09.json"), JSON.stringify({
    date: "2026-09-09",
    items: [{ id: "a1", title: "Agent 商品检索", publishedDate: "2026-09-09", topics: ["电商 × Agent"], source: { name: "官方", type: "公告", url: "https://example.com/a" }, fact: "商品检索支持新协议", concepts: [{ name: "协议", explanation: "约定" }] }],
  }));
  const db = openDatabase(":memory:");
  initializeSchema(db);
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 1, articles: 1 });
  assert.deepEqual(await syncIssueDirectory(db, dir), { issues: 1, articles: 1 });
  assert.equal(searchArticles(db, "商品", 10)[0].id, "a1");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/database.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/database.mjs`.

- [ ] **Step 3: Implement the schema and idempotent JSON synchronization**

Use `DatabaseSync` from `node:sqlite`. Create `issues`, `articles`, `article_topics`, `sources`, and an external-content FTS5 table `article_fts`. Store the complete article as `payload_json`, and delete/reinsert its FTS row and topics inside one transaction whenever its SHA-256 content fingerprint changes.

```js
// lib/database.mjs — public shape
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return db;
}

export function searchArticles(db, query, limit = 30) {
  const normalized = String(query).trim().replace(/["']/g, " ");
  if (!normalized) return [];
  return db.prepare(`
    SELECT a.id, a.issue_date AS issueDate, a.title, a.published_date AS publishedDate,
           a.source_name AS sourceName, a.payload_json AS payloadJson,
           bm25(article_fts) AS rank
    FROM article_fts JOIN articles a ON a.rowid = article_fts.rowid
    WHERE article_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(normalized.split(/\s+/).map((part) => `"${part}"*`).join(" AND "), limit)
    .map((row) => ({ ...row, item: JSON.parse(row.payloadJson) }));
}
```

- [ ] **Step 4: Run database tests and the existing suite**

Run: `node --test tests/database.test.mjs tests/app.test.mjs && node tests/validate-data.mjs`

Expected: all tests pass and existing data still reports 48 valid items.

- [ ] **Step 5: Ignore runtime state**

Add exactly these entries to `.gitignore`:

```gitignore
var/*.sqlite
var/*.sqlite-shm
var/*.sqlite-wal
.env
```

- [ ] **Step 6: Record the archive-index checkpoint**

Run: `node --test tests/database.test.mjs && node tests/validate-data.mjs`

Expected: both commands pass before starting Task 2.

---

### Task 2: Add signals and transparent personalization

**Files:**
- Create: `lib/personalization.mjs`
- Create: `tests/personalization.test.mjs`
- Modify: `lib/database.mjs`
- Modify: `assets/shared.js`
- Modify: `tests/app.test.mjs`

**Interfaces:**
- Consumes: `getArticle(db, articleId)` from Task 1.
- Produces: `SIGNAL_WEIGHTS`, `assertSignal(signal)`, `scoreSignals(signals)`, `setInterestSignal(db, articleId, signal, enabled, now)`, `getProfile(db)`, `personalizedBoost(item, profile)`.

- [ ] **Step 1: Write signal and profile tests**

```js
// tests/personalization.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { personalizedBoost, scoreSignals } from "../lib/personalization.mjs";

test("follow outweighs bookmark while irrelevant reduces topic affinity", () => {
  const profile = scoreSignals([
    { topic: "Agent 开发", signal: "follow", enabled: true },
    { topic: "Agent 开发", signal: "bookmark", enabled: true },
    { topic: "金融 × 科技", signal: "irrelevant", enabled: true },
  ]);
  assert.equal(profile.topics["Agent 开发"], 4);
  assert.equal(profile.topics["金融 × 科技"], -3);
  assert.ok(personalizedBoost({ topics: ["Agent 开发"] }, profile) > 0);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test tests/personalization.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the fixed signal vocabulary and profile calculation**

```js
export const SIGNAL_WEIGHTS = Object.freeze({
  bookmark: 1,
  follow: 3,
  moreLikeThis: 2,
  needFoundation: 0,
  wantTechnical: 0,
  wantBusiness: 0,
  known: 0,
  irrelevant: -3,
});

export function assertSignal(signal) {
  if (!Object.hasOwn(SIGNAL_WEIGHTS, signal)) throw new TypeError("未知兴趣信号");
  return signal;
}

export function personalizedBoost(item, profile) {
  const raw = (item.topics ?? []).reduce((sum, topic) => sum + (profile.topics?.[topic] ?? 0), 0);
  return Math.max(-10, Math.min(10, raw));
}
```

Add an `interest_signals` table with primary key `(article_id, topic, signal)`. Disabling deletes the active row; enabling upserts `created_at`. `getProfile` returns `{topics, depth, angles, evidenceCount}`.

- [ ] **Step 4: Mirror constants and personalized score behavior in the browser module**

Add `INTEREST_SIGNALS` and `personalizedScore(item, profile)` to `assets/shared.js`. Extend `tests/app.test.mjs` with a browser-safe score test that asserts the returned object exposes separate `editorial`, `personalizedBoost`, and `total` fields.

- [ ] **Step 5: Run all unit tests**

Run: `node --test tests/app.test.mjs tests/database.test.mjs tests/personalization.test.mjs`

Expected: PASS.

- [ ] **Step 6: Record the personalization checkpoint**

Run: `node --test tests/personalization.test.mjs tests/app.test.mjs`

Expected: both test files pass before changing the UI.

---

### Task 3: Rework article hierarchy and enrich current news data

**Files:**
- Modify: `detail.html`
- Modify: `assets/detail.js`
- Modify: `assets/styles.css`
- Modify: `data/2026-09-09.json`
- Modify: `tests/validate-data.mjs`

**Interfaces:**
- Produces optional article fields: `background: string`, `development: string[]`, `impact: {audience: string, text: string}[]`.
- Preserves fallback rendering for historical articles without these fields.

- [ ] **Step 1: Add failing validation for detailed fields on the newest issue**

In `tests/validate-data.mjs`, determine the newest manifest date and require every `contentType: "news"` item in that issue to have a non-empty `background`, at least two `development` entries, and at least one `impact` entry with non-empty `audience` and `text`.

```js
assert.equal(typeof item.background, "string", `${item.id}: background`);
assert.ok(item.background.trim().length >= 40, `${item.id}: background too short`);
assert.ok(Array.isArray(item.development) && item.development.length >= 2, `${item.id}: development`);
assert.ok(Array.isArray(item.impact) && item.impact.every((row) => row.audience && row.text), `${item.id}: impact`);
```

- [ ] **Step 2: Run validation and observe failure**

Run: `node tests/validate-data.mjs`

Expected: FAIL on the first 2026-09-09 news item missing `background`.

- [ ] **Step 3: Enrich each current news item using only its existing cited source**

For each `contentType: "news"` item in `data/2026-09-09.json`, add factual background, a minimum two-step event development, and audience-specific impact. Do not add claims unsupported by the stored source. Learning/backfill cards may omit the new fields.

```json
{
  "background": "该变更发生前的必要上下文，并说明原有行为或限制。",
  "development": ["此前：原有能力或问题。", "现在：本次确认发生的变化。"],
  "impact": [{"audience": "Agent 开发者", "text": "该变化如何影响实现、判断或工作流程。"}]
}
```

- [ ] **Step 4: Implement conditional detail rendering**

Add `#background-section`, `#development-section`, and `#impact-section` after the event fact. Render them only when data exists. Move `connections`, `uncertainty`, and `action` into one `secondary-insights` section with three compact rows after concepts. Keep separate headings inside rows for screen readers.

- [ ] **Step 5: Add focused CSS and verify responsive hierarchy**

Give fact/background/development/impact normal article width and body size. Style `.secondary-insights` as a subdued bordered container, not three same-weight cards. At widths below 720px, keep impact rows one column and preserve tap targets of at least 44px.

- [ ] **Step 6: Run validation and app tests**

Run: `node tests/validate-data.mjs && node --test tests/app.test.mjs`

Expected: PASS with 3 issues and 48 items.

- [ ] **Step 7: Manually inspect one complete and one fallback article**

Run: `powershell -ExecutionPolicy Bypass -File .\start.ps1`

Verify one 2026-09-09 news detail displays all new sections, one older item has no empty new headings, and the compact insights appear after concepts.

- [ ] **Step 8: Record the detail-hierarchy checkpoint**

Capture one desktop and one narrow-width screenshot for visual comparison, then rerun `node tests/validate-data.mjs`.

---

### Task 4: Expose safe local JSON APIs

**Files:**
- Create: `lib/api.mjs`
- Create: `tests/api.test.mjs`
- Modify: `server.mjs`

**Interfaces:**
- Consumes: database and personalization functions from Tasks 1–2.
- Produces: `createApiHandler({db, agent, maxBodyBytes?})` returning an async Node request handler.
- Produces endpoints: `GET /api/health`, `GET /api/search`, `GET /api/profile`, `PUT|DELETE /api/articles/:id/signals/:signal`.

- [ ] **Step 1: Write integration tests with an ephemeral HTTP server**

```js
test("searches the archive and rejects unknown signals", async () => {
  const server = createTestServer();
  const base = await listen(server);
  const search = await fetch(`${base}/api/search?q=Agent`).then((r) => r.json());
  assert.ok(Array.isArray(search.results));
  const response = await fetch(`${base}/api/articles/a1/signals/not-real`, { method: "PUT" });
  assert.equal(response.status, 400);
});

test("health never exposes configured secrets", async () => {
  const body = JSON.stringify(await fetch(`${base}/api/health`).then((r) => r.json()));
  assert.equal(body.includes("secret-test-key"), false);
});
```

- [ ] **Step 2: Verify API tests fail**

Run: `node --test tests/api.test.mjs`

Expected: FAIL because `lib/api.mjs` is missing.

- [ ] **Step 3: Implement route parsing and safe responses**

Limit JSON bodies to 64 KiB, return `{error:{code,message}}`, require `Content-Type: application/json` for write bodies, validate IDs and signal enums, and add `Cache-Control: no-store`. Do not include stack traces in responses.

```js
export function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
```

- [ ] **Step 4: Compose API and static handling in `server.mjs`**

Initialize `var/cognitive-daily.sqlite`, synchronize `data/` before listening, route `/api/` to `createApiHandler`, and preserve all path traversal and CSP tests for static files. Change CSP `connect-src` only if required; same-origin `/api` needs no extra origin.

- [ ] **Step 5: Run server and API suites**

Run: `node --test tests/api.test.mjs tests/app.test.mjs tests/database.test.mjs`

Expected: PASS.

- [ ] **Step 6: Record the API checkpoint**

Run: `node --test tests/api.test.mjs tests/database.test.mjs`

Expected: PASS before connecting browser controls.

---

### Task 5: Add archive search dialog and interest controls

**Files:**
- Modify: `index.html`
- Modify: `detail.html`
- Modify: `assets/index.js`
- Modify: `assets/detail.js`
- Modify: `assets/shared.js`
- Modify: `assets/styles.css`
- Modify: `tests/app.test.mjs`

**Interfaces:**
- Consumes: `/api/search`, `/api/profile`, and signal write endpoints.
- Produces: `apiJson(path, options?)`, `renderArchiveSearchResults(results)`, and consistent `[data-interest-signal]` controls.

- [ ] **Step 1: Test URL construction and safe search result shaping**

Add pure helpers to `assets/shared.js` and tests asserting that a query containing `&` is encoded, empty queries do not request the API, and result snippets are returned as text fields rather than HTML.

```js
assert.equal(archiveSearchPath("RAG & Agent"), "/api/search?q=RAG%20%26%20Agent&scope=all");
assert.equal(archiveSearchPath("   "), null);
```

- [ ] **Step 2: Add accessible dialog markup**

Place a “搜索往期” button beside the current issue search. Add a native `<dialog id="archive-search-dialog">` containing a labelled search input, submit button, close button, result count, status region and result list. Escape closes it and focus returns to the trigger through native dialog behavior.

- [ ] **Step 3: Implement debounced cross-issue search**

Submit immediately on form submit and debounce typing by 250 ms. Abort the previous request through `AbortController`. Each result links to `detail.html?date=<issueDate>&id=<id>` and displays date, title, source, topics and a plain-text snippet.

- [ ] **Step 4: Add interest actions to cards and detail**

Use visible `bookmark`, `follow`, and `moreLikeThis` buttons on cards. Place the remaining signals in an expandable “调整兴趣” group. Reflect `aria-pressed`, optimistically update the UI, roll back on API failure, and show an `aria-live` message.

On first load, migrate overlapping legacy localStorage feedback (`known`, `irrelevant`, `follow`) to the corresponding API signals, one article at a time, then store `cognitiveDaily.v2.signalsMigrated = true`. Keep non-overlapping legacy calibration tags such as `tooShallow` and `tooDeep` for existing metrics.

- [ ] **Step 5: Make ranking transparent**

Fetch `/api/profile` on initialization and compute the displayed total as editorial score plus a clamped personalized boost. Show both numbers in the card metadata. Preserve editorial score sorting as a distinct sort option and add “为我推荐” as the default after any profile evidence exists.

- [ ] **Step 6: Run tests and manual accessibility checks**

Run: `node --test tests/app.test.mjs tests/api.test.mjs`

Manually verify keyboard open/search/close, visible focus, 44px interest targets, refresh persistence, and direct detail navigation from an older issue.

- [ ] **Step 7: Record the archive-search checkpoint**

Refresh both index and detail pages and verify the saved button states and cross-date result links remain correct.

---

### Task 6: Implement provider clients and fallback policy

**Files:**
- Create: `lib/providers.mjs`
- Create: `lib/retrieval.mjs`
- Create: `tests/providers.test.mjs`
- Create: `tests/retrieval.test.mjs`

**Interfaces:**
- Produces: `createDoubaoClient({apiKey, chatModel, embeddingModel, baseUrl?, fetchImpl?})`.
- Produces: `createTavilyClient({apiKey, fetchImpl?})`.
- Produces: `cosineSimilarity(a, b)`, `mergeEvidence({ftsHits, vectorHits})`, `shouldSearchWeb({query, evidence, now})`.

- [ ] **Step 1: Write provider contract tests with fake fetch**

Assert the Doubao client sends `Authorization: Bearer <key>` to the configured Ark base URL, uses the configured model ID, parses cited JSON content, and throws a sanitized `ProviderError` on non-2xx without including the key. Assert Tavily requests at most 5 results and includes the Chinese query.

- [ ] **Step 2: Write fallback-policy tests**

```js
test("freshness language forces web search even with local evidence", () => {
  assert.equal(shouldSearchWeb({ query: "豆包今天发布了什么", evidence: [{ score: 0.95, publishedDate: "2026-09-08" }], now: new Date("2026-09-09") }), true);
});

test("strong fresh local coverage stays local", () => {
  assert.equal(shouldSearchWeb({ query: "解释 RAG", evidence: [{ score: 0.9, publishedDate: "2026-09-08" }], now: new Date("2026-09-09") }), false);
});
```

- [ ] **Step 3: Verify both test files fail**

Run: `node --test tests/providers.test.mjs tests/retrieval.test.mjs`

Expected: FAIL for missing modules.

- [ ] **Step 4: Implement provider clients**

Use built-in `fetch`, a 20-second `AbortSignal.timeout`, JSON request bodies and explicit response shape validation. Expose `chat({messages, responseSchema})`, `embed(texts)`, and `search(query)`. If `TAVILY_API_KEY` is absent, return a typed `ProviderUnavailableError` so the Agent can report that network verification is unavailable.

- [ ] **Step 5: Implement retrieval functions**

Normalize vectors, reject unequal dimensions/non-finite values, deduplicate by source URL or article ID, and keep the best score. `shouldSearchWeb` returns true for freshness terms, zero evidence, top combined score below `0.62`, incomplete named-object coverage, or explicit source conflict.

- [ ] **Step 6: Run provider and retrieval tests**

Run: `node --test tests/providers.test.mjs tests/retrieval.test.mjs`

Expected: PASS without real network calls or charges.

- [ ] **Step 7: Record the provider checkpoint**

Run the provider tests again with all related environment variables removed; they must still pass using fake clients and make no network requests.

---

### Task 7: Persist traceable knowledge cards

**Files:**
- Create: `lib/knowledge.mjs`
- Create: `tests/knowledge.test.mjs`
- Modify: `lib/database.mjs`

**Interfaces:**
- Produces: `normalizeSource(candidate)`, `sourceFingerprint(source)`, `validateKnowledgeCard(candidate)`, `persistKnowledgeBundle(db, {sources, cards, relations})`.
- Card type is one of `fact|concept|event|comparison|relation|inference`; status is `verified|needs_review|rejected|superseded`.

- [ ] **Step 1: Write safety, provenance and deduplication tests**

Test rejection of `javascript:` URLs, a card with no sources, unsupported status/type, full-page bodies over the excerpt limit, and duplicate normalized URLs. Test that official sources create `verified` fact cards while inference cards always create `needs_review`.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/knowledge.test.mjs`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Extend the database schema**

Create `knowledge_cards`, `knowledge_card_sources`, `embeddings`, `card_relations`, `conversations`, and `messages`. Use stable UUIDs, foreign keys and unique fingerprints. Never update the text of an existing fingerprint; insert a new card and relate it using `supersedes` or `conflicts_with`.

- [ ] **Step 4: Implement normalization and status rules**

```js
export function decideInitialStatus(card, sources) {
  if (card.type === "inference") return "needs_review";
  const trusted = sources.some((source) => ["官方公告", "官方文档", "论文", "政府机构", "GitHub Release", "GitHub Commit"].includes(source.type));
  return trusted && !card.conflicted ? "verified" : "needs_review";
}
```

Limit stored excerpts to 1,000 Unicode code points, normalize tracking parameters from URLs, and compute SHA-256 fingerprints over normalized publisher/title/URL/published date.

- [ ] **Step 5: Run knowledge and database tests**

Run: `node --test tests/knowledge.test.mjs tests/database.test.mjs`

Expected: PASS.

- [ ] **Step 6: Record the knowledge-model checkpoint**

Run: `node --test tests/knowledge.test.mjs tests/database.test.mjs`

Expected: PASS with only temporary databases created by tests.

---

### Task 8: Orchestrate cited local-first Agent answers

**Files:**
- Create: `lib/agent.mjs`
- Create: `tests/agent.test.mjs`
- Modify: `lib/api.mjs`
- Modify: `tests/api.test.mjs`

**Interfaces:**
- Consumes: database, retrieval, providers and knowledge functions.
- Produces: `createLearningAgent({db, doubao, webSearch, now?})` with `answer({question, articleId?, conversationId?})`.
- Adds: `POST /api/chat` with `{question, articleId?, conversationId?}`.

- [ ] **Step 1: Test local-only and web-fallback paths**

Use fake providers. For a strong local match, assert web search is never called and response `mode` is `local`. For “今天有什么新模型”, assert web search is called, `mode` is `local+web`, every answer citation resolves to a returned source, and persisted cards point to source IDs.

- [ ] **Step 2: Test insufficient and failed verification behavior**

When no local evidence exists and web search is unavailable, assert the result says it cannot complete current verification, contains no invented citation, and still stores the question/message but no knowledge card.

- [ ] **Step 3: Verify tests fail**

Run: `node --test tests/agent.test.mjs`

Expected: FAIL because `lib/agent.mjs` is missing.

- [ ] **Step 4: Implement one-pass orchestration**

The sequence is fixed: validate question → load current article → FTS search → optional embedding search → decide fallback → search web if needed → construct untrusted evidence blocks → request schema-constrained Doubao JSON → verify citation IDs → persist messages/sources/cards → return the safe response.

Require this response shape from the model:

```json
{
  "answerSections": [{"kind": "fact", "text": "...", "citationIds": ["source-id"]}],
  "knowledgeCards": [{"type": "fact", "title": "...", "content": "...", "citationIds": ["source-id"]}],
  "remainingUncertainty": ["..."]
}
```

Reject answer sections with missing citation IDs when `kind` is `fact` or `source_position`. Inference sections may omit citations only when visibly labelled as inference.

- [ ] **Step 5: Wire `POST /api/chat`**

Reject blank questions and questions over 4,000 characters. Return `{conversationId, mode, answerSections, sources, savedCards, remainingUncertainty}`. Map provider timeout to HTTP 504, unavailable configuration to 503, invalid request to 400, and unexpected error to 500 with a request ID.

- [ ] **Step 6: Run orchestration and API tests**

Run: `node --test tests/agent.test.mjs tests/api.test.mjs`

Expected: PASS with no real network requests.

- [ ] **Step 7: Record the Agent-core checkpoint**

Run: `node --test tests/agent.test.mjs tests/api.test.mjs`

Expected: PASS without a live豆包 or search request.

---

### Task 9: Build the conversation drawer

**Files:**
- Create: `assets/agent.js`
- Modify: `index.html`
- Modify: `detail.html`
- Modify: `assets/index.js`
- Modify: `assets/detail.js`
- Modify: `assets/styles.css`

**Interfaces:**
- Consumes: `POST /api/chat`.
- Produces: `mountLearningAgent({container, articleId?})`.

- [ ] **Step 1: Add the shared Agent markup host**

Add `<div id="learning-agent-root"></div>` before the closing body in both pages and import `mountLearningAgent`. The detail page passes the current article ID only after article loading succeeds.

- [ ] **Step 2: Implement accessible drawer interactions**

Create a fixed “问学习 Agent” button and a right-side drawer with heading, close button, message list, labelled textarea, send button and status region. On mobile, use a full-height bottom sheet. Keep focus inside while open, return focus on close, and disable send while a request is pending.

- [ ] **Step 3: Render answer provenance**

Render section `kind` labels as “事实 / 来源观点 / Agent 推断”, show `mode` as “仅本地” or “本地 + 联网”, list clickable citations below the answer, and display saved cards separately. Insert all remote strings with `textContent`; never use `innerHTML`.

- [ ] **Step 4: Handle degradation explicitly**

For 503, explain that the豆包或联网 key is not configured while local search and interest features remain usable. For 504, offer retry. Do not display raw server error objects.

- [ ] **Step 5: Manually verify both scopes**

With no API keys, verify an article-scoped question fails safely without breaking the page. With test keys configured, verify a local explanatory question stays local and a “最新” question shows “本地 + 联网” and citations.

- [ ] **Step 6: Record the conversation-UI checkpoint**

Reload both pages and verify the drawer starts closed, keeps its scope, and leaves the underlying page usable after closing.

---

### Task 10: Add knowledge, Wiki and profile views

**Files:**
- Create: `knowledge.html`
- Create: `assets/knowledge.js`
- Modify: `assets/styles.css`
- Modify: `lib/api.mjs`
- Modify: `tests/api.test.mjs`

**Interfaces:**
- Adds: `GET /api/knowledge?topic=&type=&status=`, `GET /api/wiki/:topic`, `POST /api/knowledge/export`.

- [ ] **Step 1: Test filtering, Wiki projection and export**

Seed cards for two topics. Assert filters return only matching cards, Wiki projection returns definitions/events/relations with source IDs, and export returns sources/cards/signals/conversations without environment variables or provider keys.

- [ ] **Step 2: Implement read/export endpoints**

Cap list results at 200, order by updated time, URL-decode and validate the topic, and set export headers to `Content-Disposition: attachment; filename="cognitive-daily-export-YYYY-MM-DD.json"`.

- [ ] **Step 3: Implement knowledge page navigation**

Add tabs for “知识卡片 / 主题 Wiki / 兴趣画像”. Render filter controls and empty states. The Wiki page must display `verified` and `needs_review` separately and expose citations for every item.

- [ ] **Step 4: Add entry links from index and detail pages**

Add one consistent “我的知识库” link to both headers. Do not add a new global navigation framework.

- [ ] **Step 5: Run API and complete regression tests**

Run: `node --test tests && node tests/validate-data.mjs`

Expected: every automated test passes and data validation still reports 3 issues / 48 items.

- [ ] **Step 6: Record the knowledge-view checkpoint**

Open every knowledge tab at desktop and narrow width and verify all cards remain traceable to citations.

---

### Task 11: Verify runtime, configuration and recoverability

**Files:**
- Modify: `start.ps1`
- Create: `docs/local-agent-setup.md`

**Interfaces:**
- Documents environment: `ARK_API_KEY`, `DOUBAO_CHAT_MODEL`, optional `DOUBAO_EMBEDDING_MODEL`, optional `TAVILY_API_KEY`.

- [ ] **Step 1: Document exact local setup**

Explain how to set environment variables for the current PowerShell process, start the app, check `/api/health`, and use offline-only features. State that a missing Tavily key disables web fallback and a missing Ark key disables generated answers without disabling archive search.

- [ ] **Step 2: Make startup status clear without exposing values**

After the server starts, log only:

```text
认知日报已打开：http://127.0.0.1:<port>/
豆包：已配置|未配置
联网搜索：已配置|未配置
知识库：<absolute sqlite path>
```

Do not log the values of any environment variable.

- [ ] **Step 3: Execute the final automated gate**

Run: `node --test tests && node tests/validate-data.mjs`

Expected: all tests pass; validation reports 3 issues and 48 items unless additional dated issues were intentionally added.

- [ ] **Step 4: Execute the manual acceptance gate**

Verify: current issue search still works; archive dialog returns older items; interest state survives refresh; detail hierarchy matches the spec; an article-scoped question uses article context; a freshness question attempts web; every factual answer citation opens; saved cards appear in knowledge view; exported JSON can be opened and contains no secret.

- [ ] **Step 5: Review the final file set**

Run: `Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\var\\' } | Select-Object -ExpandProperty FullName`

Expected: implementation files match the File Map, no key-bearing `.env` file was created, and runtime SQLite files appear only under `var/`.

- [ ] **Step 6: Record the final checkpoint**

Restart with `powershell -ExecutionPolicy Bypass -File .\start.ps1`, run the manual acceptance gate once more, and save the JSON knowledge export outside `var/` to prove recoverability.

---

## Deferred Work

The following are explicitly outside this plan and should be reconsidered only after the single-user evaluation demonstrates value: accounts, cross-device synchronization, PostgreSQL/pgvector, Redis or queues, object storage, billing, server-side scheduling, collaborative knowledge bases, fine-tuning, voice, multi-agent orchestration and a dedicated graph database.
