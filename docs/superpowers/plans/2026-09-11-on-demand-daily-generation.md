# On-demand Daily Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-triggered, personalized, versioned daily brief generator that searches public sources, uses Doubao for structured interpretation, and never publishes partial output.

**Architecture:** A focused in-process generation service coordinates deterministic search planning, Tavily retrieval, Doubao structured generation, validation, atomic version-file publication, and SQLite synchronization. The homepage creates a job and polls its progress; completed issue versions are immutable files referenced by one active manifest entry per date.

**Tech Stack:** Node.js 22 ESM, built-in `node:http`, `node:sqlite`, browser JavaScript, HTML/CSS, Node test runner, Doubao Ark API, Tavily Search API.

**Spec:** `docs/superpowers/specs/2026-09-11-on-demand-daily-generation-design.md`

## Global Constraints

- Local single-user operation only; do not add accounts, cloud queues, schedulers, or automatic Git pushes.
- Generation starts only after `POST /api/daily-generations`; opening the page must not call a paid provider.
- Require `ARK_API_KEY`, `DOUBAO_CHAT_MODEL`, and `TAVILY_API_KEY` for generation; never expose their values.
- Accept 0–300 characters for temporary focus and 0–1000 characters for yesterday commentary.
- Generate 10–30 validated items, cap a single topic at 40%, and cover at least three main directions.
- Search the previous Shanghai calendar day first and expand to seven days only when reliable candidates are insufficient.
- Completed versions persist; running jobs do not resume after server restart.
- Use fake providers in automated tests; no real network or model calls during tests.

---

### Task 1: Version-aware issue manifest and atomic publication

**Files:**
- Create: `lib/issue-versions.mjs`
- Modify: `tests/validate-data.mjs`
- Modify: `assets/index.js`
- Modify: `assets/detail.js`
- Test: `tests/issue-versions.test.mjs`
- Test: `tests/app.test.mjs`

**Interfaces:**
- Produces: `readIssueManifest(dataDir)`, `listIssueVersions(dataDir, date)`, and `publishIssueVersion({ dataDir, issue, mode })`.
- `publishIssueVersion` returns `{ date, version, file, versions }` after the manifest points to a fully written file.
- Manifest entries retain `{ date, file, itemCount, status }` and optionally add `{ currentVersion, versions: [{ version, file, generatedAt, mode }] }`.

- [x] **Step 1: Write failing manifest tests**

```js
test("publishes immutable versions and keeps one manifest date", async () => {
  const first = await publishIssueVersion({ dataDir, issue: issue("2026-09-11", [item("a")]), mode: "full" });
  const second = await publishIssueVersion({ dataDir, issue: issue("2026-09-11", [item("b")]), mode: "full" });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  const manifest = await readIssueManifest(dataDir);
  assert.equal(manifest.issues.filter((entry) => entry.date === "2026-09-11").length, 1);
  assert.equal(manifest.issues[0].file, "2026-09-11-v2.json");
  assert.equal((await listIssueVersions(dataDir, "2026-09-11")).versions.length, 2);
});
```

- [x] **Step 2: Run the new test and verify missing-module failure**

Run: `node --test tests/issue-versions.test.mjs`

Expected: FAIL because `lib/issue-versions.mjs` does not exist.

- [x] **Step 3: Implement strict manifest reading and atomic writes**

Implement temp-file writes in the same `data/` directory followed by `rename()`. Validate the date with a strict ISO calendar-date check, derive `v1` from no existing versions, and update `index.json` only after the immutable issue file exists. Preserve unrelated manifest entries and sort descending by date.

- [x] **Step 4: Extend readers and data validation for version filenames**

Allow `YYYY-MM-DD.json` and `YYYY-MM-DD-vN.json`. When `versions` exists, require positive ascending version numbers, unique filenames, `currentVersion` equal to the active file, and each referenced file to exist. Add `version` to homepage/detail query state only when the user selects a non-current version.

- [x] **Step 5: Run focused tests**

Run: `node --test tests/issue-versions.test.mjs tests/app.test.mjs tests/validate-data.mjs`

Expected: PASS.

- [x] **Step 6: Commit**

```powershell
git add lib/issue-versions.mjs assets/index.js assets/detail.js tests/issue-versions.test.mjs tests/app.test.mjs tests/validate-data.mjs
git commit -m "feat: support versioned daily issues"
```

### Task 2: Low-weight decaying commentary preferences

**Files:**
- Modify: `lib/database.mjs`
- Create: `lib/daily-preferences.mjs`
- Test: `tests/daily-preferences.test.mjs`

**Interfaces:**
- Produces: `saveCommentSignals(db, { issueDate, comment, signals, createdAt })` and `getDecayedCommentWeights(db, { asOf })`.
- A signal is `{ topic: string, weight: -1 | 1 }`; one comment accepts at most five unique known topics.
- Decay is `weight * 0.5 ** (ageDays / 14)` and the combined returned weight for each topic is clamped to `[-2, 2]`.

- [x] **Step 1: Write failing decay and validation tests**

```js
test("comment signals decay with a fourteen-day half-life", () => {
  saveCommentSignals(db, {
    issueDate: "2026-09-10", comment: "模型对比有用", createdAt: "2026-09-11T00:00:00.000Z",
    signals: [{ topic: "模型发布与对比", weight: 1 }],
  });
  assert.equal(getDecayedCommentWeights(db, { asOf: "2026-09-25T00:00:00.000Z" })["模型发布与对比"], 0.5);
});
```

Also assert rejection of unknown topics, duplicate topics, zero weights, more than five signals, comments over 1000 characters, and invalid timestamps.

- [x] **Step 2: Run the new test and verify failure**

Run: `node --test tests/daily-preferences.test.mjs`

Expected: FAIL because the preference module and table do not exist.

- [x] **Step 3: Add an idempotent schema migration**

Add `daily_comment_preferences(id, issue_date, comment, topic, weight, created_at)` with a check constraint for weights `-1` and `1`. Keep raw comments only in SQLite; do not add them to knowledge export or issue JSON.

- [x] **Step 4: Implement storage and deterministic decay**

Use UTC instants for age calculations, ignore future rows, round returned values to four decimal places, and cap accumulated topic weights. Keep this module independent of provider calls.

- [x] **Step 5: Run focused tests and commit**

Run: `node --test tests/daily-preferences.test.mjs tests/database.test.mjs tests/api.test.mjs`

Expected: PASS.

```powershell
git add lib/database.mjs lib/daily-preferences.mjs tests/daily-preferences.test.mjs
git commit -m "feat: store decaying daily commentary preferences"
```

### Task 3: Search planning and trustworthy candidate normalization

**Files:**
- Create: `lib/daily-search.mjs`
- Modify: `lib/providers.mjs`
- Test: `tests/daily-search.test.mjs`
- Test: `tests/providers.test.mjs`

**Interfaces:**
- Produces: `buildSearchPlan({ date, focusMore, focusLess, temporaryFocus, profile })`.
- Produces: `collectCandidates({ search, plan, onProgress })` returning normalized candidates with `{ url, title, publisher, publishedDate, excerpt, sourceType, topics, window }`.
- Extends Tavily to `search(query, { maxResults = 5, startDate, endDate, includeRawContent = false } = {})` without changing existing callers.

- [x] **Step 1: Write failing previous-day-first tests**

```js
test("does not run seven-day queries when yesterday has ten reliable candidates", async () => {
  const calls = [];
  const candidates = await collectCandidates({
    search: async (query, options) => { calls.push(options); return tenOfficialResults; },
    plan: buildSearchPlan({ date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", profile: {} }),
  });
  assert.ok(candidates.length >= 10);
  assert.ok(calls.every((call) => call.startDate === "2026-09-10"));
});
```

Add tests that fewer than ten reliable candidates triggers the seven-day plan, tracking parameters deduplicate, non-HTTPS/private-host results are rejected, and a single failed query does not discard successful directions.

- [x] **Step 2: Run tests and verify failure**

Run: `node --test tests/daily-search.test.mjs tests/providers.test.mjs`

Expected: FAIL because daily search interfaces are absent.

- [x] **Step 3: Extend the Tavily client**

Map bounded options to Tavily request fields, cap results at ten per query, request markdown raw content only for generation searches, keep the 20-second per-request timeout, and preserve sanitized provider errors.

- [x] **Step 4: Implement deterministic topic queries and candidate rules**

Create Chinese and English query groups for the six confirmed areas. Use `Asia/Shanghai` calendar boundaries. Normalize URLs by removing tracking parameters, reject credentials, localhost, `.local`, private IPv4 ranges, and non-HTTPS schemes. Prefer official and primary-source patterns without asserting that unknown domains are official.

- [x] **Step 5: Run focused tests and commit**

Run: `node --test tests/daily-search.test.mjs tests/providers.test.mjs`

Expected: PASS.

```powershell
git add lib/daily-search.mjs lib/providers.mjs tests/daily-search.test.mjs tests/providers.test.mjs
git commit -m "feat: collect daily brief candidates"
```

### Task 4: Structured daily issue generation and validation

**Files:**
- Create: `lib/daily-content.mjs`
- Test: `tests/daily-content.test.mjs`

**Interfaces:**
- Produces: `extractCommentSignals({ doubao, comment, knownTopics })`.
- Produces: `generateIssueContent({ doubao, date, candidates, preferences, existingItems, onProgress })`.
- Produces: `validateGeneratedIssue(issue, { minItems = 10, maxItems = 30 })` returning a normalized immutable payload or throwing `DailyContentError` with a safe code.

- [x] **Step 1: Write failing structured-output tests**

```js
test("rejects an issue whose facts cannot resolve to supplied candidates", async () => {
  const doubao = fakeDoubaoReturning(issueWithUnknownSource);
  await assert.rejects(
    generateIssueContent({ doubao, date: "2026-09-11", candidates: [candidateA], preferences: {}, existingItems: [] }),
    (error) => error.code === "invalid_generated_content",
  );
});
```

Add tests for 10/30 boundaries, strict dates, HTTPS sources, score totals, three-direction coverage, 40% topic cap, fact/view/inference separation, retry-once behavior, supplement deduplication, and a maximum of five extracted comment signals.

- [x] **Step 2: Run the new tests and verify failure**

Run: `node --test tests/daily-content.test.mjs`

Expected: FAIL because the content module does not exist.

- [x] **Step 3: Define compact JSON schemas and prompts**

Use one small comment-classification call only when commentary is non-empty. Generate items in batches of at most five candidates. Pass candidate IDs and require every generated item to return a candidate ID; resolve source fields from the trusted candidate object rather than accepting model-provided URLs.

- [x] **Step 4: Implement deterministic validation and composition**

Reuse the existing issue field contract. Calculate `isBackfill` from dates, calculate score totals in code, enforce topic diversity after model output, and build the four-point summary from validated item one-line values. For supplement mode, keep existing IDs and normalized source URLs before adding new items.

- [x] **Step 5: Run focused tests and commit**

Run: `node --test tests/daily-content.test.mjs tests/validate-data.mjs`

Expected: PASS.

```powershell
git add lib/daily-content.mjs tests/daily-content.test.mjs
git commit -m "feat: generate validated daily brief content"
```

### Task 5: In-process generation job service

**Files:**
- Create: `lib/daily-generation.mjs`
- Test: `tests/daily-generation.test.mjs`

**Interfaces:**
- Produces: `createDailyGenerationService({ db, dataDir, doubao, search, clock, syncIssues })`.
- Service methods: `start(input) -> { jobId }`, `get(jobId) -> JobSnapshot`, `listVersions(date)`.
- Input is `{ mode, date, focusMore, focusLess, temporaryFocus, yesterdayComment }`.
- Job stages are `preparing`, `searching`, `filtering`, `verifying`, `generating`, `saving`, `completed`, and `failed`.

- [x] **Step 1: Write failing orchestration tests**

```js
test("publishes only after every stage succeeds", async () => {
  const service = serviceWithFakes();
  const { jobId } = service.start(emptyInput("2026-09-11"));
  const final = await waitForTerminal(service, jobId);
  assert.equal(final.stage, "completed");
  assert.equal((await readIssueManifest(dataDir)).issues[0].date, "2026-09-11");
  assert.equal(syncCalls, 1);
});
```

Add tests for one active job, unknown job IDs, ten-minute hard timeout, stage counts, full versus supplement, search/model/save failure mapping, no publication on failure, and completed result call counts.

- [x] **Step 2: Run the new tests and verify failure**

Run: `node --test tests/daily-generation.test.mjs`

Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement the minimal state machine**

Keep snapshots serializable and exclude raw provider bodies, prompts, comments, filesystem paths, and secrets. Generate job IDs with `randomUUID()`. Start work asynchronously without blocking the HTTP response. Reject a second start with `generation_in_progress`.

- [x] **Step 4: Connect publication and indexing**

After content validation, publish the immutable version, then call `syncIssueDirectory`. Mark completed only after both succeed. Track elapsed milliseconds, candidate count, completed item count, search call count, and model call count.

- [x] **Step 5: Run focused tests and commit**

Run: `node --test tests/daily-generation.test.mjs tests/database.test.mjs`

Expected: PASS.

```powershell
git add lib/daily-generation.mjs tests/daily-generation.test.mjs
git commit -m "feat: orchestrate daily generation jobs"
```

### Task 6: Generation API and server configuration

**Files:**
- Modify: `lib/api.mjs`
- Modify: `server.mjs`
- Modify: `start.ps1`
- Test: `tests/api.test.mjs`
- Test: `tests/agent-config.test.mjs`
- Test: `tests/start.test.mjs`

**Interfaces:**
- Extends `createApiHandler({ db, agent, dailyGeneration, maxBodyBytes })`.
- Adds `POST /api/daily-generations`, `GET /api/daily-generations/:jobId`, and `GET /api/issues/:date/versions`.
- Health adds booleans `dailyGenerationConfigured` and `webSearchConfigured` without exposing values.

- [x] **Step 1: Write failing API contract tests**

```js
test("starts and polls a daily generation", async () => {
  const started = await fetch(`${base}/api/daily-generations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "full", date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", yesterdayComment: "" }),
  });
  assert.equal(started.status, 202);
  const { jobId } = await started.json();
  assert.equal((await fetch(`${base}/api/daily-generations/${jobId}`)).status, 200);
});
```

Add tests for missing configuration, malformed bodies, length limits, overlapping topics, invalid modes/dates, unknown jobs, safe errors, and secret-free health output.

- [x] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/api.test.mjs tests/agent-config.test.mjs tests/start.test.mjs`

Expected: FAIL for missing routes and configuration.

- [x] **Step 3: Add routes and dependency wiring**

Build the daily service only when all three required environment settings exist. Share the existing Doubao and Tavily clients. Return `503 provider_unavailable` when generation is unconfigured and `409 generation_in_progress` for a concurrent job.

- [x] **Step 4: Update startup status without leaking values**

Have `start.ps1` print `日报生成：已配置` only when all required variables exist; otherwise print `日报生成：未配置`. Preserve hidden Node helper behavior.

- [x] **Step 5: Run focused tests and commit**

Run: `node --test tests/api.test.mjs tests/agent-config.test.mjs tests/start.test.mjs`

Expected: PASS.

```powershell
git add lib/api.mjs server.mjs start.ps1 tests/api.test.mjs tests/agent-config.test.mjs tests/start.test.mjs
git commit -m "feat: expose daily generation API"
```

### Task 7: Homepage generation console and version switching

**Files:**
- Modify: `index.html`
- Modify: `assets/styles.css`
- Create: `assets/daily-generation.js`
- Modify: `assets/index.js`
- Test: `tests/app.test.mjs`

**Interfaces:**
- `assets/daily-generation.js` exports `initializeDailyGeneration({ apiJson, onCompleted })`.
- It owns form state, POST creation, two-second polling, progress rendering, cost warning, and version controls.
- `onCompleted({ date, version })` asks the existing homepage controller to reload the manifest and selected issue.

- [x] **Step 1: Write failing DOM behavior tests**

Test that empty optional inputs submit, more/less choices are mutually exclusive, double click sends one POST, progress text updates through stages, provider-unavailable guidance appears, completion reloads the new version, and regenerate/supplement require the cost confirmation.

- [x] **Step 2: Run the UI tests and verify failure**

Run: `node --test tests/app.test.mjs`

Expected: FAIL because the generation console does not exist.

- [x] **Step 3: Add accessible generation markup and styles**

Place the console before issue navigation. Use a labelled form, fieldsets for topic choices, character counters, a native progress element plus live text, and a status region with `aria-live="polite"`. Keep the existing visual system and responsive breakpoints.

- [x] **Step 4: Implement form, polling, and version controls**

Do not call generation APIs during page load except read-only health/version status. Stop polling on a terminal state. Render all provider-derived strings with `textContent`. Show the five confirmed stage labels, elapsed time, counts, and configuration help.

- [x] **Step 5: Run focused UI tests and commit**

Run: `node --test tests/app.test.mjs`

Expected: PASS.

```powershell
git add index.html assets/styles.css assets/daily-generation.js assets/index.js tests/app.test.mjs
git commit -m "feat: add daily generation console"
```

### Task 8: Full regression, documentation, and local smoke test

**Files:**
- Modify: `README.md`
- Modify: `docs/local-agent-setup.md`
- Modify: `docs/superpowers/plans/2026-09-11-on-demand-daily-generation.md`

**Interfaces:**
- Documents the required provider settings, manual trigger, 3–8 minute expectation, local version files, no automatic Git push, and fake-provider test policy.

- [x] **Step 1: Run the complete automated suite**

Run: `node --test`

Expected: all existing and new tests PASS with zero real provider requests.

- [x] **Step 2: Run data validation directly**

Run: `node tests/validate-data.mjs`

Expected: prints the validated issue and unique item counts without an assertion failure.

- [x] **Step 3: Start with providers intentionally unconfigured**

Run in a clean PowerShell process with the three provider variables empty: `powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`.

Expected: the site opens, existing issues remain readable, and the generation console explains that generation is unconfigured without showing any environment value.

- [x] **Step 4: Update user documentation**

Document how to configure providers, create a full or supplement version, stop the server, find generated files, and manually push selected versions to GitHub. State clearly that opening the site is free and that only clicking generation invokes paid providers.

- [x] **Step 5: Mark completed plan checkboxes and inspect the final diff**

Run: `git status --short` and `git diff --check HEAD~1..HEAD` for the last commit, then inspect `git log --oneline` for the feature commits. Do not include SQLite files, `.env`, or secrets.

- [x] **Step 6: Commit documentation**

```powershell
git add README.md docs/local-agent-setup.md docs/superpowers/plans/2026-09-11-on-demand-daily-generation.md
git commit -m "docs: explain on-demand daily generation"
```

- [ ] **Step 7: Optional real-provider verification requires explicit approval**

Do not run a real generation automatically. If the user explicitly approves a paid smoke test and configures all three environment settings, create one generation from the UI, verify 10–30 cited items and version persistence, and report search/model call counts without printing secrets.
