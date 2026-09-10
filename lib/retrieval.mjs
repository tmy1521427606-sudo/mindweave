const WEB_SEARCH_SCORE = 0.62;
const FRESHNESS_LANGUAGE = /今天|今日|最新|刚刚|目前|现在|实时|近期|本周|新闻|动态|当下|today|latest|current|recent|breaking|news/i;

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new TypeError("vectors must be arrays");
  if (a.length !== b.length) throw new RangeError("vectors must have equal dimensions");

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new TypeError("vector values must be finite");
    dot += left * right;
    aMagnitude += left * left;
    bMagnitude += right * right;
  }
  if (aMagnitude === 0 || bMagnitude === 0) throw new RangeError("vectors must be non-zero");
  return dot / Math.sqrt(aMagnitude * bMagnitude);
}

export function mergeEvidence({ ftsHits = [], vectorHits = [] } = {}) {
  if (!Array.isArray(ftsHits) || !Array.isArray(vectorHits)) throw new TypeError("evidence hits must be arrays");
  const groupsByIdentity = new Map();

  for (const hit of [...ftsHits, ...vectorHits]) {
    if (!hit || typeof hit !== "object" || !Number.isFinite(hit.score)) {
      throw new TypeError("each evidence hit needs a finite score");
    }
    const identities = evidenceIdentities(hit);
    const matchingGroups = [...new Set(identities.map((identity) => groupsByIdentity.get(identity)).filter(Boolean))];
    const group = matchingGroups.shift() ?? { best: hit, identities: new Set() };

    for (const matchingGroup of matchingGroups) {
      if (matchingGroup.best.score > group.best.score) group.best = matchingGroup.best;
      for (const identity of matchingGroup.identities) {
        group.identities.add(identity);
        groupsByIdentity.set(identity, group);
      }
    }
    for (const identity of identities) {
      group.identities.add(identity);
      groupsByIdentity.set(identity, group);
    }
    if (hit.score > group.best.score) group.best = hit;
  }
  return [...new Set(groupsByIdentity.values())]
    .map((group) => group.best)
    .sort((left, right) => right.score - left.score);
}

export function shouldSearchWeb({
  query,
  evidence = [],
  now = new Date(),
  requiredObjects = [],
  maxEvidenceAgeDays = 90,
} = {}) {
  if (typeof query !== "string") throw new TypeError("query must be a string");
  if (!Array.isArray(evidence)) throw new TypeError("evidence must be an array");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new TypeError("now must be a valid Date");
  if (!Array.isArray(requiredObjects) || requiredObjects.some((name) => typeof name !== "string")) {
    throw new TypeError("requiredObjects must be an array of strings");
  }
  if (maxEvidenceAgeDays !== Infinity && (!Number.isFinite(maxEvidenceAgeDays) || maxEvidenceAgeDays < 0)) {
    throw new TypeError("maxEvidenceAgeDays must be a non-negative number or Infinity");
  }
  if (FRESHNESS_LANGUAGE.test(query) || evidence.length === 0) return true;

  const topScore = Math.max(...evidence.map((item) => Number(item?.score)));
  if (!Number.isFinite(topScore) || topScore < WEB_SEARCH_SCORE) return true;
  if (evidence.some((item) => item?.sourceConflict === true || item?.conflict === true)) return true;

  const coverageEvidence = evidence.filter((item) => Array.isArray(item?.namedObjects));
  if (requiredObjects.length > 0) {
    const covered = new Set(coverageEvidence.flatMap((item) => item.namedObjects));
    if (requiredObjects.some((name) => !covered.has(name))) return true;
  }

  const namedObjects = namedObjectsIn(query);
  if (namedObjects.length > 0 && coverageEvidence.length > 0) {
    const covered = new Set(coverageEvidence.flatMap((item) => item.namedObjects));
    if (namedObjects.some((name) => !covered.has(name))) return true;
  }
  if (namedObjects.length === 0 && evidence.some((item) => item?.namedObjectCoverage === false)) return true;
  if (coverageEvidence.length === 0 && evidence.some((item) => item?.namedObjectCoverage === false)) return true;

  return isEvidenceStale(evidence, now, maxEvidenceAgeDays);
}

function evidenceIdentities(hit) {
  if (hit.evidenceVersion) return [`version:${hit.evidenceVersion}`];
  const identities = [];
  const sourceUrl = hit.sourceUrl ?? hit.url ?? hit.source?.url;
  if (typeof sourceUrl === "string" && sourceUrl) identities.push(`url:${sourceUrl}`);
  const articleId = hit.articleId ?? hit.id;
  if (typeof articleId === "string" || typeof articleId === "number") identities.push(`article:${articleId}`);
  if (identities.length === 0) throw new TypeError("evidence hit needs a source URL or article ID");
  return identities;
}

function isEvidenceStale(evidence, now, maxEvidenceAgeDays) {
  const latestPublished = Math.max(...evidence
    .map((item) => parsePublishedDate(item?.publishedDate))
    .filter(Number.isFinite));
  if (!Number.isFinite(latestPublished)) return true;
  if (maxEvidenceAgeDays === Infinity) return false;
  return now.valueOf() - latestPublished > maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
}

function parsePublishedDate(value) {
  if (typeof value !== "string") return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return Number.NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
    return Number.NaN;
  }
  if (!match[4]) return calendarDate.valueOf();

  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return Number.NaN;
  if (match[7] !== "Z") {
    const timezone = /^([+-])(\d{2}):(\d{2})$/.exec(match[7]);
    if (!timezone || Number(timezone[2]) > 23 || Number(timezone[3]) > 59) return Number.NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function namedObjectsIn(query) {
  return [...new Set(query.match(/\b[A-Z][A-Za-z0-9.-]*\b/g) ?? [])];
}
