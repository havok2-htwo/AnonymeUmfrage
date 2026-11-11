'use strict';

// Integritätsprüfung (SPEC §6).
//
// 1. Lokaler Fingerabdruck (einmal beim Start): Für jede Datei des Anwendungsverzeichnisses wird der
//    Git-Blob-Hash berechnet: sha1("blob " + Bytelänge + "\0" + Inhalt). Das ist genau der Hash, den Git
//    und GitHub für eine Datei verwenden. Ausgenommen sind nur auf oberster Ebene node_modules/, .git/,
//    data/ sowie DATA_DIR, falls es innerhalb des Anwendungsverzeichnisses liegt, und überall
//    Umgebungsdateien (.env, .env.*). Ein verschachteltes node_modules gilt als zusätzliche Datei.
// 2. Gesamt-Fingerabdruck: sha256 über die byteweise sortierten Zeilen "pfad hash\n".
//    Nachrechnen: git -c core.quotePath=false ls-tree -r --format='%(path) %(objectname)' HEAD | LC_ALL=C sort | sha256sum
// 3. Abgleich mit GitHub (beim Start und danach alle 6 Stunden): Commit und Dateibaum des Tags v<version>.
//    Ergebnis identical / different / unverified (mit Grund). Das Ergebnis wird nur im Speicher gehalten.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pkg = require('./version');

const ROOT_DIR = path.resolve(__dirname, '..');
const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'anonyme-umfrage';
const TIMEOUT_MS = 10 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000; // nach vorübergehenden Fehlern (Netz, Abfragegrenze) früher erneut versuchen
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Einträge im Wurzelverzeichnis, die ausgelassen werden. Bewusst NUR auf oberster Ebene: Ein
 * verschachteltes node_modules (z. B. src/node_modules/pdfkit) würde Node vor /node_modules laden und
 * muss deshalb als zusätzliche Datei auffallen.
 */
const SKIP_TOP = new Set(['node_modules', '.git', 'data']);

/**
 * Umgebungsdateien (.env, .env.local …) enthalten Zugangsdaten und sind nicht versioniert
 * (.gitignore, .dockerignore). Sie werden nie gehasht und nie veröffentlicht. Node lädt sie nicht als
 * Code; Namen mit Code-Endungen (.env.js usw.) werden deshalb trotzdem geprüft.
 */
function isEnvFile(name) {
  return /^\.env(\..+)?$/.test(name) && !/\.(c|m)?js$|\.json$|\.node$/i.test(name);
}

const REASONS = Object.freeze({
  pending: 'Prüfung läuft',
  off: 'Prüfung abgeschaltet',
  local: 'Lokaler Fingerabdruck konnte nicht berechnet werden',
  repo: 'Ungültige REPO-Angabe',
  network: 'GitHub nicht erreichbar',
  timeout: 'GitHub nicht erreichbar (Zeitüberschreitung)',
  rateLimit: 'GitHub-Abfragegrenze erreicht, neuer Versuch später',
  invalid: 'Ungültige Antwort von GitHub',
  truncated: 'Antwort von GitHub unvollständig (zu viele Dateien)',
});

// ---------------------------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------------------------

/**
 * Git-Blob-Hash eines Inhalts (binärsicher, rohe Bytes).
 * @param {Buffer|string} content
 * @returns {string} 40 Hexzeichen
 */
function gitBlobHash(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  return hash.digest('hex');
}

/** Byteweiser Vergleich (wie `LC_ALL=C sort`). */
function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Gesamt-Fingerabdruck: sha256 über die sortierten Zeilen "pfad hash\n".
 * @param {Array<{path:string, hash:string}>} files
 * @returns {string} 64 Hexzeichen
 */
function totalFingerprint(files) {
  const lines = files.map((f) => `${f.path} ${f.hash}`).sort(compareBytes);
  const hash = crypto.createHash('sha256');
  for (const line of lines) hash.update(`${line}\n`, 'utf8');
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Lokaler Fingerabdruck
// ---------------------------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Ermittelt alle Dateien unterhalb von rootDir mit ihrem Git-Blob-Hash.
 * @param {string} rootDir
 * @param {object} [o]
 * @param {string[]} [o.exclude]  weitere auszulassende Pfade relativ zu rootDir (Schrägstriche), z. B. DATA_DIR
 * @returns {{files: Array<{path:string, hash:string}>, fingerprint:string}}
 */
function fingerprintFiles(rootDir, { exclude = [] } = {}) {
  const root = path.resolve(rootDir);
  const excluded = new Set(exclude.map((p) => String(p).replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, '')).filter(Boolean));
  const files = [];

  function walk(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (!relDir && SKIP_TOP.has(entry.name)) continue;
      if (!entry.isDirectory() && isEnvFile(entry.name)) continue;
      if (excluded.has(rel)) continue;
      if (entry.isSymbolicLink()) {
        // Git speichert symbolische Links als Blob mit dem Linkziel als Inhalt.
        files.push({ path: rel, hash: gitBlobHash(Buffer.from(fs.readlinkSync(abs).replace(/\\/g, '/'), 'utf8')) });
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, hash: gitBlobHash(fs.readFileSync(abs)) });
      }
      // Sockets, FIFOs usw. gibt es in Git nicht und werden ignoriert.
    }
  }

  walk(root, '');
  files.sort((a, b) => compareBytes(a.path, b.path));
  return { files, fingerprint: totalFingerprint(files) };
}

/** Pfad von DATA_DIR relativ zur Wurzel, falls er innerhalb liegt, sonst null. */
function relativeInside(rootDir, dir) {
  if (!dir) return null;
  const rel = path.relative(path.resolve(rootDir), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

class IntegrityError extends Error {
  constructor(reason, { transient = false } = {}) {
    super(reason);
    this.name = 'IntegrityError';
    this.reason = reason;
    this.transient = transient;
  }
}

async function getJson(fetchFn, url, tag) {
  let res;
  try {
    res = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new IntegrityError(timeout ? REASONS.timeout : REASONS.network, { transient: true });
  }
  const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
  if (res.status === 404 || res.status === 422) {
    throw new IntegrityError(`Tag ${tag} auf GitHub nicht gefunden`);
  }
  if (res.status === 409) {
    // GitHub meldet 409, solange das Repository noch keinen Commit hat.
    throw new IntegrityError(`Tag ${tag} auf GitHub nicht gefunden (Repository leer)`);
  }
  if (res.status === 429 || (res.status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after')))) {
    throw new IntegrityError(REASONS.rateLimit, { transient: true });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new IntegrityError(`GitHub antwortet mit Status ${res.status}`, { transient: res.status >= 500 || res.status === 403 });
  }
  try {
    return await res.json();
  } catch {
    throw new IntegrityError(REASONS.invalid, { transient: true });
  }
}

/**
 * Lädt Commit und Dateibaum des Tags von GitHub.
 * @param {object} o
 * @param {string} o.repo      "besitzer/name"
 * @param {string} o.tag       z. B. "v1.0.0"
 * @param {Function} [o.fetch] fetch-kompatible Funktion (Tests)
 * @returns {Promise<{commit:string, files:Array<{path:string, hash:string}>}>}
 */
async function fetchRemote({ repo, tag, fetch: fetchFn = globalThis.fetch }) {
  if (!REPO_PATTERN.test(String(repo || ''))) throw new IntegrityError(REASONS.repo);
  if (typeof fetchFn !== 'function') throw new IntegrityError(REASONS.network);
  const base = `${GITHUB_API}/repos/${repo}`;
  const ref = encodeURIComponent(tag);

  const commitData = await getJson(fetchFn, `${base}/commits/${ref}`, tag);
  const commit = commitData && typeof commitData.sha === 'string' ? commitData.sha : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new IntegrityError(REASONS.invalid);
  const treeSha = commitData.commit && commitData.commit.tree && commitData.commit.tree.sha;
  // Über den Tree-Hash des Commits ist der Baum eindeutig, auch bei annotierten Tags.
  const treeRef = typeof treeSha === 'string' && /^[0-9a-f]{40}$/.test(treeSha) ? treeSha : ref;

  const treeData = await getJson(fetchFn, `${base}/git/trees/${treeRef}?recursive=1`, tag);
  if (!treeData || !Array.isArray(treeData.tree)) throw new IntegrityError(REASONS.invalid);
  if (treeData.truncated) throw new IntegrityError(REASONS.truncated);

  const files = [];
  for (const entry of treeData.tree) {
    if (!entry || entry.type !== 'blob') continue; // Verzeichnisse und Submodule haben keinen Dateiinhalt
    if (typeof entry.path !== 'string' || !/^[0-9a-f]{40}$/.test(String(entry.sha))) throw new IntegrityError(REASONS.invalid);
    files.push({ path: entry.path, hash: entry.sha });
  }
  files.sort((a, b) => compareBytes(a.path, b.path));
  return { commit, files };
}

// ---------------------------------------------------------------------------------------------
// Vergleich
// ---------------------------------------------------------------------------------------------

/**
 * Vergleicht lokale Dateien mit dem Dateibaum des Tags.
 * @returns {{state:'identical'|'different', files:Array, summary:object, changed:string[], missing:string[], extra:string[]}}
 */
function compareFiles(localFiles, remoteFiles) {
  const local = new Map(localFiles.map((f) => [f.path, f.hash]));
  const remote = new Map(remoteFiles.map((f) => [f.path, f.hash]));
  const paths = [...new Set([...local.keys(), ...remote.keys()])].sort(compareBytes);
  const files = [];
  const changed = [];
  const missing = [];
  const extra = [];
  for (const p of paths) {
    const localHash = local.has(p) ? local.get(p) : null;
    const remoteHash = remote.has(p) ? remote.get(p) : null;
    let status;
    if (localHash === null) {
      status = 'missing';
      missing.push(p);
    } else if (remoteHash === null) {
      status = 'extra';
      extra.push(p);
    } else if (localHash === remoteHash) {
      status = 'identical';
    } else {
      status = 'different';
      changed.push(p);
    }
    files.push({ path: p, localHash, remoteHash, status });
  }
  const summary = {
    total: files.length,
    identical: files.length - changed.length - missing.length - extra.length,
    different: changed.length,
    missing: missing.length,
    extra: extra.length,
    unchecked: 0,
  };
  const state = changed.length || missing.length || extra.length ? 'different' : 'identical';
  return { state, files, summary, changed, missing, extra };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function differenceReason(summary) {
  const parts = [];
  if (summary.different) parts.push(`${plural(summary.different, 'Datei weicht', 'Dateien weichen')} ab`);
  if (summary.missing) parts.push(`${plural(summary.missing, 'Datei fehlt', 'Dateien fehlen')}`);
  if (summary.extra) parts.push(`${plural(summary.extra, 'zusätzliche Datei', 'zusätzliche Dateien')}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------------------------

/**
 * Text und Ton für einen Prüfstatus (Fuß, Transparenzseite, PDF).
 * @returns {{state:string, tone:'success'|'warn'|'error', badge:string, text:string}}
 */
function integrityLabel(status = getIntegrityStatus()) {
  const tag = status.tag || `v${status.version || pkg.version}`;
  if (status.state === 'identical') {
    return { state: 'identical', tone: 'success', badge: 'badge-success', text: `Code identisch mit GitHub-Version ${tag}` };
  }
  if (status.state === 'different') {
    return { state: 'different', tone: 'error', badge: 'badge-error', text: `Code weicht von GitHub-Version ${tag} ab` };
  }
  return { state: 'unverified', tone: 'warn', badge: 'badge-warn', text: `Code nicht geprüft: ${status.reason || 'unbekannt'}` };
}

function repoLinks(repo, tag, commit) {
  const valid = REPO_PATTERN.test(String(repo || ''));
  const repoUrl = valid ? `https://github.com/${repo}` : null;
  return {
    repoUrl,
    tagUrl: repoUrl ? `${repoUrl}/tree/${encodeURIComponent(tag)}` : null,
    commitUrl: repoUrl && commit ? `${repoUrl}/commit/${commit}` : null,
  };
}

function freezeStatus(status) {
  for (const f of status.files) Object.freeze(f);
  Object.freeze(status.files);
  Object.freeze(status.summary);
  return Object.freeze(status);
}

// ---------------------------------------------------------------------------------------------
// Prüfer
// ---------------------------------------------------------------------------------------------

/**
 * Erzeugt einen eigenständigen Prüfer (das Modul hat einen Standardprüfer für den Server).
 * @param {object} [o]
 * @param {string} [o.rootDir]     Anwendungsverzeichnis (Standard: Repo-Wurzel)
 * @param {string} [o.dataDir]     DATA_DIR; wird ausgelassen, wenn innerhalb von rootDir
 * @param {string} [o.repo]        GitHub-Repo "besitzer/name"
 * @param {boolean} [o.enabled]    false = kein GitHub-Abgleich ("Prüfung abgeschaltet")
 * @param {string} [o.version]     Version (Standard aus package.json)
 * @param {Function} [o.fetch]     fetch-kompatible Funktion (Tests)
 * @param {Function|null} [o.log]  Ausgabe einer Zeile pro Prüfergebnis, null = still
 * @param {number} [o.recheckMs]   Abstand der Wiederholung (Standard 6 h)
 * @param {number} [o.retryMs]     Abstand nach vorübergehenden Fehlern (Standard 30 min)
 */
function createChecker({
  rootDir = ROOT_DIR,
  dataDir = null,
  repo = 'havok2-htwo/AnonymeUmfrage',
  enabled = true,
  version = pkg.version,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  log = (line) => process.stdout.write(`${line}\n`),
  recheckMs = RECHECK_MS,
  retryMs = RETRY_MS,
} = {}) {
  const tag = `v${version}`;
  let local = null; // { files, fingerprint, computedAt }
  let localError = false;
  let status = null;
  let timer = null;
  let running = null;
  let stopped = false;

  function base(extra) {
    const links = repoLinks(repo, tag, extra.commit || null);
    const files = extra.files || (local ? local.files.map((f) => ({ path: f.path, localHash: f.hash, remoteHash: null, status: 'unchecked' })) : []);
    const summary = extra.summary || {
      total: files.length, identical: 0, different: 0, missing: 0, extra: 0, unchecked: files.length,
    };
    return freezeStatus({
      state: extra.state,
      reason: extra.reason,
      version,
      tag,
      repo,
      repoUrl: links.repoUrl,
      tagUrl: links.tagUrl,
      commit: extra.commit || null,
      commitUrl: links.commitUrl,
      checkedAt: extra.checkedAt || null,
      localComputedAt: local ? local.computedAt : null,
      fingerprint: local ? local.fingerprint : null,
      remoteFingerprint: extra.remoteFingerprint || null,
      files,
      summary,
      changed: extra.changed || [],
      missing: extra.missing || [],
      extra: extra.extra || [],
      checking: Boolean(extra.checking),
      enabled,
    });
  }

  function computeLocal() {
    try {
      const exclude = [];
      const relData = relativeInside(rootDir, dataDir);
      if (relData) exclude.push(relData);
      const result = fingerprintFiles(rootDir, { exclude });
      local = { ...result, computedAt: new Date().toISOString() };
      localError = false;
    } catch {
      local = null;
      localError = true;
    }
    if (localError) status = base({ state: 'unverified', reason: REASONS.local });
    else if (!enabled) status = base({ state: 'unverified', reason: REASONS.off, checkedAt: local.computedAt });
    else status = base({ state: 'unverified', reason: REASONS.pending, checking: true });
    return status;
  }

  function schedule(ms) {
    if (stopped || !enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      check().catch(() => {});
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function runCheck() {
    if (!local && !localError) computeLocal();
    if (localError) return status;
    if (!enabled) return status;
    const checkedAt = () => new Date().toISOString();
    let next = recheckMs;
    try {
      const remote = await fetchRemote({ repo, tag, fetch: fetchFn });
      const cmp = compareFiles(local.files, remote.files);
      status = base({
        state: cmp.state,
        reason: cmp.state === 'identical'
          ? `Alle ${plural(cmp.summary.total, 'Datei stimmt', 'Dateien stimmen')} mit ${tag} überein`
          : differenceReason(cmp.summary),
        commit: remote.commit,
        checkedAt: checkedAt(),
        remoteFingerprint: totalFingerprint(remote.files),
        files: cmp.files,
        summary: cmp.summary,
        changed: cmp.changed,
        missing: cmp.missing,
        extra: cmp.extra,
      });
    } catch (err) {
      const reason = err instanceof IntegrityError ? err.reason : REASONS.network;
      if (err instanceof IntegrityError && err.transient) next = Math.min(retryMs, recheckMs);
      status = base({ state: 'unverified', reason, checkedAt: checkedAt() });
    }
    if (log) {
      try {
        log(`Integritätsprüfung: ${integrityLabel(status).text}`);
      } catch {
        // Ausgabe ist nicht wichtig genug, um die Prüfung scheitern zu lassen.
      }
    }
    schedule(next);
    return status;
  }

  /** Startet sofort einen Abgleich (oder hängt sich an einen laufenden an). */
  function check() {
    if (!running) {
      running = runCheck().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    /** Berechnet den lokalen Fingerabdruck und startet den ersten Abgleich. Gibt dessen Promise zurück. */
    start() {
      stopped = false;
      computeLocal();
      if (!enabled || localError) return Promise.resolve(status);
      return check();
    },
    check,
    computeLocal,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    getStatus() {
      if (!status) {
        return base({ state: 'unverified', reason: enabled ? REASONS.pending : REASONS.off, checking: enabled });
      }
      return status;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Standardprüfer des Servers
// ---------------------------------------------------------------------------------------------

let current = null;

/**
 * Aktueller Prüfstatus (immer synchron, Ergebnis aus dem Speicher).
 * @returns {{state:'identical'|'different'|'unverified', reason:string, version:string, tag:string,
 *   repo:string, repoUrl:string|null, tagUrl:string|null, commit:string|null, commitUrl:string|null,
 *   checkedAt:string|null, localComputedAt:string|null, fingerprint:string|null, remoteFingerprint:string|null,
 *   files:Array<{path:string, localHash:string|null, remoteHash:string|null,
 *     status:'identical'|'different'|'missing'|'extra'|'unchecked'}>,
 *   summary:{total:number, identical:number, different:number, missing:number, extra:number, unchecked:number},
 *   changed:string[], missing:string[], extra:string[], checking:boolean, enabled:boolean}}
 */
function getIntegrityStatus() {
  if (!current) {
    return freezeStatus({
      state: 'unverified',
      reason: REASONS.pending,
      version: pkg.version,
      tag: pkg.tag,
      repo: null,
      repoUrl: null,
      tagUrl: null,
      commit: null,
      commitUrl: null,
      checkedAt: null,
      localComputedAt: null,
      fingerprint: null,
      remoteFingerprint: null,
      files: [],
      summary: { total: 0, identical: 0, different: 0, missing: 0, extra: 0, unchecked: 0 },
      changed: [],
      missing: [],
      extra: [],
      checking: true,
      enabled: true,
    });
  }
  return current.getStatus();
}

/**
 * Startet die Prüfung für den Server: lokaler Fingerabdruck sofort, GitHub-Abgleich im Hintergrund,
 * danach alle 6 Stunden. Ein erneuter Aufruf ersetzt den bisherigen Prüfer.
 * @param {object} config  Ergebnis von loadConfig()
 * @param {object} [options]  { fetch, log } für Tests
 * @returns {Promise<object>} Status nach dem ersten Abgleich (muss nicht abgewartet werden)
 */
function start(config = {}, options = {}) {
  stop();
  current = createChecker({
    rootDir: config.rootDir || ROOT_DIR,
    dataDir: config.dataDir || null,
    repo: config.repo || 'havok2-htwo/AnonymeUmfrage',
    enabled: config.integrityCheck !== false,
    ...options,
  });
  const promise = current.start();
  promise.catch(() => {});
  return promise;
}

/** Beendet den Zeitgeber der Wiederholungsprüfung. */
function stop() {
  if (current) current.stop();
}

/** Startet sofort einen neuen Abgleich des Standardprüfers. */
function checkNow() {
  return current ? current.check() : Promise.resolve(getIntegrityStatus());
}

module.exports = {
  getIntegrityStatus,
  start,
  stop,
  checkNow,
  integrityLabel,
  createChecker,
  gitBlobHash,
  totalFingerprint,
  fingerprintFiles,
  fetchRemote,
  compareFiles,
  IntegrityError,
  REASONS,
  ROOT_DIR,
};
