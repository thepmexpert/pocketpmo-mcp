import { test, describe, after } from 'node:test';
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
  // Register BEFORE writing files: a throwing writeFileSync must not leak
  // the freshly created dir (cubic round 1 on #13).
  createdDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// Every makeTempDir dir is removed after the file's tests finish (cubic
// round 3 on #12: ~10 dirs used to leak per run). Tests that call
// fs.mkdtemp directly clean up in their own try/finally instead.
const createdDirs = [];
after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // One stubborn dir (EPERM/EBUSY on lock-holding platforms) must not
      // abort the loop or fail the hook — the other dirs still get cleaned
      // and the suite stays green (cubic round 6 on #13).
    }
  }
});

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

function withEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
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

  // Regression (cubic round 3 on #12, defect pre-existing since v0.1):
  // non-string `name` crashed lookups dir-wide. Root cause + fix live in
  // lib/projects.js (getProject name coercion) — see the pointer there.
  test('non-string name values cannot break lookups (numeric name)', () => {
    const dir = makeTempDir({
      'a.json': JSON.stringify({ id: 7, name: 404 }),
      'b.json': good
    });
    withDir(dir, () => {
      // listProjects always tolerated it; since the CR-round-5 metadata
      // change, names render as strings ('404'), matching getProject
      const { projects } = listProjects();
      assert.equal(projects.length, 2);
      assert.equal(projects[0].name, '404');
      assert.ok(projects.every((p) => typeof p.name === 'string'));
      // name lookup of the VALID sibling must not be poisoned by a.json
      const byName = getProject('alpha');
      assert.equal(byName.error, null);
      assert.equal(byName.project.id, 1);
      // the numeric name is matched by its stringified value
      const numeric = getProject('404');
      assert.equal(numeric.error, null);
      assert.equal(numeric.project.id, 7);
      // and the error path survives: it iterates ALL candidates
      const miss = getProject('nope');
      assert.equal(miss.project, null);
      assert.ok(miss.error.includes("no project matching 'nope'"));
      assert.ok(miss.error.includes('7'), 'available ids still listed');
    });
  });

  test('falsy and object name values do not break lookups either', () => {
    const dir = makeTempDir({
      'empty-name.json': JSON.stringify({ id: 'e', name: '' }),
      'zero-name.json': JSON.stringify({ id: 'z', name: 0 }),
      'obj-name.json': JSON.stringify({ id: 'o', name: { nested: true } })
    });
    withDir(dir, () => {
      // What this pins: falsy names crash nothing and create no false
      // matches. (The || fallback itself is not distinguishable here —
      // for these fixtures the id match and the name fallback resolve to
      // the same string by definition; the semantics live in lib.)
      const byEmpty = getProject('e');
      assert.equal(byEmpty.error, null);
      assert.equal(byEmpty.project.id, 'e');
      const byZero = getProject('z');
      assert.equal(byZero.error, null);
      assert.equal(byZero.project.id, 'z');
      // an object name stringifies without throwing
      const byObj = getProject('[object object]');
      assert.equal(byObj.error, null);
      assert.equal(byObj.project.id, 'o');
      const miss = getProject('missing');
      assert.equal(miss.project, null);
      assert.ok(miss.error.includes('no project matching'));
    });
  });

  // CodeRabbit round 1 on #13: String() itself throws on objects with no
  // primitive conversion — {"toString":null} is valid JSON. Both fields
  // (id AND name) are guarded via safeString; the sibling sites in
  // listProjects metadata are covered too (rule: fix the class, not the
  // quoted line).
  test('unconvertible field values degrade to placeholders, never crashes', () => {
    const dir = makeTempDir({
      'hostile-id.json': JSON.stringify({ id: { toString: null }, name: 'Hostile' }),
      'hostile-name.json': JSON.stringify({ id: 7, name: { toString: null } }),
      'b.json': good
    });
    withDir(dir, () => {
      // full listing survives both hostile files
      const { projects } = listProjects();
      assert.equal(projects.length, 3);
      // a valid sibling is unaffected
      assert.equal(getProject('alpha').project.id, 1);
      // the hostile-name project still matches by id; its name simply
      // cannot match anything
      const byId = getProject(7);
      assert.equal(byId.error, null);
      assert.equal(byId.project.id, 7);
      // and the error path iterates every candidate without throwing
      const miss = getProject('nope');
      assert.equal(miss.project, null);
      assert.ok(miss.error.includes('no project matching'));
      assert.ok(miss.error.includes('[unprintable]'), 'unconvertible ids get a stable placeholder');
    });
  });

  // CR + cubic round 2 on #13: the [unprintable] placeholder leaked into
  // the MATCH namespace — getProject('[unprintable]') would hand over the
  // first project whose conversion failed, and an agent copying that id
  // from the Available list would silently receive an arbitrary hostile
  // project. Placeholders are display-only; matching skips them. A project
  // whose REAL id is literally '[unprintable]' still matches (it is just
  // an id).
  test('the [unprintable] placeholder is display-only, never a match target', () => {
    const dir = makeTempDir({
      'hostile-id.json': JSON.stringify({ id: { toString: null }, name: 'Hostile' }),
      'literal.json': JSON.stringify({ id: '[unprintable]', name: 'Literal' }),
      'b.json': good
    });
    withDir(dir, () => {
      const { projects } = listProjects();
      assert.equal(projects.length, 3);
      // the placeholder lookup resolves ONLY the literal-id project —
      // never a project whose conversion failed
      const lookup = getProject('[unprintable]');
      assert.equal(lookup.error, null);
      assert.equal(lookup.project.name, 'Literal');
      assert.equal(lookup.project.id, '[unprintable]');
      // the hostile project's real NAME is still matchable — only its
      // unconvertible ID field is inert
      const byHostName = getProject('hostile');
      assert.equal(byHostName.error, null);
      assert.equal(byHostName.project.name, 'Hostile');
      const miss = getProject('nope');
      assert.ok(miss.error.includes('[unprintable]'));
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

  // Regression (finding #3 residual, no-match diagnostics): when the REQUESTED
  // project's own file is the malformed one, the no-match error must say so —
  // a bare "no project matching" hides the fact that a file failed to load
  // (e.g. a partial/temp file in a shared export dir). Warnings collected by
  // the scan are basename-sanitized already; they must never leak the dir.
  test('no-match error surfaces unreadable-file context when the requested file is malformed', () => {
    const dir = makeTempDir({
      'alpha.json': '{ torn',
      'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] })
    });
    withDir(dir, () => {
      const result = getProject('alpha');
      assert.equal(result.project, null);
      assert.ok(result.error.includes("no project matching 'alpha'"));
      assert.ok(result.error.includes('Available: 2'), 'available ids still listed');
      assert.ok(
        result.error.includes('failed to parse alpha.json'),
        `unreadable context missing from: ${result.error}`
      );
      assert.ok(
        result.error.includes('files skipped (invalid or unreadable)'),
        `neutral label missing from: ${result.error}`
      );
      // Whole-payload leak rule (batch 5): the dir string appears nowhere.
      assert.ok(!JSON.stringify(result).includes(dir), 'dir leaked into result');
    });
  });

  test('clean no-match error is unchanged when nothing is unreadable', () => {
    const dir = makeTempDir({
      'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] })
    });
    withDir(dir, () => {
      const { project, error } = getProject('ghost');
      assert.equal(project, null);
      assert.equal(error, "no project matching 'ghost'. Available: 2");
    });
  });

  // #13 class sweep completion (found during the #14 rebase onto 82cb55d):
  // the REQUESTED name is untrusted too at the lib boundary — a
  // no-primitive object ({"toString":null} is valid JSON) must render as
  // the display placeholder and match nothing, never throw inside the
  // scan. matchKey/displayString split: failed conversions are inert for
  // matching, rendered for display.
  test('non-convertible requested name renders as placeholder, never throws', () => {
    const dir = makeTempDir({
      'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] })
    });
    withDir(dir, () => {
      const { project, error } = getProject({ toString: null });
      assert.equal(project, null);
      assert.ok(
        error.includes("no project matching '[unprintable]'"),
        `expected placeholder rendering, got: ${error}`
      );
      assert.ok(error.includes('Available: 2'), 'available ids still listed');
    });
  });

  // cubic P3 (PR #14 round 1): the skip context must be BOUNDED — a dir with
  // many malformed files must not produce an unbounded error line. First 3
  // basenames inline; the full list lives in list_projects.
  test('no-match skip context is capped at 3 files with a +N pointer', () => {
    const files = { 'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] }) };
    for (let i = 1; i <= 5; i++) files[`c${i}.json`] = '{ torn';
    const dir = makeTempDir(files);
    withDir(dir, () => {
      const { error } = getProject('ghost');
      assert.ok(error.includes('Available: 2'));
      for (const f of ['c1.json', 'c2.json', 'c3.json']) {
        assert.ok(error.includes(`failed to parse ${f}`), `expected ${f} in: ${error}`);
      }
      for (const f of ['c4.json', 'c5.json']) {
        assert.ok(!error.includes(f), `${f} must be capped out of: ${error}`);
      }
      assert.ok(error.includes('(+2 more'), `overflow pointer missing: ${error}`);
      assert.ok(error.length < 600, `error line unbounded (${error.length} chars)`);
    });
  });

  test('empty-dir branch caps its warning detail the same way', () => {
    const files = {};
    for (let i = 1; i <= 5; i++) files[`c${i}.json`] = '{ torn';
    const dir = makeTempDir(files);
    withDir(dir, () => {
      const { error } = getProject('x');
      assert.ok(error.startsWith('no project files in'));
      assert.ok(error.includes('c1.json') && error.includes('c3.json'));
      assert.ok(!error.includes('c4.json'), `4th file must be capped out: ${error}`);
      assert.ok(error.includes('(+2 more'), `overflow pointer missing: ${error}`);
    });
  });

  // CodeRabbit round 2 (PR #14): the requested file's own warning gets a
  // RESERVED SLOT — hoisted to the front of the capped list when its basename
  // matches '<key>.json', even when it sorts beyond the first three.
  test('requested file warning is hoisted past the cap (no-match branch)', () => {
    const files = { 'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] }) };
    for (let i = 1; i <= 4; i++) files[`c${i}.json`] = '{ torn';
    files['zeta.json'] = '{ torn';
    const dir = makeTempDir(files);
    withDir(dir, () => {
      const { error } = getProject('zeta');
      assert.ok(error.includes("no project matching 'zeta'"));
      assert.ok(
        error.includes('failed to parse zeta.json'),
        `requested file warning must be hoisted past the cap: ${error}`
      );
      assert.ok(error.includes('c1.json'), 'first sorted warning still shown');
      for (const f of ['c3.json', 'c4.json']) {
        assert.ok(!error.includes(f), `${f} must be capped out: ${error}`);
      }
      assert.ok(error.includes('(+2 more'), `overflow pointer missing: ${error}`);
    });
  });

  test('empty-dir branch hoists the requested file warning too', () => {
    const files = {};
    for (let i = 1; i <= 4; i++) files[`c${i}.json`] = '{ torn';
    files['zeta.json'] = '{ torn';
    const dir = makeTempDir(files);
    withDir(dir, () => {
      const { error } = getProject('zeta');
      assert.ok(error.startsWith('no project files in'));
      assert.ok(error.includes('failed to parse zeta.json'), `hoist missing: ${error}`);
      assert.ok(!error.includes('c3.json'), `c3 must be capped out: ${error}`);
    });
  });

  // cubic round 2 (PR #14): shape-invalid files (parsed OK, wrong shape) are
  // NOT "unreadable" — the label stays neutral across all skip reasons.
  test('shape-invalid skips carry the neutral label too', () => {
    const dir = makeTempDir({
      'beta.json': JSON.stringify({ id: 2, name: 'Beta', activities: [] }),
      'weird.json': 'null'
    });
    withDir(dir, () => {
      const { error } = getProject('ghost');
      assert.ok(error.includes('files skipped (invalid or unreadable)'));
      assert.ok(error.includes('not a JSON object: weird.json'), `got: ${error}`);
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
    if (process.platform === 'win32') return; // symlinkSync needs privileges on stock Windows
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
    if (process.platform === 'win32') return; // symlinkSync needs privileges on stock Windows
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
      const d0 = diagnostics();
      const cleared = refresh();
      const d1 = diagnostics();
      assert.ok(cleared >= 1, 'refresh reports how many entries it dropped');
      assert.equal(d1.evictions - d0.evictions, cleared, 'manual drops are counted as evictions');
      assert.equal(diagnostics().entries, 0, 'cache is empty after refresh');
      const d2 = diagnostics();
      const second = getProject('alpha');
      const d3 = diagnostics();
      assert.equal(second.error, null);
      assert.notEqual(second.project, first.project, 'a fresh parse, not the old object');
      assert.equal(d3.misses - d2.misses, 1, 'refresh forces exactly one re-read');
    });
  });

  test('cache limits are clamped to sane minimums (no impossible caps)', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withEnv('PMO_CACHE_MAX_ENTRIES', '0.5', () => {
      withEnv('PMO_CACHE_MAX_BYTES', '0.25', () => {
        withDir(dir, () => {
          refresh();
          const d = diagnostics();
          assert.equal(d.maxEntries, 1, 'fractional entry limit clamps to 1');
          assert.equal(d.maxBytes, 1, 'fractional byte limit clamps to 1');
          const { project, error } = getProject('alpha');
          assert.equal(error, null, 'lookups stay correct under an absurd limit');
          assert.equal(project.id, 1);
        });
      });
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

  test('invalidate() canonicalizes absolute paths with .. segments', () => {
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    withDir(dir, () => {
      refresh();
      listProjects();
      assert.equal(diagnostics().entries, 2);
      // Raw '..' spelling — join() would normalize it away, so build the
      // string directly. resolve() must map it onto the canonical key.
      assert.equal(invalidate(dir + '/subdir/../beta.json'), true);
      assert.equal(diagnostics().entries, 1, 'the equivalent canonical entry is gone');
    });
  });

  test('diagnostics reports the EFFECTIVE limits, including env overrides', () => {
    const dir = makeTempDir({ 'alpha.json': good });
    withEnv('PMO_CACHE_MAX_BYTES', '4096', () => {
      withEnv('PMO_CACHE_MAX_ENTRIES', '7', () => {
        withDir(dir, () => {
          refresh();
          const d = diagnostics();
          assert.equal(d.maxBytes, 4096, 'effective byte limit, not the default');
          assert.equal(d.maxEntries, 7, 'effective entry limit, not the default');
        });
      });
    });
  });

  test('getProject stops resolving at the match (files after it are not opened)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-earlyexit-'));
    try {
      // 'alpha.json' sorts BEFORE 'z-big.json': a full scan would gate-skip
      // the oversized file and bump `skips`. An early-exit match never
      // reaches it — skips must stay untouched.
      fs.writeFileSync(path.join(dir, 'alpha.json'), good);
      fs.writeFileSync(
        path.join(dir, 'z-big.json'),
        '{"id":"big","name":"Big","pad":"' + 'x'.repeat(10 * 1024 * 1024) + '"}'
      );
      withDir(dir, () => {
        refresh();
        const d0 = diagnostics();
        const { project, error } = getProject('alpha');
        const d1 = diagnostics();
        assert.equal(error, null);
        assert.equal(project.id, 1);
        assert.equal(d1.skips - d0.skips, 0, 'no gate work after the matched file');
        assert.equal(d1.misses - d0.misses, 1, 'only the matched file was read');
        // Full scans still classify the oversized file — same dir, full pass.
        const full = listProjects();
        const d2 = diagnostics();
        assert.equal(full.projects.length, 1, 'oversized file is not a project');
        assert.equal(full.warnings.length, 1);
        assert.equal(d2.skips - d1.skips, 1, 'a full scan does reach it');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  test('a file that transitions into a gate-skip state drops its stale cache entry', () => {
    // cubic round 1: gates run BEFORE the cache lookup and evictCacheFor
    // only removes vanished files — without a drop at the skip site, a
    // parsed-then-symlinked file would keep its stale parse in memory and
    // in diagnostics().entries until it disappeared entirely.
    if (process.platform === 'win32') return; // symlinkSync needs privileges on stock Windows
    const dir = makeTempDir({ 'alpha.json': good, 'beta.json': beta });
    const secret = path.join(os.tmpdir(), `pmo-mcp-secret-${process.pid}-3.json`);
    fs.writeFileSync(secret, '{"id":"evil","name":"Evil"}');
    try {
      withDir(dir, () => {
        refresh();
        listProjects();
        assert.equal(diagnostics().entries, 2);
        fs.rmSync(path.join(dir, 'beta.json'));
        fs.symlinkSync(secret, path.join(dir, 'beta.json'));
        const d0 = diagnostics();
        const { projects, warnings } = listProjects();
        const d1 = diagnostics();
        assert.equal(projects.length, 1, 'symlinked beta is not listed');
        assert.equal(warnings.length, 1);
        assert.equal(d1.skips - d0.skips, 1);
        assert.equal(d1.evictions - d0.evictions, 1, 'the stale parse is evicted at the skip site');
        assert.equal(d1.entries, 1, 'diagnostics track only live cacheable files');
      });
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  test('byte budget evicts oldest entries; listing stays correct', () => {
    const dir = makeTempDir({
      'a.json': good,
      'b.json': beta,
      'c.json': JSON.stringify({ id: 3, name: 'Gamma' })
    });
    withEnv('PMO_CACHE_MAX_BYTES', '1', () => {
      withDir(dir, () => {
        refresh();
        const d0 = diagnostics();
        const first = listProjects();
        const d1 = diagnostics();
        assert.equal(first.projects.length, 3, 'all projects listed regardless of cache state');
        assert.equal(first.warnings.length, 0);
        assert.ok(d1.evictions - d0.evictions >= 2, 'budget overflow evicted entries');
        assert.ok(d1.entries <= 1, 'a 1-byte budget holds at most the newest entry');
        // Next scan must re-parse the evicted files (budget still active).
        // Per-insert enforcement means a 1-byte budget thrashes by design:
        // each new insert evicts the previous entry, so nothing survives
        // as a cache hit — the pins here are correctness (all projects
        // listed) plus the eviction/re-parse behavior, never hit counts.
        const d2 = diagnostics();
        const second = listProjects();
        const d3 = diagnostics();
        assert.equal(second.projects.length, 3);
        assert.equal(d3.misses - d2.misses, 3, 'every file re-parses under a thrashing budget');
        assert.equal(d3.entries <= 1, true, 'cache still capped after the second scan');
      });
    });
  });

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
