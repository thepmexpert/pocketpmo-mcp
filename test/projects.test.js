import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjects, getProject } from '../lib/projects.js';

function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function withDir(dir, fn) {
  const prev = process.env.PMO_PROJECTS_DIR;
  process.env.PMO_PROJECTS_DIR = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PMO_PROJECTS_DIR;
    else process.env.PMO_PROJECTS_DIR = prev;
  }
}

const good = JSON.stringify({
  id: 1,
  name: 'Alpha',
  activities: [{ id: 'x', duration: 5, predecessors: [] }],
  risks: [{ id: 'r1', probability: 2, impact: 3 }],
  evmData: { milestones: [{ percentage: 50, cost: 100, progress: 1 }] }
});

describe('listProjects', () => {
  test('lists valid projects with counts', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      const { projects, warnings } = listProjects();
      assert.equal(warnings.length, 0);
      assert.equal(projects.length, 1);
      assert.equal(projects[0].name, 'Alpha');
      assert.equal(projects[0].activityCount, 1);
      assert.equal(projects[0].riskCount, 1);
      assert.equal(projects[0].milestoneCount, 1);
    });
  });

  test('skips malformed files with a warning, never throws', () => {
    const dir = makeTempDir({
      'alpha.json': good,
      'bad.json': '{not json',
      'empty.json': 'null',
      'notes.txt': 'ignore me'
    });
    withDir(dir, () => {
      const { projects, warnings } = listProjects();
      assert.equal(projects.length, 1);
      assert.equal(warnings.length, 2);
    });
  });

  test('unreadable dir returns empty with warning', () => {
    withDir('/nonexistent/pmo-dir-xyz', () => {
      const { projects, warnings } = listProjects();
      assert.equal(projects.length, 0);
      assert.ok(warnings[0].includes('not readable'));
    });
  });
});

describe('getProject', () => {
  test('finds by id', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      const { project, error } = getProject('1');
      assert.equal(error, null);
      assert.equal(project.name, 'Alpha');
    });
  });

  test('finds by name, case-insensitive', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      const { project, error } = getProject('alpha');
      assert.equal(error, null);
      assert.equal(project.id, 1);
    });
  });

  test('unknown id returns helpful error listing available ids', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      const { error } = getProject('nope');
      assert.ok(error.includes('no project matching'));
      assert.ok(error.includes('1'));
    });
  });
});

test('bundled sample project loads and is structurally sound', () => {
  const sample = JSON.parse(
    fs.readFileSync(new URL('../data/sample-project.json', import.meta.url), 'utf8')
  );
  assert.equal(sample.id, 101);
  assert.equal(sample.activities.length, 6);
  assert.ok(sample.activities.every((a) => typeof a.duration === 'number'));
  assert.equal(sample.risks.length, 4);
  assert.equal(sample.evmData.milestones.length, 4);
});
