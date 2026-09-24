import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  listProjects,
  getProject,
  projectsDir,
  refresh,
  invalidate,
  diagnostics,
  projectRepository
} from '../lib/projects.js';

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
    try {
      // Build a >10MB file just over the cap
      const big = '{"id":"big","name":"Big","pad":"' + 'x'.repeat(10 * 1024 * 1024) + '"}';
      fs.writeFileSync(path.join(dir, 'big.json'), big);
      fs.writeFileSync(path.join(dir, 'small.json'), good);
      withDir(dir, () => {
        // Regression tripwire: the read path must never pull the oversized
        // file's content into memory. If a future refactor reintroduces a
        // blind readFileSync, this fails with the file's size in the message.
        const origReadFileSync = fs.readFileSync;
        let bigReads = 0;
        fs.readFileSync = function spied(filePath, ...rest) {
          if (String(filePath).endsWith('big.json')) bigReads++;
          return origReadFileSync.call(fs, filePath, ...rest);
        };
        try {
          const { projects, warnings } = listProjects();
          assert.equal(projects.length, 1, 'only the small project is listed');
          assert.equal(projects[0].id, '1');
          assert.equal(warnings.length, 1);
          assert.match(warnings[0], /^file too large \(\d+ bytes/);
          assert.match(warnings[0], /big\.json/);
          assert.equal(bigReads, 0, 'oversized file must never be read');
        } finally {
          fs.readFileSync = origReadFileSync;
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      const third = getProject('alpha');
      assert.equal(third.error, null);
      assert.notEqual(third.project, first.project, 'edited file must not come from cache');
      assert.equal(third.project.status, 'updated');
    });
  });
});


// ---------------------------------------------------------------------------
// Cubic round-1 follow-up: the ctimeMs cache-key row
// ---------------------------------------------------------------------------

describe('parse cache ctime key', () => {
  test('same-size, same-mtime rewrite is re-read (the cp -p / rsync -t case)', (t) => {
    // The pre-existing "edits are picked up" test rewrites via
    // JSON.stringify of an object with an ADDED field — serialized size
    // grows, so the (mtime, size) rows alone invalidate the entry and that
    // test passes even with ctimeMs removed from the comparison. This test
    // changes content at IDENTICAL serialized size and RESTORES the old
    // mtime (utimesSync): only the ctime row can detect the rewrite.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-ctime-'));
    try {
      const file = path.join(dir, 'p.json');
      const mk = (pad) => JSON.stringify({ id: 'x', name: 'X', pad });
      fs.writeFileSync(file, mk('aaaa'));
      // Quantize the mtime to a whole ms BEFORE the first read: APFS mtimes
      // carry sub-ms components, and utimesSync(Date) truncates to ms — an
      // imprecise restore would miss the cache on the mtime row alone and
      // let this test pass even without the ctime row (vacuously).
      fs.utimesSync(file, new Date(), new Date(1_700_000_000_000));
      withDir(dir, () => {
        const first = getProject('x');
        assert.equal(first.error, null);
        assert.equal(first.project.pad, 'aaaa');
        // Rewrite at the same size, then restore the exact pre-rewrite mtime
        // — userspace cannot fake ctime, so the cache must re-read.
        const before = fs.statSync(file);
        assert.equal(before.mtimeMs, 1_700_000_000_000, 'mtime quantization must be exact for this test to be meaningful');
        fs.writeFileSync(file, mk('bbbb'));
        fs.utimesSync(file, before.atime, before.mtime);
        const after = fs.statSync(file);
        if (after.ctimeMs === before.ctimeMs) {
          // This filesystem never bumped ctime (FAT-like granularity): the
          // cache cannot distinguish this rewrite here at all — skip rather
          // than fail on a guarantee the platform cannot support. RETURN:
          // t.skip() only marks the result; the remaining assertions would
          // still run (and fail on the stale cache entry).
          return t.skip('filesystem did not bump ctime; rewrite is indistinguishable here');
        }
        const again = getProject('x');
        assert.equal(again.error, null);
        assert.equal(again.project.pad, 'bbbb', 'same-size same-mtime rewrite must not be served from cache');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Project repository (speed review, finding #2): cache observability,
// refresh/invalidate, duplicate names, deleted-file eviction, portfolio scale.
// All counter assertions use DELTAS: the parse cache and its counters are
// module-level and shared across this whole test file.
// ---------------------------------------------------------------------------

const beta = JSON.stringify({
  id: 2,
  name: 'Beta',
  activities: [{ id: 'y', duration: 3, predecessors: [] }],
  risks: [],
  evmData: { milestones: [] }
});

describe('project repository: cache observability', () => {
  test('repeated listProjects calls do not re-read unchanged files', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    withDir(dir, () => {
      refresh();
      const d0 = diagnostics();
      listProjects();
      const d1 = diagnostics();
      assert.equal(d1.misses - d0.misses, 2, 'first scan parses each file exactly once');
      assert.equal(d1.skips - d0.skips, 0);
      listProjects();
      const d2 = diagnostics();
      assert.equal(d2.hits - d1.hits, 2, 'second scan is served from cache');
      assert.equal(d2.misses - d1.misses, 0, 'unchanged files are not re-read');
    });
  });

  test('exactly the changed file is re-read after an edit', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    withDir(dir, () => {
      refresh();
      listProjects();
      listProjects();
      const d0 = diagnostics();
      const edited = JSON.parse(beta);
      edited.status = 'updated';
      fs.writeFileSync(path.join(dir, 'beta.json'), JSON.stringify(edited));
      listProjects();
      const d1 = diagnostics();
      assert.equal(d1.misses - d0.misses, 1, 'only the edited file is re-parsed');
      assert.equal(d1.hits - d0.hits, 1, 'the untouched file stays a cache hit');
    });
  });

  test('malformed parse failures are cached verdicts; valid files unaffected', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'bad.json': '{not json' });
    withDir(dir, () => {
      refresh();
      const first = listProjects();
      assert.equal(first.projects.length, 1);
      assert.equal(first.warnings.length, 1);
      const d0 = diagnostics();
      const second = listProjects();
      const d1 = diagnostics();
      assert.equal(second.warnings.length, 1, 'the warning is still reported');
      assert.equal(d1.hits - d0.hits, 2, 'parse-failure verdict is cached too');
      assert.equal(d1.misses - d0.misses, 0, 'malformed file is not re-parsed');
    });
  });

  test('gate-skipped files are re-checked every scan (never cached)', () => {
    // Rule 36: never cache gate failures. A symlink that is later replaced
    // by a real file must be picked up on the next scan, so skips cannot
    // produce cached verdicts — pinned here via the skips counter.
    const dir = makeTempDir({ 'alpha.json': good });
    const secret = path.join(os.tmpdir(), `pmo-mcp-secret-${process.pid}-2.json`);
    fs.writeFileSync(secret, '{"id":"evil","name":"Evil"}');
    fs.symlinkSync(secret, path.join(dir, 'evil.json'));
    try {
      withDir(dir, () => {
        refresh();
        listProjects();
        const d0 = diagnostics();
        listProjects();
        const d1 = diagnostics();
        assert.equal(d1.hits - d0.hits, 1, 'valid file is a cache hit');
        assert.equal(d1.misses - d0.misses, 0);
        assert.equal(d1.skips - d0.skips, 1, 'symlink is re-verified every scan');
      });
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});

describe('project repository: refresh / invalidate / facade', () => {
  test('refresh() forces the next access to re-read from disk', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      refresh();
      const first = getProject('alpha');
      assert.equal(first.error, null);
      const cleared = refresh();
      assert.ok(cleared >= 1, 'refresh reports how many entries it dropped');
      assert.equal(diagnostics().entries, 0, 'cache is empty after refresh');
      const d0 = diagnostics();
      const second = getProject('alpha');
      const d1 = diagnostics();
      assert.equal(second.error, null);
      assert.notEqual(second.project, first.project, 'a fresh parse, not the old object');
      assert.equal(d1.misses - d0.misses, 1, 'refresh forces exactly one re-read');
    });
  });

  test('invalidate() drops exactly one entry; unknown path returns false', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    withDir(dir, () => {
      refresh();
      const cachedBefore = getProject('beta').project; // identity of the cached parse
      listProjects();
      assert.equal(diagnostics().entries, 2);
      assert.equal(invalidate(path.join(dir, 'beta.json')), true);
      assert.equal(diagnostics().entries, 1, 'only the targeted entry is gone');
      const after = getProject('beta').project;
      assert.notEqual(after, cachedBefore, 'invalidated entry forces a re-read');
      assert.equal(invalidate(path.join(dir, 'gamma.json')), false, 'unknown path has no entry');
    });
  });

  test('projectRepository facade exposes the finding-#2 architecture', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withDir(dir, () => {
      for (const method of ['listProjects', 'getProject', 'refresh', 'invalidate', 'diagnostics']) {
        assert.equal(typeof projectRepository[method], 'function', `facade has ${method}`);
      }
      refresh();
      const { projects, warnings } = projectRepository.listProjects();
      assert.equal(warnings.length, 0);
      assert.equal(projects.length, 1);
      const { project, error } = projectRepository.getProject('alpha');
      assert.equal(error, null);
      assert.equal(project.id, 1);
      assert.equal(typeof projectRepository.diagnostics().entries, 'number');
      assert.equal(projectRepository.invalidate(path.join(dir, 'alpha.json')), true);
      assert.ok(projectRepository.refresh() >= 0);
    });
  });
});

describe('project repository: directory churn', () => {
  test('duplicate project names resolve deterministically (first by sorted filename)', () => {
    const dir = makeTempDir({
      'b.json': JSON.stringify({ id: 'B', name: 'Dup' }),
      'a.json': JSON.stringify({ id: 'A', name: 'Dup' })
    });
    withDir(dir, () => {
      refresh();
      const { projects } = listProjects();
      assert.equal(projects.length, 2, 'both duplicates are listed');
      const byName = getProject('dup');
      assert.equal(byName.error, null);
      assert.equal(byName.project.id, 'A', 'name match wins by sorted-filename order (a.json first)');
      const byId = getProject('B');
      assert.equal(byId.error, null);
      assert.equal(byId.project.id, 'B', 'the second duplicate stays reachable by id');
    });
  });

  test('deleted files are evicted from the cache and stop resolving', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    const betaPath = path.join(dir, 'beta.json');
    withDir(dir, () => {
      refresh();
      const first = listProjects();
      assert.equal(first.projects.length, 2);
      assert.equal(diagnostics().entries, 2);
      fs.rmSync(betaPath);
      const d0 = diagnostics();
      const second = listProjects();
      const d1 = diagnostics();
      assert.equal(second.projects.length, 1);
      assert.equal(second.projects[0].id, '1');
      assert.equal(second.warnings.length, 0);
      assert.equal(d1.evictions - d0.evictions, 1, 'the vanished file is evicted');
      assert.equal(d1.entries, 1, 'no stale cache entry remains');
      const gone = getProject('2');
      assert.equal(gone.project, null);
      assert.match(gone.error, /no project matching '2'/);
      assert.match(gone.error, /Available: 1/, 'survivor is still listed as available');
    });
  });
});

describe('portfolio scale (1000 files)', () => {
  test('1000-file portfolio: one parse per file, then pure cache hits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-scale-'));
    try {
      for (let i = 0; i < 1000; i++) {
        fs.writeFileSync(
          path.join(dir, `p-${String(i).padStart(4, '0')}.json`),
          JSON.stringify({
            id: `p-${i}`,
            name: `Project ${i}`,
            status: 'active',
            activities: [{ id: 'a1', duration: 5, predecessors: [] }]
          })
        );
      }
      withDir(dir, () => {
        refresh();
        const d0 = diagnostics();
        const first = listProjects();
        const d1 = diagnostics();
        assert.equal(first.projects.length, 1000);
        assert.equal(first.warnings.length, 0);
        assert.equal(d1.misses - d0.misses, 1000, 'first scan parses each file exactly once');
        const second = listProjects();
        const d2 = diagnostics();
        assert.equal(second.projects.length, 1000);
        assert.equal(d2.hits - d1.hits, 1000, 'second scan: zero re-reads, pure cache hits');
        assert.equal(d2.misses - d1.misses, 0, 'acceptance: repeated calls do not re-read unchanged files');
        const picked = getProject('p-943');
        assert.equal(picked.error, null);
        assert.equal(picked.project.id, 'p-943');
        const d2b = diagnostics(); // snapshot AFTER the getProject hit
        fs.writeFileSync(
          path.join(dir, 'p-0500.json'),
          JSON.stringify({ id: 'p-500', name: 'Project 500', status: 'edited', activities: [] })
        );
        const third = listProjects();
        const d3 = diagnostics();
        assert.equal(d3.misses - d2b.misses, 1, 'exactly the changed file is re-read at scale');
        assert.equal(d3.hits - d2b.hits, 999, 'the other 999 stay cache hits');
        assert.equal(third.projects.find((p) => p.id === 'p-500').status, 'edited');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
