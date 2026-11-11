'use strict';

// Prüft vor einem Release (SPEC §6):
//  1. Git ist verfügbar und dies ist ein Repository mit mindestens einem Commit.
//  2. Das Arbeitsverzeichnis ist sauber (keine Änderungen, keine unversionierten Dateien).
//  3. Die Version in package.json ist gültig und stimmt mit package-lock.json überein.
//  4. Der Tag v<version> existiert lokal und zeigt auf HEAD.
//  5. Optional (--remote): Der Tag ist auch auf origin vorhanden und zeigt auf denselben Commit.
// Danach werden die nächsten Schritte ausgegeben.
//
// Exit-Codes: 0 = bereit (bzw. veröffentlicht), 1 = Probleme gefunden, 2 = Git nicht verfügbar / kein Repository.
//
// Aufruf: npm run release:check            (lokal)
//         npm run release:check -- --remote (zusätzlich origin abfragen)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const checkRemote = args.has('--remote');

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(gitArgs) {
  try {
    return git(gitArgs);
  } catch {
    return null;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

const ok = [];
const problems = [];
const steps = [];

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

// --- Version ---------------------------------------------------------------------------------

let version = '';
try {
  version = String(readJson('package.json').version || '');
} catch {
  problems.push('package.json konnte nicht gelesen werden.');
}
const tag = `v${version}`;
if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  problems.push(`Version „${version}“ in package.json ist keine gültige Versionsnummer (x.y.z).`);
} else if (version) {
  ok.push(`Version in package.json: ${version}`);
}

try {
  const lock = readJson('package-lock.json');
  const lockVersion = lock.version || (lock.packages && lock.packages[''] && lock.packages[''].version);
  if (lockVersion !== version) {
    problems.push(`package-lock.json hat Version ${lockVersion || '(keine)'} statt ${version}. Beheben mit: npm install --package-lock-only`);
    steps.push('npm install --package-lock-only');
  } else {
    ok.push('package-lock.json passt zur Version');
  }
} catch {
  problems.push('package-lock.json fehlt oder ist ungültig. Anlegen mit: npm install');
}

// --- Git -------------------------------------------------------------------------------------

if (tryGit(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  process.stderr.write('Git ist nicht verfügbar oder dies ist kein Git-Repository.\n');
  process.exit(2);
}

const head = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

if (!head) {
  problems.push('Es gibt noch keinen Commit.');
  steps.push('git add -A && git commit -m "…"');
}

const dirty = tryGit(['status', '--porcelain', '--untracked-files=all']);
if (dirty === null) {
  problems.push('git status ist fehlgeschlagen.');
} else if (dirty) {
  const lines = dirty.split('\n');
  const shown = lines.slice(0, 20).map((l) => `    ${l}`).join('\n');
  const more = lines.length > 20 ? `\n    … und ${lines.length - 20} weitere` : '';
  problems.push(`Arbeitsverzeichnis ist nicht sauber (${lines.length} Einträge):\n${shown}${more}`);
  if (!steps.length) steps.push('Änderungen committen: git add -A && git commit -m "…"');
} else {
  ok.push('Arbeitsverzeichnis sauber');
}

let tagCommit = null;
if (version && head) {
  tagCommit = tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (!tagCommit) {
    problems.push(`Tag ${tag} existiert lokal nicht.`);
    if (!dirty) steps.push(`git tag -a ${tag} -m "Version ${version}"`);
  } else if (tagCommit !== head) {
    problems.push(`Tag ${tag} zeigt auf ${tagCommit.slice(0, 7)}, HEAD ist ${head.slice(0, 7)}. Version erhöhen oder Tag prüfen.`);
  } else {
    ok.push(`Tag ${tag} zeigt auf HEAD (${head.slice(0, 7)})`);
  }
}

let remoteOk = null;
if (checkRemote && version && tagCommit) {
  const remote = tryGit(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (remote === null) {
    problems.push('origin ist nicht erreichbar (git ls-remote fehlgeschlagen).');
  } else {
    const refs = new Map(remote.split('\n').filter(Boolean).map((l) => {
      const [sha, ref] = l.split(/\s+/);
      return [ref, sha];
    }));
    const remoteCommit = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`);
    if (!remoteCommit) {
      remoteOk = false;
      ok.push(`Tag ${tag} ist noch nicht auf origin`);
    } else if (remoteCommit !== tagCommit) {
      problems.push(`Tag ${tag} auf origin zeigt auf ${remoteCommit.slice(0, 7)} statt ${tagCommit.slice(0, 7)}.`);
    } else {
      remoteOk = true;
      ok.push(`Tag ${tag} ist auf origin veröffentlicht`);
    }
  }
}

// --- Ausgabe ---------------------------------------------------------------------------------

out(`Release-Prüfung für Version ${version || '?'} (Tag ${tag})`);
for (const line of ok) out(`  ok       ${line}`);
for (const line of problems) out(`  Problem  ${line}`);
out();

if (problems.length === 0) {
  if (remoteOk) {
    out('Alles veröffentlicht. Installationen mit dieser Version zeigen nach dem nächsten Abgleich „Code identisch“.');
  } else {
    out('Bereit zum Veröffentlichen. Nächste Schritte:');
    out(`  git push origin ${branch}`);
    out(`  git push origin ${tag}`);
    out('Danach baut GitHub Actions die Tests und prüft, dass Tag und Version zusammenpassen.');
  }
  process.exitCode = 0;
} else {
  const allSteps = [...steps];
  if (!allSteps.some((s) => s.startsWith('git tag')) && !tagCommit && version) {
    allSteps.push(`git tag -a ${tag} -m "Version ${version}"`);
  }
  allSteps.push('npm run release:check');
  out('Nicht bereit. Nächste Schritte:');
  for (const s of allSteps) out(`  ${s}`);
  out(`Ablauf: Version in package.json erhöhen (npm version x.y.z --no-git-tag-version), committen, Tag ${tag}`);
  out('anlegen, dann Branch und Tag pushen.');
  process.exitCode = 1;
}
