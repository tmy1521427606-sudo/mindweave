import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(["full", "supplement"]);

export async function readIssueManifest(dataDir) {
  const value = JSON.parse(await readFile(path.join(dataDir, "index.json"), "utf8"));
  if (!value || !Array.isArray(value.issues)) throw new TypeError("invalid issue manifest");
  return value;
}

export async function listIssueVersions(dataDir, date) {
  assertDate(date);
  const manifest = await readIssueManifest(dataDir);
  const issue = manifest.issues.find((entry) => entry.date === date);
  if (!issue) return { date, currentVersion: null, versions: [] };
  if (!Array.isArray(issue.versions) || issue.versions.length === 0) {
    return {
      date,
      currentVersion: null,
      versions: [{
        version: null,
        file: issue.file,
        generatedAt: issue.generatedAt ?? date,
        mode: "legacy",
        current: true,
      }],
    };
  }
  return {
    date,
    currentVersion: issue.currentVersion,
    versions: issue.versions.map((entry) => ({
      ...entry,
      current: entry.version === issue.currentVersion,
    })),
  };
}

export async function publishIssueVersion({ dataDir, issue, mode, afterPublish }) {
  if (!issue || typeof issue !== "object") throw new TypeError("issue is required");
  assertDate(issue.date);
  if (!MODES.has(mode)) throw new TypeError("invalid publication mode");
  if (!Array.isArray(issue.items)) throw new TypeError("issue items are required");
  if (afterPublish !== undefined && typeof afterPublish !== "function") throw new TypeError("afterPublish must be a function");

  const manifest = await readIssueManifest(dataDir);
  const current = manifest.issues.find((entry) => entry.date === issue.date);
  const previousVersions = Array.isArray(current?.versions) ? current.versions : [];
  const version = previousVersions.reduce((highest, entry) => Math.max(highest, entry.version || 0), 0) + 1;
  const file = `${issue.date}-v${version}.json`;
  const generatedAt = issue.updatedAt ?? issue.generatedAt;
  const versions = [...previousVersions, { version, file, generatedAt, mode }];
  const nextEntry = {
    date: issue.date,
    file,
    itemCount: issue.items.length,
    status: issue.status,
    currentVersion: version,
    versions,
  };
  const nextManifest = {
    ...manifest,
    issues: [nextEntry, ...manifest.issues.filter((entry) => entry.date !== issue.date)]
      .sort((left, right) => right.date.localeCompare(left.date)),
  };

  await atomicJsonWrite(dataDir, file, issue);
  await atomicJsonWrite(dataDir, "index.json", nextManifest);
  try {
    await afterPublish?.();
  } catch (error) {
    await atomicJsonWrite(dataDir, "index.json", manifest);
    await unlink(path.join(dataDir, file));
    throw error;
  }
  return { date: issue.date, version, file, versions };
}

async function atomicJsonWrite(directory, filename, value) {
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path.join(directory, filename));
}

function assertDate(date) {
  if (!ISO_DATE.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new TypeError("invalid issue date");
  }
}
