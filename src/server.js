'use strict';

// Einstieg: Konfiguration laden, Datenbank öffnen, ersten Admin anlegen, Integritätsprüfung starten,
// Routen registrieren, HTTP starten. Es gibt bewusst kein Access-Log.

const http = require('node:http');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { vacuumSafely } = require('./surveys');
const auth = require('./auth');
const integrity = require('./integrity');
const { version } = require('./version');
const { createRouter } = require('./http/router');
const { createStatic } = require('./http/static');
const { setSecurityHeaders } = require('./http/security');
const { parseUrlEncoded } = require('./http/body');
const { HttpError } = require('./http/respond');
const { handleError, logError } = require('./http/errors');
const { createContext, registerRoutes } = require('./routes');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function bootstrapAdmin(db, config) {
  if (!config.adminUser || !config.adminPassword) return false;
  if (auth.countAdmins(db) > 0) return false;
  await auth.createAdmin(db, { username: config.adminUser, displayName: config.adminUser, password: config.adminPassword });
  return true;
}

function createRequestHandler({ router, ctx, serveStatic }) {
  return async function onRequest(req, res) {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      req.path = url.pathname;
      req.query = parseUrlEncoded(url.search.slice(1));
    } catch {
      req.path = '/';
      req.query = Object.create(null);
      handleError(new HttpError(400), req, res);
      return;
    }
    try {
      const result = await router.handle(req, res, ctx);
      if (result.matched) {
        if (!res.writableEnded && !res.headersSent) throw new Error('Handler hat keine Antwort gesendet.');
        return;
      }
      if (result.allowed.length > 0) {
        res.setHeader('Allow', result.allowed.join(', '));
        throw new HttpError(405);
      }
      if (serveStatic(req, res)) return;
      throw new HttpError(404);
    } catch (err) {
      handleError(err, req, res);
    }
  };
}

/**
 * Baut die Anwendung und startet (standardmäßig) den HTTP-Server.
 * @param {object} [o]
 * @param {object} [o.config]   Ergebnis von loadConfig(); Standard: loadConfig(process.env)
 * @param {boolean} [o.listen]  false = Server nicht starten (Standard true; Port aus config.port, 0 = frei)
 * @returns {Promise<{server, db, ctx, config, port:number|null, url:string|null, close:() => Promise<void>}>}
 */
async function createApp({ config = loadConfig(), listen = true } = {}) {
  const db = openDatabase(config.dbPath);
  // Ein VACUUM, das vor dem letzten Beenden fehlgeschlagen ist, nachholen (SPEC §3 Regel 13).
  vacuumSafely(db);
  if (await bootstrapAdmin(db, config)) process.stdout.write('Erster Admin aus ADMIN_USER angelegt.\n');
  auth.cleanupSessions(db);

  integrity.start(config);

  const ctx = createContext({ database: db, config });
  const router = createRouter();
  registerRoutes(router, ctx);
  const serveStatic = createStatic(config.publicDir);

  const server = http.createServer(createRequestHandler({ router, ctx, serveStatic }));
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 60 * 1000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const cleanupTimer = setInterval(() => {
    try {
      auth.cleanupSessions(db);
    } catch (err) {
      logError(err);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  const app = {
    server, db, ctx, config, port: null, url: null,
    async close() {
      clearInterval(cleanupTimer);
      integrity.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };

  if (listen) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    app.port = addr.port;
    const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    app.url = `http://${host.includes(':') ? `[${host}]` : host}:${addr.port}`;
  }
  return app;
}

async function main() {
  const config = loadConfig();
  const app = await createApp({ config });
  process.stdout.write(`Anonyme Umfrage ${version} läuft auf ${app.url}\n`);
  if (auth.countAdmins(app.db) === 0) {
    process.stdout.write('Noch kein Admin vorhanden. Anlegen mit: node src/cli.js create-admin <benutzername>\n');
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Start fehlgeschlagen: ${err.userMessage || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { createApp };
