/**
 * ProjectRepository — loads PocketPMO project export files (JSON) from a
 * directory. Schema mirrors the app's project object
 * (rebel-projectpro-suite/src/utils/blankProject.js).
 *
 * Malformed files are skipped with a warning; the server never crashes on
 * bad input. One malformed file never prevents valid projects from loading.
 *
 * Architecture (speed review, finding #2): every public operation goes
 * through a single directory scan (`scanEntries`) that resolves each file
 * through a stat-keyed parse cache, and each consumer derives only what it
 * needs:
 *
 *   projectRepository
 *   ├── listProjects()        -> metadata array (no full project bodies kept)
 *   ├── getProject(idOrName)  -> full project, matched on the parsed entries
 *   ├── refresh()             -> drop all cached entries (force re-read)
 *   ├── invalidate(filePath)  -> drop one cached entry
 *   └── diagnostics()         -> cache counters (hits/misses/skips/evictions)
 *
 * Cache design (review batch 5 + cubic round 1):
 * - keyed by the file's ABSOLUTE path; an entry stores the POST-OPEN
 *   fstat (mtimeMs, ctimeMs, size). Any content write bumps ctime on
 *   every filesystem userspace can rely on (cp -p / rsync -t preserve
 *   mtime and size but cannot fake ctime), so edited files re-read.
 * - every gate (open, symlink, regular-file, size) runs BEFORE the cache
 *   lookup and never writes an entry — a recovered file is retried, never
 *   served from a cached warning.
 * - parse VERDICTS (including parse failures) are cached; a fixed file
 *   bumps ctime and re-reads. Gate skips (symlink/FIFO/oversized) are
 *   re-verified on every scan by design — that is the freshness
 *   policy, which is why no filesystem watcher is needed: each access
 *   stat-checks every file, which is strictly fresher than any
 *   watcher debounce and adds zero dependencies.
 * - entries for files that vanish from the dir are evicted on the next
 *   scan; the map is capped (MAX_CACHE_ENTRIES, FIFO eviction) to bound
 *   pathological dir churn.
 *
 * Deliberately synchronous: this is a stdio MCP server — requests are
 * processed sequentially, so there is no concurrent event loop to protect,
 * and sync fs keeps the read path auditable (fd-gated, size-bounded).
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve(process.cwd(), 'data');
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
// Hard cap on cached parse entries; on overflow the OLDEST inserted entries
// are evicted (FIFO via Map insertion order — good enough for a churn guard;
// steady-state portfolios live well under it). Sized for portfolio scale:
// the 1,000-project acceptance case must fit entirely in cache, or the cap
// itself would force re-reads.
//
// The count cap alone does NOT bound memory (5000 entries x MAX_FILE_SIZE
// is a 50 GB worst case), so a BYTE budget runs alongside it. Both are
// read dynamically (env-overridable) so operators — and tests — can tune
// a live process without reloading the module. Evicting to fit never
// breaks correctness: an evicted file is simply re-parsed on the next
// scan. A single file larger than the whole budget still caches (the
// loop always leaves the newest entry) — refusing it would re-read and
// re-parse it on EVERY scan, which is strictly worse.
const MAX_CACHE_ENTRIES = 5000;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024; // 256 MB

function maxCacheEntries() {
  const v = Number(process.env.PMO_CACHE_MAX_ENTRIES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : MAX_CACHE_ENTRIES;
}

function maxCacheBytes() {
  const v = Number(process.env.PMO_CACHE_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CACHE_BYTES;
}

export function projectsDir() {
  return process.env.PMO_PROJECTS_DIR
    ? path.resolve(process.env.PMO_PROJECTS_DIR)
    : DEFAULT_DIR;
}

// Cache observability. Semantics:
//   hits      — reads served from cache: NO content read, NO parse. (The
//               per-scan open+fstat freshness check still applies — a warm
//               scan is ~3 syscalls per file and ~zero parse work, not
//               zero I/O.)
//   misses    — read+parse performed (cacheable path; parse-failure verdicts
//               are cached, so a re-parse only follows a content change)
//   skips     — gated out BEFORE any read (open error, symlink, non-regular,
//               oversized): re-verified on every scan by design, never
//               cached, and any stale entry from a previous state is
//               dropped at the skip site
//   evictions — entries dropped (vanished files, FIFO cap overflow, byte
//               budget overflow, stale entries at skip sites)
const stats = { hits: 0, misses: 0, skips: 0, evictions: 0 };
// Running total of cached file sizes — maintained incrementally so the
// byte budget check is O(1) per insert/evict.
let cacheBytes = 0;

// filePath -> { mtimeMs, ctimeMs, size, entry: { project, warning } }
const parseCache = new Map();

function evictCacheFor(dir, liveFiles) {
  const prefix = dir + path.sep;
  for (const key of parseCache.keys()) {
    if (key.startsWith(prefix) && !liveFiles.has(key)) {
      cacheBytes -= parseCache.get(key).size;
      parseCache.delete(key);
      stats.evictions++;
    }
  }
  // FIFO to fit both caps; always keep the newest entry (a lone oversized
  // file re-caching every scan beats re-reading it every scan).
  while (
    parseCache.size > 1 &&
    (parseCache.size > maxCacheEntries() || cacheBytes > maxCacheBytes())
  ) {
    const key = parseCache.keys().next().value;
    cacheBytes -= parseCache.get(key).size;
    parseCache.delete(key);
    stats.evictions++;
  }
}

// Drop one entry without touching counters beyond evictions: used at the
// gate-skip sites in readViaFd. A file that transitions into a skip state
// (grows past the cap, becomes a symlink/FIFO, becomes unreadable) must not
// keep its previously cached parse alive — correctness is already safe
// (gates run before the lookup and return the skip verdict), but the stale
// entry would linger in memory and in diagnostics().entries forever.
function dropCacheEntry(filePath) {
  const prev = parseCache.get(filePath);
  if (!prev) return;
  cacheBytes -= prev.size;
  parseCache.delete(filePath);
  stats.evictions++;
}

/** Drop every cached entry; the next access re-reads from disk. Returns the
 * number of entries that were dropped. */
export function refresh() {
  const n = parseCache.size;
  parseCache.clear();
  cacheBytes = 0;
  return n;
}

/** Drop one cached entry. Accepts an absolute path or a path relative to
 * the projects dir. Absolute inputs are canonicalized (resolve + `..`
 * normalization) so equivalent spellings hit the same cache key. Returns
 * true if an entry was dropped. */
export function invalidate(filePath) {
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectsDir(), filePath);
  const prev = parseCache.get(abs);
  if (!prev) return false;
  cacheBytes -= prev.size;
  parseCache.delete(abs);
  return true;
}

/** Point-in-time copy of the cache counters. */
export function diagnostics() {
  return {
    entries: parseCache.size,
    maxEntries: MAX_CACHE_ENTRIES,
    bytes: cacheBytes,
    maxBytes: DEFAULT_MAX_CACHE_BYTES,
    hits: stats.hits,
    misses: stats.misses,
    skips: stats.skips,
    evictions: stats.evictions
  };
}

// Read via an open fd instead of by path: closes the lstat->read TOCTOU
// window (symlink swapped in between stat and read), never blocks on a
// FIFO/socket/device named *.json, and bounds the read to the fstat size +
// 1 byte (a file grown mid-read beyond the cap is rejected, not slurped).
function readViaFd(filePath) {
  // O_NONBLOCK matters: open() on an empty FIFO would otherwise block until
  // a writer appears — O_NOFOLLOW|O_NONBLOCK fails fast for every file type
  // we care about (O_NONBLOCK is a no-op for regular files), and the fstat
  // gate below classifies whatever opened.
  const openFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = fs.openSync(filePath, openFlags);
  } catch (error) {
    stats.skips++;
    dropCacheEntry(filePath);
    return { project: null, warning: `failed to open ${filePath}: ${error.message}` };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (fst.isSymbolicLink()) {
      stats.skips++;
      dropCacheEntry(filePath);
      return { project: null, warning: `symlink skipped: ${filePath}` };
    }
    if (!fst.isFile()) {
      stats.skips++;
      dropCacheEntry(filePath);
      return { project: null, warning: `not a regular file, skipped: ${filePath}` };
    }
    if (fst.size > MAX_FILE_SIZE) {
      stats.skips++;
      dropCacheEntry(filePath);
      return {
        project: null,
        warning: `file too large (${fst.size} bytes, max ${MAX_FILE_SIZE}): ${filePath}`
      };
    }
    // Cached parse results are keyed by the POST-OPEN stat: any gate above
    // (open/perm failures included) runs BEFORE the cache is consulted and
    // never writes an entry, so a recovered file (e.g. permissions fixed)
    // is retried. Parse failures ARE cached (readProjectFile below) but
    // keyed correctly: any content fix bumps ctime and forces the re-read.
    // ctimeMs joins the key because timestamp-preserving copies (cp -p,
    // rsync -t) can rewrite content at the same mtime AND size; userspace
    // cannot fake ctime, so any real content write bumps it. On FAT/exFAT
    // ctime aliases mtime at ~2 s granularity — there the key degrades to
    // the old (mtime, size) behavior, never worse.
    const cached = parseCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === fst.mtimeMs &&
      cached.ctimeMs === fst.ctimeMs &&
      cached.size === fst.size
    ) {
      stats.hits++;
      return cached.entry;
    }
    const buf = Buffer.alloc(fst.size + 1);
    const read = fs.readSync(fd, buf, 0, fst.size + 1, 0);
    if (read > fst.size) {
      stats.skips++;
      dropCacheEntry(filePath);
      return { project: null, warning: `file grew past ${MAX_FILE_SIZE} bytes during read: ${filePath}` };
    }
    return { raw: buf.toString('utf8', 0, fst.size), stat: fst };
  } catch (error) {
    stats.skips++;
    dropCacheEntry(filePath);
    return { project: null, warning: `failed to read ${filePath}: ${error.message}` };
  } finally {
    fs.closeSync(fd);
  }
}

function readProjectFile(filePath) {
  const read = readViaFd(filePath);
  if (read.project !== undefined || read.warning !== undefined) return read;
  // Not a verdict object — a successful raw read. Parse and cache.
  const { raw, stat } = read;
  stats.misses++;
  let entry;
  try {
    const project = JSON.parse(raw);
    if (!project || typeof project !== 'object') {
      entry = { project: null, warning: `not a JSON object: ${filePath}` };
    } else if (!project.id && !project.name) {
      entry = { project: null, warning: `missing id and name: ${filePath}` };
    } else {
      entry = { project, warning: null };
    }
  } catch (error) {
    entry = { project: null, warning: `failed to parse ${filePath}: ${error.message}` };
  }
  // Overwrites (content changed) replace the old entry's byte weight.
  const prev = parseCache.get(filePath);
  if (prev) cacheBytes -= prev.size;
  parseCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    entry
  });
  cacheBytes += stat.size;
  return entry;
}

/**
 * Single directory scan shared by every consumer. Resolves each *.json
 * file through the parse cache, evicts entries for files that vanished,
 * and returns the resolved entries in sorted-filename order with per-file
 * diagnostics already reduced to basenames (absolute paths never cross
 * this boundary — leak rule: full paths survive only in fatal config
 * errors the operator reads).
 */
function scanEntries() {
  const dir = projectsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { dir, fatal: `projects dir not readable: ${dir}` };
  }
  const liveFiles = new Set();
  const resolved = [];
  for (const file of entries.filter((f) => f.endsWith('.json')).sort()) {
    const filePath = path.join(dir, file);
    liveFiles.add(filePath);
    const entry = readProjectFile(filePath);
    if (entry.warning) {
      // Per-file diagnostics carry the BASENAME only — full absolute paths
      // must not reach MCP clients (the dir itself is the user's own
      // configured location; per-file paths add leak surface, not value).
      resolved.push({ file, entry: { project: null, warning: entry.warning.replaceAll(filePath, file) } });
    } else {
      resolved.push({ file, entry });
    }
  }
  evictCacheFor(dir, liveFiles);
  return { dir, resolved };
}

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

/** List projects: minimal metadata, sorted by name. */
export function listProjects() {
  const scanned = scanEntries();
  const result = { dir: scanned.dir, projects: [], warnings: [] };
  if (scanned.fatal) {
    result.warnings.push(scanned.fatal);
    return result;
  }
  for (const { file, entry } of scanned.resolved) {
    if (entry.warning) {
      result.warnings.push(entry.warning);
      continue;
    }
    const project = entry.project;
    result.projects.push({
      id: String(project.id),
      name: project.name || String(project.id),
      status: project.status || null,
      startDate: project.startDate || null,
      endDate: project.endDate || null,
      budget: project.budget ?? null,
      activityCount: count(project.activities),
      riskCount: count(project.risks),
      milestoneCount: count(project.evmData && project.evmData.milestones),
      file // basename only — the absolute path stays server-side
    });
  }
  return result;
}

/**
 * Get one full project by id or name (case-insensitive name match).
 * Matches directly on the scanned parsed entries — metadata objects are
 * NOT built for the whole portfolio on lookups (that was the finding-#2
 * waste: every getProject rebuilt metadata for every file). The match key
 * (id/name) lives inside each JSON file, so every candidate file must be
 * parsed at least once; the parse cache (mtimeMs, ctimeMs, size keyed) is
 * what makes repeated calls cheap. Duplicate names resolve deterministically
 * to the first match in sorted-filename order.
 */
export function getProject(idOrName) {
  const scanned = scanEntries();
  // Warnings from OTHER files (malformed JSON etc.) must not block lookups:
  // scanEntries already skipped those files, so a matching project here is
  // fully readable.
  if (scanned.fatal) {
    // Unreadable dir: the warning IS the cause (readdir failed, path is
    // already in the message — a "no project files in <dir>" prefix would
    // mislead and repeat the path).
    return { project: null, error: scanned.fatal };
  }
  const valid = scanned.resolved.filter(({ entry }) => !entry.warning);
  if (!valid.length) {
    const warnings = scanned.resolved
      .map(({ entry }) => entry.warning)
      .filter(Boolean);
    const detail = warnings.length ? ` (${warnings.join('; ')})` : '';
    return { project: null, error: `no project files in ${scanned.dir}${detail}` };
  }
  const key = String(idOrName).toLowerCase();
  const matched = valid.find(({ entry }) => {
    const project = entry.project;
    const name = project.name || String(project.id);
    return (
      String(project.id).toLowerCase() === key || name.toLowerCase() === key
    );
  });
  if (!matched) {
    return {
      project: null,
      error: `no project matching '${idOrName}'. Available: ${valid
        .map(({ entry }) => String(entry.project.id))
        .join(', ')}`
    };
  }
  return { project: matched.entry.project, error: null };
}

/**
 * The repository facade (finding #2 architecture). The named exports above
 * are the historical public surface — server.js imports them directly and
 * MUST keep working unchanged; this object is the same operations under the
 * finding's canonical names, for callers that prefer the repository shape.
 */
export const projectRepository = {
  listProjects,
  getProject,
  refresh,
  invalidate,
  diagnostics
};
