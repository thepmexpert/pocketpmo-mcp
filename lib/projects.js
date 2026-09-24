/**
 * Project store — loads PocketPMO project export files (JSON) from a
 * directory. Schema mirrors the app's project object
 * (rebel-projectpro-suite/src/utils/blankProject.js).
 *
 * Malformed files are skipped with a warning; the server never crashes on
 * bad input.
 *
 * Hardening (review batch 5):
 * - symlinks are skipped (an attacker-planted evil.json -> /etc/shadow must
 *   not be read or exposed)
 * - files above MAX_FILE_SIZE are skipped (a 2 GB file must not be read
 *   into memory)
 * - responses carry `file` (basename) only — never the server's absolute
 *   directory structure
 * - parsed contents are cached keyed by (mtimeMs, ctimeMs, size); repeated
 *   getProject calls no longer re-read every file in the directory
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve(process.cwd(), 'data');
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
// Hard cap on cached parse entries; on overflow the oldest entries are
// evicted. In practice the dir's file count bounds this; the cap guards a
// pathological dir churn (thousands of created/renamed files in one run).
const MAX_CACHE_ENTRIES = 500;

export function projectsDir() {
  return process.env.PMO_PROJECTS_DIR
    ? path.resolve(process.env.PMO_PROJECTS_DIR)
    : DEFAULT_DIR;
}

// filePath -> { mtimeMs, ctimeMs, size, entry: { project, warning } }. Keyed
// by mtime, ctime and size so an edited file is re-read; entries for files
// that disappear from the dir are evicted on the next listProjects scan.
const parseCache = new Map();

function evictCacheFor(dir, liveFiles) {
  const prefix = dir + path.sep;
  for (const key of parseCache.keys()) {
    if (key.startsWith(prefix) && !liveFiles.has(key)) parseCache.delete(key);
  }
  while (parseCache.size > MAX_CACHE_ENTRIES) {
    parseCache.delete(parseCache.keys().next().value);
  }
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
    return { project: null, warning: `failed to open ${filePath}: ${error.message}` };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (fst.isSymbolicLink()) {
      return { project: null, warning: `symlink skipped: ${filePath}` };
    }
    if (!fst.isFile()) {
      return { project: null, warning: `not a regular file, skipped: ${filePath}` };
    }
    if (fst.size > MAX_FILE_SIZE) {
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
      return cached.entry;
    }
    const buf = Buffer.alloc(fst.size + 1);
    const read = fs.readSync(fd, buf, 0, fst.size + 1, 0);
    if (read > fst.size) {
      return { project: null, warning: `file grew past ${MAX_FILE_SIZE} bytes during read: ${filePath}` };
    }
    return { raw: buf.toString('utf8', 0, fst.size), stat: fst };
  } catch (error) {
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
  parseCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    entry
  });
  return entry;
}

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

/** List projects: minimal metadata, sorted by name. */
export function listProjects() {
  const dir = projectsDir();
  const result = { dir, projects: [], warnings: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    result.warnings.push(`projects dir not readable: ${dir}`);
    return result;
  }
  const liveFiles = new Set();
  for (const file of entries.filter((f) => f.endsWith('.json')).sort()) {
    const filePath = path.join(dir, file);
    liveFiles.add(filePath);
    const { project, warning } = readProjectFile(filePath);
    if (warning) {
      // Per-file diagnostics carry the BASENAME only — full absolute paths
      // must not reach MCP clients (the dir itself is the user's own
      // configured location; per-file paths add leak surface, not value).
      result.warnings.push(warning.replaceAll(filePath, file));
      continue;
    }
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
  evictCacheFor(dir, liveFiles);
  return result;
}

/**
 * Get one full project by id or name (case-insensitive name match).
 * The match key (id/name) lives inside each JSON file, so every candidate
 * file must be parsed at least once — the parse cache (mtimeMs, ctimeMs,
 * size keyed) is what makes repeated calls cheap; re-reading only "the
 * matching file" is not possible without knowing which file matches.
 */
export function getProject(idOrName) {
  const { projects, warnings } = listProjects();
  // Warnings from OTHER files (malformed JSON etc.) must not block lookups:
  // listProjects already skipped those files, so a matching project here is
  // fully readable. Only the matched file's own read can fail the lookup.
  if (!projects.length) {
    // Unreadable dir: the warning IS the cause (readdir failed, path is
    // already in the message — a "no project files in <dir>" prefix would
    // mislead and repeat the path).
    if (warnings[0] && warnings[0].startsWith('projects dir not readable')) {
      return { project: null, error: warnings.join('; ') };
    }
    const detail = warnings.length ? ` (${warnings.join('; ')})` : '';
    return { project: null, error: `no project files in ${projectsDir()}${detail}` };
  }
  const key = String(idOrName).toLowerCase();
  const meta = projects.find(
    (p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key
  );
  if (!meta) {
    return {
      project: null,
      error: `no project matching '${idOrName}'. Available: ${projects.map((p) => p.id).join(', ')}`
    };
  }
  const { project, warning } = readProjectFile(path.join(projectsDir(), meta.file));
  if (warning) {
    // Same leak rule as listProjects: per-file diagnostics basename-only.
    return { project: null, error: warning.replaceAll(path.join(projectsDir(), meta.file), meta.file) };
  }
  return { project, error: null };
}
