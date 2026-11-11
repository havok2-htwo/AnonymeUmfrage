'use strict';

// Kleiner Router: Methode + Pfadmuster mit :parametern.
//
//   const router = createRouter();
//   router.get('/u/:slug', async (req, res, ctx) => { req.params.slug … });
//   router.post('/admin/surveys/:id/questions/:qid/delete', handler);
//
// router.handle(req, res, ctx) liefert:
//   { matched: true }                       Handler wurde ausgeführt
//   { matched: false, allowed: [] }         kein Pfad passt   → 404
//   { matched: false, allowed: ['GET'] }    Pfad passt, Methode nicht → 405
// HEAD wird automatisch wie GET behandelt.

function compile(pattern) {
  if (!pattern.startsWith('/')) throw new Error(`Pfadmuster muss mit / beginnen: ${pattern}`);
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    if (typeof handler !== 'function') throw new Error(`Handler fehlt für ${method} ${pattern}`);
    const { regex, names } = compile(pattern);
    routes.push({ method: method.toUpperCase(), pattern, regex, names, handler });
    return router;
  }

  function match(method, pathname) {
    const allowed = new Set();
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      allowed.add(route.method);
      if (route.method === 'GET') allowed.add('HEAD');
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        const params = {};
        route.names.forEach((name, i) => {
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch {
            params[name] = m[i + 1];
          }
        });
        return { route, params };
      }
    }
    return { route: null, allowed: [...allowed] };
  }

  async function handle(req, res, ctx) {
    const found = match(req.method, req.path);
    if (!found.route) return { matched: false, allowed: found.allowed };
    req.params = found.params;
    await found.route.handler(req, res, ctx);
    return { matched: true };
  }

  const router = {
    add,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    match,
    handle,
    routes,
  };
  return router;
}

module.exports = { createRouter };
