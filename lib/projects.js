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
 * - parsed contents are cached keyed by (mtimeMs, size); repeated
 *   getProject calls no longer re-read every file in the directory
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve(process.cwd(), 'data');
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function projectsDir() {
  return process.env.PMO_PROJECTS_DIR
    ? path.resolve(process.env.PMO_PROJECTS_DIR)
    : DEFAULT_DIR;
}

// filePath -> { mtimeMs, size, entry: { project, warning } }. Keyed by mtime
// and size so an edited file is re-read and a removed file's entry is simply
// never hit again. The map itself is bounded by the number of distinct
// project paths ever seen in one process lifetime.
const parseCache = new Map();

function readProjectFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    return { project: null, warning: `failed to stat ${filePath}: ${error.message}` };
  }
  if (stat.isSymbolicLink()) {
    return { project: null, warning: `symlink skipped: ${filePath}` };
  }
  if (stat.size > MAX_FILE_SIZE) {
    return {
      project: null,
      warning: `file too large (${stat.size} bytes, max ${MAX_FILE_SIZE}): ${filePath}`
    };
  }
  const cached = parseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entry;
  }
  let entry;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
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
  parseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
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
  for (const file of entries.filter((f) => f.endsWith('.json')).sort()) {
    const filePath = path.join(dir, file);
    const { project, warning } = readProjectFile(filePath);
    if (warning) {
      result.warnings.push(warning);
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
  return result;
}

/**
 * Get one full project by id or name (case-insensitive name match).
 * The match key (id/name) lives inside each JSON file, so every candidate
 * file must be parsed at least once — the parse cache (mtime+size keyed)
 * is what makes repeated calls cheap; re-reading only "the matching file"
 * is not possible without knowing which file matches.
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
  if (warning) return { project: null, error: warning };
  return { project, error: null };
}
