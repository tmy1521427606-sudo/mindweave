import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generationPayload, generationStage, versionFileForEntry } from "../assets/daily-generation.js";

test("empty optional morning inputs create a valid full payload", () => {
  assert.deepEqual(generationPayload({ mode: "full", date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "  ", yesterdayComment: "  " }), {
    mode: "full", date: "2026-09-11", focusMore: [], focusLess: [], temporaryFocus: "", yesterdayComment: "",
  });
});

test("generation stages expose stable progress labels", () => {
  assert.deepEqual(generationStage("searching"), ["正在联网搜索", 2]);
  assert.deepEqual(generationStage("completed"), ["日报生成完成", 6]);
});

test("version file selection falls back to the active issue", () => {
  const ref = { file: "2026-09-11-v2.json", versions: [{ version: 1, file: "2026-09-11-v1.json" }, { version: 2, file: "2026-09-11-v2.json" }] };
  assert.equal(versionFileForEntry(ref, 1), "2026-09-11-v1.json");
  assert.equal(versionFileForEntry(ref, 99), "2026-09-11-v2.json");
});

test("homepage contains the accessible morning generation console", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="generation-form"/);
  assert.match(html, /<details[^>]*class="generation-options"/);
  assert.match(html, /<summary>今日偏好（可选）<\/summary>/);
  assert.match(html, /id="generation-yesterday-comment"[^>]*maxlength="1000"/);
  assert.match(html, /id="generation-progress"/);
  assert.match(html, /role="status" aria-live="polite"/);
});
