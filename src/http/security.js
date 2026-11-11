'use strict';

// Sicherheitsheader für jede Antwort (SPEC §3 Regel 8).

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
}

module.exports = { setSecurityHeaders, SECURITY_HEADERS: HEADERS, CSP };
