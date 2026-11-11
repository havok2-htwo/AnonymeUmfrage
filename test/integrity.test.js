'use strict';

// Tests der Integritätsprüfung (SPEC §6, §11): Git-Blob-Hash, Fingerabdruck, GitHub-Abgleich mit
// simuliertem fetch, Anzeige und Transparenzseite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const integrity = require('../src/integrity');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

const {
  gitBlobHash, totalFingerprint, fingerprintFiles, compareFiles, createChecker, integrityLabel, REASONS,
} = integrity;

const ROOT = path.resolve(__dirname, '..');

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha() {
  return crypto.randomBytes(20).toString('hex');
}

/** Simuliertes GitHub: antwortet auf /commits/<tag> und /git/trees/<sha>. */
function fakeGithub({ files = [], commit = sha(), tree = sha(), commitStatus = 200, treeStatus = 200, truncated = false, headers = {}, fail } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw fail;
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const response = (status, body) => ({
      status,
      headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
      json: async () => body,
    });
    if (url.includes('/commits/')) return response(commitStatus, { sha: commit, commit: { tree: { sha: tree } } });
    if (url.includes('/git/trees/')) {
      return response(treeStatus, {
        sha: tree,
        truncated,
        tree: [
          { path: 'src', type: 'tree', sha: sha() },
          ...files.map((f) => ({ path: f.path, type: 'blob', sha: f.hash, mode: '100644' })),
        ],
      });
    }
    return response(404, {});
  };
  fn.calls = calls;
  return fn;
}

/** Kleines Anwendungsverzeichnis mit Text, Binärdatei und auszulassenden Ordnern. */
function makeTree() {
  const dir = tmpDir('umfrage-int-');
  fs.mkdirSync(path.join(dir, 'src', 'views'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'speicher'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "x" }\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), "'use strict';\n// Größe: äöüß\n");
  fs.writeFileSync(path.join(dir, 'src', 'views', 'b.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'bild.bin'), Buffer.from([0, 255, 13, 10, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'leer.txt'), '');
  fs.writeFileSync(path.join(dir, 'test', 'data', 'fixture.txt'), 'bleibt drin\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'nicht prüfen\n');
  fs.writeFileSync(path.join(dir, 'data', 'umfrage.db'), 'nicht prüfen\n');
  fs.writeFileSync(path.join(dir, 'speicher', 'umfrage.db'), 'DATA_DIR, nicht prüfen\n');
  return dir;
}

test('Git-Blob-Hash: bekannte Werte', () => {
  assert.equal(gitBlobHash(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobHash(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  // Binärsicher: Bytes, die kein gültiges UTF-8 sind, werden roh gehasht.
  const bin = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const expected = crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob 4\0'), bin])).digest('hex');
  assert.equal(gitBlobHash(bin), expected);
});

test('Git-Blob-Hash stimmt mit git hash-object überein', { skip: !hasGit() && 'git nicht verfügbar' }, () => {
  const files = ['package.json', 'src/integrity.js', 'public/fonts/Montserrat-Regular.woff2', 'public/img/SonsLogo.webp'];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const expected = git(ROOT, ['hash-object', '--no-filters', abs]);
    assert.equal(gitBlobHash(fs.readFileSync(abs)), expected, rel);
  }
});

test('Fingerabdruck: Pfade mit /, Ausnahmen, sortiert', () => {
  const dir = makeTree();
  try {
    const { files, fingerprint } = fingerprintFiles(dir, { exclude: ['speicher'] });
    const paths = files.map((f) => f.path);
    assert.deepEqual(paths, ['bild.bin', 'leer.txt', 'package.json', 'src/a.js', 'src/views/b.js', 'test/data/fixture.txt']);
    assert.equal(files.find((f) => f.path === 'leer.txt').hash, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    // Reihenfolge der Eingabe spielt für den Gesamt-Fingerabdruck keine Rolle.
    assert.equal(totalFingerprint([...files].reverse()), fingerprint);
    const lines = files.map((f) => `${f.path} ${f.hash}\n`).join('');
    assert.equal(fingerprint, crypto.createHash('sha256').update(lines).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fingerabdruck entspricht git ls-tree eines echten Repositorys', { skip: !hasGit() && 'git nicht verfügbar' }, () => {
  const dir = makeTree();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n/data/\n/speicher/\n');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n*.bin binary\n');
    git(dir, ['init', '-q']);
    git(dir, ['-c', 'core.autocrlf=false', 'add', '-A']);
    git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'test']);
    const listing = git(dir, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--format=%(path) %(objectname)', 'HEAD']);
    const fromGit = listing.split('\n').map((l) => {
      const i = l.lastIndexOf(' ');
      return { path: l.slice(0, i), hash: l.slice(i + 1) };
    });
    const local = fingerprintFiles(dir, { exclude: ['speicher'] });
    const sortedGit = [...fromGit].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    assert.deepEqual(local.files, sortedGit);
    assert.equal(local.fingerprint, totalFingerprint(fromGit));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fingerabdruck des Repos entspricht HEAD, wenn das Arbeitsverzeichnis sauber ist', (t) => {
  if (!hasGit()) return t.skip('git nicht verfügbar');
  let clean = false;
  try {
    clean = git(ROOT, ['status', '--porcelain', '--untracked-files=all']) === ''
      && git(ROOT, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== '';
  } catch {
    clean = false;
  }
  if (!clean) return t.skip('Arbeitsverzeichnis nicht sauber oder ohne Commit');
  const listing = git(ROOT, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--format=%(path) %(objectname)', 'HEAD']);
  const fromGit = listing.split('\n').map((l) => {
    const i = l.lastIndexOf(' ');
    return { path: l.slice(0, i), hash: l.slice(i + 1) };
  });
  const cmp = compareFiles(fingerprintFiles(ROOT).files, fromGit);
  assert.deepEqual({ changed: cmp.changed, missing: cmp.missing, extra: cmp.extra }, { changed: [], missing: [], extra: [] });
  assert.equal(cmp.state, 'identical');
  return undefined;
});

test('Vergleich: identisch, abweichend, fehlend, zusätzlich', () => {
  const a = { path: 'a.js', hash: sha() };
  const b = { path: 'b.js', hash: sha() };
  const c = { path: 'c.js', hash: sha() };
  assert.equal(compareFiles([a, b], [b, a]).state, 'identical');

  const cmp = compareFiles([a, { path: 'b.js', hash: sha() }, { path: 'neu.js', hash: sha() }], [a, b, c]);
  assert.equal(cmp.state, 'different');
  assert.deepEqual(cmp.changed, ['b.js']);
  assert.deepEqual(cmp.missing, ['c.js']);
  assert.deepEqual(cmp.extra, ['neu.js']);
  assert.deepEqual(cmp.summary, { total: 4, identical: 1, different: 1, missing: 1, extra: 1, unchecked: 0 });
  assert.equal(cmp.files.find((f) => f.path === 'c.js').localHash, null);
  assert.equal(cmp.files.find((f) => f.path === 'neu.js').remoteHash, null);
});

function checkerFor(dir, fetch, extra = {}) {
  return createChecker({
    rootDir: dir, dataDir: path.join(dir, 'speicher'), repo: 'beispiel/umfrage', version: '1.2.3', fetch, log: null, ...extra,
  });
}

test('Abgleich mit GitHub: identisch', async () => {
  const dir = makeTree();
  try {
    const local = fingerprintFiles(dir, { exclude: ['speicher'] });
    const fetch = fakeGithub({ files: local.files, commit: 'a'.repeat(40) });
    const checker = checkerFor(dir, fetch);
    const status = await checker.start();
    checker.stop();
    assert.equal(status.state, 'identical');
    assert.equal(status.tag, 'v1.2.3');
    assert.equal(status.commit, 'a'.repeat(40));
    assert.equal(status.commitUrl, `https://github.com/beispiel/umfrage/commit/${'a'.repeat(40)}`);
    assert.equal(status.tagUrl, 'https://github.com/beispiel/umfrage/tree/v1.2.3');
    assert.equal(status.fingerprint, local.fingerprint);
    assert.equal(status.remoteFingerprint, local.fingerprint);
    assert.equal(status.summary.identical, local.files.length);
    assert.ok(status.checkedAt);
    assert.ok(Object.isFrozen(status));
    // Anfragen: Commit des Tags, dann Baum über den Tree-Hash, mit User-Agent und Timeout.
    assert.match(fetch.calls[0].url, /^https:\/\/api\.github\.com\/repos\/beispiel\/umfrage\/commits\/v1\.2\.3$/);
    assert.match(fetch.calls[1].url, /\/git\/trees\/[0-9a-f]{40}\?recursive=1$/);
    assert.equal(fetch.calls[0].opts.headers['User-Agent'], 'anonyme-umfrage');
    assert.ok(fetch.calls[0].opts.signal instanceof AbortSignal);
    assert.equal(integrityLabel(status).text, 'Code identisch mit GitHub-Version v1.2.3');
    assert.equal(integrityLabel(status).tone, 'success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Abgleich mit GitHub: abweichend mit Listen', async () => {
  const dir = makeTree();
  try {
    const local = fingerprintFiles(dir, { exclude: ['speicher'] });
    const remote = local.files
      .filter((f) => f.path !== 'leer.txt')
      .map((f) => (f.path === 'src/a.js' ? { path: f.path, hash: sha() } : f))
      .concat([{ path: 'README.md', hash: sha() }]);
    const checker = checkerFor(dir, fakeGithub({ files: remote }));
    const status = await checker.start();
    checker.stop();
    assert.equal(status.state, 'different');
    assert.deepEqual(status.changed, ['src/a.js']);
    assert.deepEqual(status.missing, ['README.md']);
    assert.deepEqual(status.extra, ['leer.txt']);
    assert.equal(status.reason, '1 Datei weicht ab, 1 Datei fehlt, 1 zusätzliche Datei');
    assert.equal(integrityLabel(status).text, 'Code weicht von GitHub-Version v1.2.3 ab');
    assert.equal(integrityLabel(status).tone, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Abgleich mit GitHub: Fehlerfälle ergeben unverified mit Grund', async () => {
  const dir = makeTree();
  try {
    const timeout = new Error('timeout');
    timeout.name = 'TimeoutError';
    const cases = [
      [fakeGithub({ commitStatus: 404 }), 'Tag v1.2.3 auf GitHub nicht gefunden'],
      [fakeGithub({ commitStatus: 403, headers: { 'X-RateLimit-Remaining': '0' } }), REASONS.rateLimit],
      [fakeGithub({ commitStatus: 429 }), REASONS.rateLimit],
      [fakeGithub({ commitStatus: 409 }), 'Tag v1.2.3 auf GitHub nicht gefunden (Repository leer)'],
      [fakeGithub({ commitStatus: 500 }), 'GitHub antwortet mit Status 500'],
      [fakeGithub({ fail: new TypeError('fetch failed') }), REASONS.network],
      [fakeGithub({ fail: timeout }), REASONS.timeout],
      [fakeGithub({ truncated: true }), REASONS.truncated],
      [fakeGithub({ treeStatus: 404 }), 'Tag v1.2.3 auf GitHub nicht gefunden'],
    ];
    for (const [fetch, reason] of cases) {
      const checker = checkerFor(dir, fetch);
      const status = await checker.start();
      checker.stop();
      assert.equal(status.state, 'unverified', reason);
      assert.equal(status.reason, reason);
      assert.equal(status.fingerprint.length, 64, 'lokaler Fingerabdruck bleibt sichtbar');
      assert.ok(status.files.every((f) => f.status === 'unchecked'));
      assert.equal(integrityLabel(status).text, `Code nicht geprüft: ${reason}`);
      assert.equal(integrityLabel(status).tone, 'warn');
    }
    const bad = checkerFor(dir, fakeGithub(), { repo: 'kein repo' });
    assert.equal((await bad.start()).reason, REASONS.repo);
    bad.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Prüfung abgeschaltet: kein Netzzugriff, lokale Hashes trotzdem da', async () => {
  const dir = makeTree();
  try {
    const fetch = fakeGithub();
    const checker = checkerFor(dir, fetch, { enabled: false });
    const status = await checker.start();
    checker.stop();
    assert.equal(fetch.calls.length, 0);
    assert.equal(status.state, 'unverified');
    assert.equal(status.reason, 'Prüfung abgeschaltet');
    assert.equal(status.files.length, 6);
    assert.equal(integrityLabel(status).text, 'Code nicht geprüft: Prüfung abgeschaltet');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Während der Prüfung: „Prüfung läuft“, gleichzeitige Prüfungen werden zusammengelegt', async () => {
  const dir = makeTree();
  try {
    const local = fingerprintFiles(dir, { exclude: ['speicher'] });
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = fakeGithub({ files: local.files });
    const fetch = async (...args) => {
      await gate;
      return inner(...args);
    };
    const checker = checkerFor(dir, fetch);
    const first = checker.start();
    assert.equal(checker.getStatus().reason, 'Prüfung läuft');
    assert.equal(checker.getStatus().checking, true);
    const second = checker.check();
    release();
    const [s1, s2] = await Promise.all([first, second]);
    checker.stop();
    assert.equal(s1, s2);
    assert.equal(inner.calls.length, 2, 'nur ein Commit- und ein Baum-Abruf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Transparenzseite und JSON', async (t) => {
  const dataDir = tmpDir('umfrage-int-app-');
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off' });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const res = await fetch(`${app.url}/transparenz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
  const page = await res.text();
  assert.match(page, /Code nicht geprüft: Prüfung abgeschaltet/);
  assert.match(page, /<details class="disclosure">/);
  assert.match(page, /git checkout v\d+\.\d+\.\d+/);
  assert.match(page, /git hash-object/);
  assert.match(page, /Grenzen, offen benannt/);
  assert.match(page, /src\/integrity\.js/);
  assert.doesNotMatch(page, /style="/);

  const jres = await fetch(`${app.url}/transparenz.json`);
  assert.equal(jres.status, 200);
  assert.match(jres.headers.get('content-type'), /application\/json/);
  const data = await jres.json();
  assert.equal(data.state, 'unverified');
  assert.equal(data.reason, 'Prüfung abgeschaltet');
  assert.equal(data.version, require('../package.json').version);
  assert.match(data.fingerprint, /^[0-9a-f]{64}$/);
  const own = data.files.find((f) => f.path === 'src/integrity.js');
  assert.ok(own);
  assert.equal(own.localHash, gitBlobHash(fs.readFileSync(path.join(ROOT, 'src', 'integrity.js'))));
  assert.ok(data.files.every((f) => !f.path.startsWith('node_modules/') && !f.path.startsWith('.git/') && !f.path.startsWith('data/')));
  assert.ok(data.files.every((f) => !f.path.includes('\\')));
  assert.equal(JSON.stringify(data).includes(dataDir), false);
});

test('Fingerabdruck: verschachteltes node_modules oder .git fällt auf, .env nie', () => {
  const dir = makeTree();
  try {
    const before = fingerprintFiles(dir, { exclude: ['speicher'] }).files;
    // Node lädt src/node_modules/pdfkit vor node_modules/pdfkit – das muss als zusätzliche Datei auffallen.
    fs.mkdirSync(path.join(dir, 'src', 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'node_modules', 'x', 'index.js'), 'eingeschleust\n');
    fs.mkdirSync(path.join(dir, 'src', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', '.git', 'HEAD'), 'versteckt\n');
    // Umgebungsdateien mit Zugangsdaten werden nie gehasht, Code-Dateien mit .env-Namen schon.
    fs.writeFileSync(path.join(dir, '.env'), 'ADMIN_USER=admin\nADMIN_PASSWORD=geheim-genug-123\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'X=1\n');
    fs.writeFileSync(path.join(dir, 'src', '.env'), 'X=2\n');
    fs.writeFileSync(path.join(dir, 'src', '.env.js'), 'module.exports = 1;\n');
    const after = fingerprintFiles(dir, { exclude: ['speicher'] }).files;
    const paths = after.map((f) => f.path);
    assert.ok(paths.includes('src/node_modules/x/index.js'));
    assert.ok(paths.includes('src/.git/HEAD'));
    assert.ok(paths.includes('src/.env.js'));
    assert.ok(!paths.includes('.env') && !paths.includes('.env.local') && !paths.includes('src/.env'));
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
    const cmp = compareFiles(after, before);
    assert.equal(cmp.state, 'different');
    assert.deepEqual(cmp.extra.sort(), ['src/.env.js', 'src/.git/HEAD', 'src/node_modules/x/index.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Transparenz: zusätzliche Dateien ohne Hash veröffentlichen', () => {
  const { transparencyJson, transparencyPage } = require('../src/views/transparency');
  const secretHash = sha();
  const status = {
    version: '1.2.3', tag: 'v1.2.3', state: 'different', reason: '1 zusätzliche Datei', checking: false,
    repo: 'beispiel/umfrage', repoUrl: 'https://github.com/beispiel/umfrage', tagUrl: null, commit: null, commitUrl: null,
    checkedAt: null, localComputedAt: null, fingerprint: sha(), remoteFingerprint: null,
    summary: { total: 2, identical: 1, different: 0, missing: 0, extra: 1, unchecked: 0 },
    files: [
      { path: 'a.js', localHash: 'a'.repeat(40), remoteHash: 'a'.repeat(40), status: 'identical' },
      { path: 'notiz.bak', localHash: secretHash, remoteHash: null, status: 'extra' },
    ],
    changed: [], missing: [], extra: ['notiz.bak'], enabled: true,
  };
  const json = transparencyJson(status);
  assert.equal(json.files.find((f) => f.path === 'notiz.bak').localHash, null);
  assert.equal(json.files.find((f) => f.path === 'a.js').localHash, 'a'.repeat(40));
  assert.equal(JSON.stringify(json).includes(secretHash), false);
  const page = transparencyPage({ status, baseUrl: 'https://umfrage.example.org' });
  assert.ok(page.includes('notiz.bak'));
  assert.equal(page.includes(secretHash), false);
  assert.match(page, /git hash-object --no-filters src\/server\.js/);
  assert.match(page, /sha1sum/);
});
