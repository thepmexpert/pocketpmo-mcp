import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProjects, getProject, projectsDir } from '../lib/projects.js';

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

  // Regression (review batch 4): a malformed file elsewhere in the dir must
  // not block getProject for valid projects. Old code short-circuited on any
  // listProjects warning, killing every project-specific tool.
  test('malformed sibling file does not block lookups of valid projects', () => {
    const dir = makeTempDir({
      'alpha.json': good,
      'corrupt.json': '{ not valid json',
      'notes.json': 'null'
    });
    withDir(dir, () => {
      // control: listProjects still reports the warnings
      const { warnings } = listProjects();
      assert.equal(warnings.length, 2);
      // by id…
      const byId = getProject('1');
      assert.equal(byId.error, null);
      assert.equal(byId.project.name, 'Alpha');
      // …and by name
      const byName = getProject('ALPHA');
      assert.equal(byName.error, null);
      assert.equal(byName.project.id, 1);
    });
  });

  test('all-invalid-files error keeps parse warnings when NO valid project exists', () => {
    const dir = makeTempDir({ 'corrupt.json': '{ not valid json' });
    withDir(dir, () => {
      const { project, error } = getProject('1');
      assert.equal(project, null);
      assert.ok(error.startsWith('no project files in'));
      assert.ok(error.includes('failed to parse'), 'diagnostics preserved in error');
    });
  });

  test('unreadable dir reports the readdir cause once, not a double path', () => {
    withDir('/nonexistent/pmo-dir-xyz', () => {
      const { project, error } = getProject('1');
      assert.equal(project, null);
      assert.ok(error.startsWith('projects dir not readable:'), `got: ${error}`);
      assert.equal(error.split(projectsDir()).length - 1, 1, 'path appears once');
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

// ---------------------------------------------------------------------------
// Review batch 5: hardening (path leakage, size cap, symlink skip, cache)
// ---------------------------------------------------------------------------

describe('review batch 5 hardening', () => {
  test('listProjects exposes file basename, never the absolute path', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      const { projects } = listProjects();
      assert.equal(projects.length, 1);
      const meta = projects[0];
      assert.equal(meta.file, 'alpha.json');
      assert.ok(!('path' in meta), 'path field must not be exposed');
      const serialized = JSON.stringify(meta);
      assert.ok(!serialized.includes(dir), 'serialized metadata must not contain the dir');
      // getProject still resolves through the basename internally
      const { project, error } = getProject('alpha');
      assert.equal(error, null);
      assert.equal(project.id, 1);
    });
  });

  test('oversized files are skipped with a warning, never read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-big-'));
    // Build a >10MB file without reading it back (block-write via createWriteStream
    // is async; use a sparse-ish repeated string just over the cap)
    const big = '{"id":"big","name":"Big","pad":"' + 'x'.repeat(10 * 1024 * 1024) + '"}';
    fs.writeFileSync(path.join(dir, 'big.json'), big);
    fs.writeFileSync(path.join(dir, 'small.json'), good);
    withDir(dir, () => {
      const { projects, warnings } = listProjects();
      assert.equal(projects.length, 1, 'only the small project is listed');
      assert.equal(projects[0].id, '1');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^file too large \(\d+ bytes/);
      assert.match(warnings[0], /big\.json/);
    });
  });

  test('symlinked .json files are skipped with a warning, not followed', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    const secret = path.join(os.tmpdir(), `pmo-mcp-secret-${process.pid}.json`);
    fs.writeFileSync(secret, JSON.stringify({ id: 'evil', name: 'Evil', root: 'hash' }));
    fs.symlinkSync(secret, path.join(dir, 'evil.json'));
    try {
      withDir(dir, () => {
        const { projects, warnings } = listProjects();
        assert.equal(projects.length, 1, 'symlink not listed as a project');
        assert.equal(warnings.length, 1);
        // O_NOFOLLOW (macOS/Linux) makes open() itself fail with ELOOP; on
        // platforms without it, the fstat gate reports the skip explicitly.
        // Either way: the link is never followed, never read.
        assert.match(warnings[0], /^(symlink skipped:|failed to open .*ELOOP)/, warnings[0]);
        assert.match(warnings[0], /evil\.json/);
      });
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  test('non-regular files (FIFO) named *.json are skipped, never blocking', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    // A FIFO named *.json is the trap: a plain open(O_RDONLY) blocks until a
    // writer appears — the server would hang forever. The O_NONBLOCK +
    // fstat-isFile gate must classify and skip it instantly.
    if (process.platform === 'win32') return; // no FIFOs on Windows
    const fifoPath = path.join(dir, 'pipe.json');
    const r = spawnSync('mkfifo', [fifoPath]);
    if (r.status !== 0) return; // platform without mkfifo — skip quietly
    withDir(dir, () => {
      const { projects, warnings } = listProjects();
      assert.equal(projects.length, 1, 'fifo not listed as a project');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^not a regular file, skipped:/, warnings[0]);
      assert.match(warnings[0], /pipe\.json/);
    });
  });

  test('parse cache: repeated getProject reuses parsed entry; edits are picked up', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    const filePath = path.join(dir, 'alpha.json');
    withDir(dir, () => {
      const first = getProject('alpha');
      assert.equal(first.error, null);
      // Same mtime+size => cache hit (observable: identity of the parsed object)
      const second = getProject('alpha');
      assert.equal(second.project, first.project, 'cache hit returns the same parsed object');
      // Edit the file (content changes; force a distinct mtime) => re-read
      const edited = JSON.parse(good);
      edited.status = 'updated';
      fs.writeFileSync(filePath, JSON.stringify(edited));
      const { atime, mtime } = fs.statSync(filePath);
      const future = new Date(mtime.getTime() + 5000);
      fs.utimesSync(filePath, atime, future);
      const third = getProject('alpha');
      assert.equal(third.error, null);
      assert.notEqual(third.project, first.project, 'edited file must not come from cache');
      assert.equal(third.project.status, 'updated');
    });
  });
});

