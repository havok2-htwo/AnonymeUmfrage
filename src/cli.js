'use strict';

// Kommandozeile für die Adminverwaltung.
//
//   node src/cli.js create-admin <benutzername> [anzeigename]
//   node src/cli.js set-password <benutzername>
//
// Das Passwort kommt aus der Umgebungsvariable ADMIN_PASSWORD oder wird ohne Echo abgefragt.

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const auth = require('./auth');

function usage() {
  process.stdout.write([
    'Verwendung:',
    '  node src/cli.js create-admin <benutzername> [anzeigename]',
    '  node src/cli.js set-password <benutzername>',
    '',
    'Das Passwort wird aus ADMIN_PASSWORD gelesen oder abgefragt.',
    '',
  ].join('\n'));
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('Keine Konsole für die Passworteingabe. ADMIN_PASSWORD setzen.'));
      return;
    }
    process.stdout.write(question);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const first = await promptHidden('Passwort: ');
  const second = await promptHidden('Passwort wiederholen: ');
  if (first !== second) throw new auth.AuthError('Die Passwörter stimmen nicht überein.');
  return first;
}

async function main(argv) {
  const [command, username, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || !username) {
    usage();
    return command && command !== 'help' && command !== '--help' ? 1 : 0;
  }
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    if (command === 'create-admin') {
      const password = await readPassword();
      const id = await auth.createAdmin(db, { username, displayName: rest.join(' '), password });
      process.stdout.write(`Admin „${username}“ angelegt (ID ${id}).\n`);
      return 0;
    }
    if (command === 'set-password') {
      const admin = auth.getAdminByUsername(db, username);
      if (!admin) throw new auth.AuthError(`Admin „${username}“ nicht gefunden.`);
      const password = await readPassword();
      await auth.setPassword(db, admin.id, password);
      process.stdout.write(`Passwort für „${admin.username}“ gesetzt. Alle Sitzungen wurden beendet.\n`);
      return 0;
    }
    usage();
    return 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`Fehler: ${err.userMessage || err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
