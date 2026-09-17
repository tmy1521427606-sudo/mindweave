import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(testDir, "../data");
const scoreLimits = {
  interest: 30,
  impact: 20,
  source: 20,
  novelty: 15,
  crossDomain: 10,
  actionability: 5,
};
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const readJson = async (file) =>
  JSON.parse(await readFile(path.join(dataDir, file), "utf8"));
const nonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;

const index = await readJson("index.json");
assert.ok(
  Array.isArray(index.issues) && index.issues.length > 0,
  "index.issues must be non-empty",
);
assert.equal(index.issues[0].status, "tracking", "latest issue must be today's tracking issue");
const newestIssueDate = index.issues
  .map((issue) => issue.date)
  .sort((left, right) => right.localeCompare(left))[0];

const ids = new Set();
const issueDates = new Set();
for (const issueRef of index.issues) {
  assert.match(issueRef.date, isoDate, `invalid issue date: ${issueRef.date}`);
  assert.ok(!issueDates.has(issueRef.date), `duplicate issue date: ${issueRef.date}`);
  issueDates.add(issueRef.date);
  assert.match(issueRef.file, /^\d{4}-\d{2}-\d{2}(?:-v[1-9]\d*)?\.json$/, `${issueRef.date}: invalid file`);
  if (issueRef.versions !== undefined) {
    assert.ok(Array.isArray(issueRef.versions) && issueRef.versions.length > 0, `${issueRef.date}: versions missing`);
    assert.ok(Number.isInteger(issueRef.currentVersion) && issueRef.currentVersion > 0, `${issueRef.date}: invalid currentVersion`);
    const versionNumbers = issueRef.versions.map((entry) => entry.version);
    assert.deepEqual(
      versionNumbers,
      [...new Set(versionNumbers)].sort((left, right) => left - right),
      `${issueRef.date}: versions must be unique and ascending`,
    );
    for (const version of issueRef.versions) {
      assert.match(version.file, new RegExp(`^${issueRef.date}-v${version.version}\\.json$`), `${issueRef.date}: invalid version file`);
      await readJson(version.file);
    }
    assert.equal(
      issueRef.versions.find((entry) => entry.version === issueRef.currentVersion)?.file,
      issueRef.file,
      `${issueRef.date}: current version file mismatch`,
    );
  }
  assert.ok(
    issueRef.itemCount >= 10 && issueRef.itemCount <= 20,
    `${issueRef.date}: itemCount must be between 10 and 20`,
  );

  const issue = await readJson(issueRef.file);
  const generatedVersion = /-v[1-9]\d*\.json$/.test(issueRef.file);
  assert.equal(issue.date, issueRef.date, `${issueRef.file}: date mismatch`);
  if (issueRef.status !== undefined) {
    assert.ok(["tracking", "final"].includes(issueRef.status), `${issueRef.file}: invalid issue status`);
    assert.equal(issue.status, issueRef.status, `${issueRef.file}: issue status mismatch`);
  }
  assert.match(issue.generatedAt, isoDate, `${issueRef.file}: invalid generatedAt`);
  assert.ok(
    Number.isInteger(issue.readingMinutes) && issue.readingMinutes > 0,
    `${issueRef.file}: invalid readingMinutes`,
  );
  assert.ok(
    issue.items.length >= 10 && issue.items.length <= 20,
    `${issueRef.file}: expected 10 to 20 items`,
  );
  assert.equal(
    issue.items.length,
    issueRef.itemCount,
    `${issueRef.file}: itemCount mismatch`,
  );
  assert.ok(
    Array.isArray(issue.summary) && issue.summary.length > 0,
    `${issueRef.file}: summary missing`,
  );
  assert.ok(
    issue.summary.every(nonEmptyText),
    `${issueRef.file}: summary entries must be text`,
  );

  for (const item of issue.items) {
    const label = `${issueRef.file}/${item.id}`;
    assert.ok(nonEmptyText(item.id), `${issueRef.file}: item id missing`);
    assert.ok(!ids.has(item.id), `${label}: duplicate id`);
    ids.add(item.id);
    if (item.dateStatus === "unverified") {
      assert.equal(item.publishedDate, null, `${label}: unverified date must be null`);
      assert.equal(item.contentType, "learning", `${label}: unverified item must be learning`);
    } else {
      assert.match(item.publishedDate, isoDate, `${label}: invalid date`);
    }
    assert.equal(typeof item.isBackfill, "boolean", `${label}: invalid isBackfill`);
    assert.ok(
      ["news", "learning"].includes(item.contentType),
      `${label}: invalid contentType`,
    );
    assert.ok(
      ["国内", "海外", "全球"].includes(item.region),
      `${label}: invalid region`,
    );
    assert.ok(
      ["必读", "关注", "扩展"].includes(item.priority),
      `${label}: invalid priority`,
    );
    assert.ok(item.source && typeof item.source === "object", `${label}: source missing`);
    assert.ok(nonEmptyText(item.source.name), `${label}: source name missing`);
    assert.ok(nonEmptyText(item.source.type), `${label}: source type missing`);
    assert.equal(
      new URL(item.source.url).protocol,
      "https:",
      `${label}: source must use HTTPS`,
    );
    assert.ok(
      Array.isArray(item.topics) && item.topics.length > 0 && item.topics.every(nonEmptyText),
      `${label}: topics missing`,
    );
    assert.ok(
      Array.isArray(item.concepts) && item.concepts.length > 0,
      `${label}: concepts missing`,
    );
    assert.ok(
      item.concepts.every(
        (concept) => nonEmptyText(concept.name) && nonEmptyText(concept.explanation),
      ),
      `${label}: invalid concept`,
    );
    assert.ok(
      item.sourceView === null || nonEmptyText(item.sourceView),
      `${label}: invalid sourceView`,
    );
    for (const field of [
      "title",
      "fact",
      "relevance",
      "connections",
      "uncertainty",
      "action",
      "oneLineValue",
    ]) {
      assert.ok(nonEmptyText(item[field]), `${label}: ${field} missing`);
    }
    if (issueRef.date === newestIssueDate && item.contentType === "news") {
      assert.equal(typeof item.background, "string", `${item.id}: background`);
      assert.ok(item.background.trim().length >= 40, `${item.id}: background too short`);
      assert.ok(
        Array.isArray(item.development) &&
          item.development.length >= 2 &&
          item.development.every(nonEmptyText),
        `${item.id}: development`,
      );
      assert.ok(
        Array.isArray(item.impact) &&
          item.impact.length > 0 &&
          item.impact.every(
            (row) => nonEmptyText(row?.audience) && nonEmptyText(row?.text),
          ),
        `${item.id}: impact`,
      );
    }
    if (item.dateStatus === "unverified") {
      assert.equal(item.isBackfill, false, `${label}: unverified item cannot claim backfill timing`);
    } else {
      assert.equal(
        item.isBackfill,
        item.publishedDate !== issue.date,
        `${label}: backfill/date mismatch`,
      );
    }
    assert.ok(item.score && typeof item.score === "object", `${label}: score missing`);
    let total = 0;
    for (const [field, limit] of Object.entries(scoreLimits)) {
      assert.ok(Number.isInteger(item.score[field]), `${label}: ${field} must be integer`);
      assert.ok(
        item.score[field] >= 0 && item.score[field] <= limit,
        `${label}: ${field} out of range`,
      );
      total += item.score[field];
    }
    assert.equal(item.score.total, total, `${label}: score total mismatch`);
  }

  const learningItems = issue.items.filter((item) => item.contentType === "learning");
  if (!generatedVersion && issueRef.date >= "2026-09-08") {
    assert.ok(learningItems.length >= 2, `${issueRef.file}: expected at least 2 learning items`);
  }
  for (const item of learningItems) {
    assert.ok(item.learningTrack && typeof item.learningTrack === "object", `${item.id}: learningTrack missing`);
    assert.ok(nonEmptyText(item.learningTrack.topic), `${item.id}: learningTrack topic missing`);
    assert.ok(nonEmptyText(item.learningTrack.angle), `${item.id}: learningTrack angle missing`);
    assert.ok(Number.isInteger(item.learningTrack.part), `${item.id}: invalid learningTrack part`);
    assert.ok(Number.isInteger(item.learningTrack.total), `${item.id}: invalid learningTrack total`);
    assert.ok(item.learningTrack.part >= 1 && item.learningTrack.part <= item.learningTrack.total, `${item.id}: learningTrack part out of range`);
  }

  if (issueRef.date >= "2026-09-09") {
    assert.equal(issue.status, "tracking", `${issueRef.file}: today's issue must be tracking`);
    assert.ok(nonEmptyText(issue.updatedAt), `${issueRef.file}: updatedAt missing`);
    assert.ok(!Number.isNaN(Date.parse(issue.updatedAt)), `${issueRef.file}: invalid updatedAt`);
    if (!generatedVersion) {
      assert.ok(
        issue.items.some((item) => item.modelComparison),
        `${issueRef.file}: expected at least one model comparison`,
      );
      assert.ok(
        issue.items.some((item) => item.followUpSeries),
        `${issueRef.file}: expected at least one follow-up series item`,
      );
    }
    for (const item of issue.items.filter((entry) => entry.modelComparison)) {
      assert.ok(
        ["comparable", "partial", "not-comparable"].includes(item.modelComparison.comparability),
        `${item.id}: invalid model comparison comparability`,
      );
      assert.ok(
        Array.isArray(item.modelComparison.dimensions) && item.modelComparison.dimensions.length > 0,
        `${item.id}: model comparison dimensions missing`,
      );
      assert.ok(
        item.modelComparison.dimensions.every(
          (dimension) =>
            nonEmptyText(dimension.name) &&
            nonEmptyText(dimension.current) &&
            nonEmptyText(dimension.comparison) &&
            nonEmptyText(dimension.evidence),
        ),
        `${item.id}: invalid model comparison dimension`,
      );
    }
    for (const item of issue.items.filter((entry) => entry.followUpSeries)) {
      assert.ok(nonEmptyText(item.followUpSeries.id), `${item.id}: follow-up id missing`);
      assert.ok(nonEmptyText(item.followUpSeries.title), `${item.id}: follow-up title missing`);
      assert.ok(nonEmptyText(item.followUpSeries.stage), `${item.id}: follow-up stage missing`);
    }
  }
}

console.log(
  `Validated ${index.issues.length} issue(s) and ${ids.size} unique item(s).`,
);
