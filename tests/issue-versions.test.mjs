import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listIssueVersions,
  publishIssueVersion,
  readIssueManifest,
} from "../lib/issue-versions.mjs";

async function temporaryDataDir() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mindweave-versions-"));
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ issues: [] }));
  return dataDir;
}

function issue(date, ids) {
  return {
    date,
    status: "tracking",
    generatedAt: date,
    updatedAt: `${date}T01:00:00.000Z`,
    readingMinutes: 5,
    summary: ["摘要"],
    items: ids.map((id) => ({ id })),
  };
}

test("publishes immutable versions and keeps one manifest date", async () => {
  const dataDir = await temporaryDataDir();

  const first = await publishIssueVersion({ dataDir, issue: issue("2026-09-11", ["a"]), mode: "full" });
  const second = await publishIssueVersion({ dataDir, issue: issue("2026-09-11", ["b"]), mode: "full" });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  const manifest = await readIssueManifest(dataDir);
  assert.equal(manifest.issues.length, 1);
  assert.equal(manifest.issues[0].file, "2026-09-11-v2.json");
  assert.equal(manifest.issues[0].currentVersion, 2);
  assert.deepEqual(manifest.issues[0].versions.map((entry) => entry.version), [1, 2]);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "2026-09-11-v1.json"), "utf8")).items, [{ id: "a" }]);
});

test("preserves legacy dates and returns stable version metadata", async () => {
  const dataDir = await temporaryDataDir();
  await writeFile(path.join(dataDir, "2026-09-09.json"), JSON.stringify(issue("2026-09-09", ["old"])));
  await writeFile(path.join(dataDir, "index.json"), JSON.stringify({
    issues: [{ date: "2026-09-09", file: "2026-09-09.json", itemCount: 1, status: "tracking" }],
  }));

  await publishIssueVersion({ dataDir, issue: issue("2026-09-11", ["new"]), mode: "supplement" });
  const manifest = await readIssueManifest(dataDir);
  assert.deepEqual(manifest.issues.map((entry) => entry.date), ["2026-09-11", "2026-09-09"]);
  assert.deepEqual(await listIssueVersions(dataDir, "2026-09-09"), {
    date: "2026-09-09",
    currentVersion: null,
    versions: [{ version: null, file: "2026-09-09.json", generatedAt: "2026-09-09", mode: "legacy", current: true }],
  });
});

test("rejects invalid dates and publication modes before writing", async () => {
  const dataDir = await temporaryDataDir();
  await assert.rejects(
    publishIssueVersion({ dataDir, issue: issue("2026-02-30", ["a"]), mode: "full" }),
    /invalid issue date/,
  );
  await assert.rejects(
    publishIssueVersion({ dataDir, issue: issue("2026-09-11", ["a"]), mode: "replace" }),
    /invalid publication mode/,
  );
  assert.deepEqual((await readIssueManifest(dataDir)).issues, []);
});
