/**
 * Project store — loads PocketPMO project export files (JSON) from a
 * directory. Schema mirrors the app's project object
 * (rebel-projectpro-suite/src/utils/blankProject.js).
 *
 * Malformed files are skipped with a warning; the server never crashes on
 * bad input.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve(process.cwd(), 'data');

export function projectsDir() {
  return process.env.PMO_PROJECTS_DIR
    ? path.resolve(process.env.PMO_PROJECTS_DIR)
    : DEFAULT_DIR;
}

function readProjectFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const project = JSON.parse(raw);
    if (!project || typeof project !== 'object') {
      return { project: null, warning: `not a JSON object: ${filePath}` };
    }
    if (!project.id && !project.name) {
      return { project: null, warning: `missing id and name: ${filePath}` };
    }
    return { project, warning: null };
  } catch (error) {
    return { project: null, warning: `failed to parse ${filePath}: ${error.message}` };
  }
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
      path: filePath
    });
  }
  return result;
}

/** Get one full project by id or name (case-insensitive name match). */
export function getProject(idOrName) {
  const { projects, warnings } = listProjects();
  // Warnings from OTHER files (malformed JSON etc.) must not block lookups:
  // listProjects already skipped those files, so a matching project here is
  // fully readable. Only the matched file's own read can fail the lookup.
  if (!projects.length) {
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
  const { project, warning } = readProjectFile(meta.path);
  if (warning) return { project: null, error: warning };
  return { project, error: null };
}
