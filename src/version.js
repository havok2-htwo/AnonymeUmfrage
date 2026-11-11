'use strict';

// Liest Name und Version aus package.json. Die Version muss zum Git-Tag v<version> passen (SPEC §6).

const path = require('node:path');
const fs = require('node:fs');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

module.exports = {
  name: pkg.name,
  version: pkg.version,
  tag: `v${pkg.version}`,
};
