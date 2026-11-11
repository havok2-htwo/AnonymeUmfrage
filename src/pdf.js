'use strict';

// PDF-Export der Auswertung (SPEC §7 „PDF“) mit pdfkit.
//
// A4, Ränder 50 pt, Montserrat aus assets/fonts. Kopf mit Titel (900), Einleitung und Kennzahlen,
// danach pro Frage ein Abschnitt: Balkendiagramme (Mango auf hellem Raster) bzw. Freitexte als Absätze
// mit dünner linker Mango-Linie. Überschriften stehen nie allein am Seitenende. Fußzeile auf jeder Seite:
// „<Titel> · Seite x von y · Version … · <Prüfstatus>“.
//
// Das PDF enthält keine personenbezogenen Daten: keine Namen von Admins, keine Zeitstempel von
// Antworten, Freitexte gemischt (das Mischen passiert bereits in src/results.js).

const path = require('node:path');
const PDFDocument = require('pdfkit');
const { version: appVersion } = require('./version');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONTS = {
  regular: 'Montserrat-Regular.ttf',
  semibold: 'Montserrat-SemiBold.ttf',
  bold: 'Montserrat-Bold.ttf',
  black: 'Montserrat-Black.ttf',
};

// Druckfarben (SONS CI): Text Petrol auf Weiß, Balken Mango, Raster hell.
const COLOR = {
  text: '#0D2734',
  muted: '#53646F',
  mango: '#F79F3E',
  grid: '#D7DDE3',
  track: '#EEF1F4',
};

const MARGIN = 50;
const NUMBER_COL = 24; // Einzug für die Fragennummer
const SEP = ' · ';
const DASH = String.fromCharCode(0x2013); // Halbgeviertstrich „–“
const ELLIPSIS = String.fromCharCode(0x2026); // „…“

const TZ = 'Europe/Berlin';
const dateFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function formatDate(value, withTime = false) {
  if (value === null || value === undefined || value === '') return '';
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return (withTime ? dateTimeFmt : dateFmt).format(d);
}

/** Zeitraum „geöffnet – geschlossen“ als Datum, fehlende Werte als „–“. */
function periodText(openedAt, closedAt) {
  const a = formatDate(openedAt) || DASH;
  const b = formatDate(closedAt) || DASH;
  return `${a} ${DASH} ${b}`;
}

/** Text des aktuellen Prüfstatus, wie im Seitenfuß (src/integrity.js). */
function currentIntegrityText() {
  const { getIntegrityStatus, integrityLabel } = require('./integrity');
  return integrityLabel(getIntegrityStatus()).text;
}

// ---------------------------------------------------------------------------------------------------
// Dateiname
// ---------------------------------------------------------------------------------------------------

const TRANSLIT = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue', 'ẞ': 'ss' };

/** Slug aus Buchstaben und Ziffern (Unicode), Trenner „-“, höchstens 60 Zeichen. */
function slugify(title, ascii = false) {
  let s = String(title ?? '').normalize('NFC');
  if (ascii) {
    s = s.replace(/[äöüßÄÖÜẞ]/g, (ch) => TRANSLIT[ch]).normalize('NFKD').replace(/\p{M}/gu, '');
    s = s.replace(/[^A-Za-z0-9]+/g, '-');
  } else {
    s = s.replace(/[^\p{L}\p{N}]+/gu, '-');
  }
  s = s.toLowerCase().replace(/^-+|-+$/g, '');
  if (s.length > 60) s = Array.from(s).slice(0, 60).join('').replace(/-+$/g, '');
  return s;
}

/** Dateiname umfrage-<slug>-ergebnis.pdf; { ascii, utf8 }. */
function pdfFilename(title) {
  const make = (slug) => (slug ? `umfrage-${slug}-ergebnis.pdf` : 'umfrage-ergebnis.pdf');
  return { ascii: make(slugify(title, true)), utf8: make(slugify(title, false)) };
}

/** Content-Disposition mit ASCII-Rückfall und filename* (RFC 5987, UTF-8). */
function contentDisposition(title) {
  const { ascii, utf8 } = pdfFilename(title);
  const encoded = encodeURIComponent(utf8).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------------

/**
 * Erzeugt das Ergebnis-PDF.
 * @param {ReturnType<import('./results').buildResults>} results
 * @param {object} [opts]
 * @param {string} [opts.version]        Standard: package.json
 * @param {string} [opts.integrityText]  Standard: aktueller Prüfstatus
 * @param {Date}   [opts.generatedAt]    Standard: jetzt
 * @returns {Promise<Buffer>}
 */
function renderResultsPdf(results, opts = {}) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true,
        autoFirstPage: true,
        info: {
          Title: results.survey.title || 'Umfrage',
          Subject: 'Ergebnis der Umfrage',
          Creator: 'Anonyme Umfrage',
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      new Writer(doc, results, {
        version: opts.version || appVersion,
        integrityText: opts.integrityText || currentIntegrityText(),
        generatedAt: opts.generatedAt || new Date(),
      }).write();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

class Writer {
  constructor(doc, results, meta) {
    this.doc = doc;
    this.results = results;
    this.meta = meta;
    for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, path.join(FONT_DIR, file));
    doc.font('regular');
    // Zeichen, die Montserrat nicht enthält (z. B. Emoji), werden weggelassen statt als leere Kästchen.
    const fk = doc._font && doc._font.font;
    this.hasGlyph = fk && typeof fk.hasGlyphForCodePoint === 'function'
      ? (cp) => fk.hasGlyphForCodePoint(cp)
      : (cp) => cp < 0x2000;
    this.glyphCache = new Map();
  }

  get left() { return this.doc.page.margins.left; }

  get width() { return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right; }

  get bottom() { return this.doc.page.height - this.doc.page.margins.bottom; }

  get pageIndex() {
    const r = this.doc.bufferedPageRange();
    return r.start + r.count - 1;
  }

  /** Text für die Schrift aufbereiten: NFC, Steuerzeichen raus (außer Zeilenumbruch), fehlende Glyphen raus. */
  clean(text) {
    const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').normalize('NFC');
    let out = '';
    for (const ch of s) {
      if (ch === '\n') { out += ch; continue; }
      const cp = ch.codePointAt(0);
      if (/\p{Cc}|\p{Cf}/u.test(ch)) continue;
      let ok = this.glyphCache.get(cp);
      if (ok === undefined) {
        ok = cp === 0x20 || this.hasGlyph(cp);
        this.glyphCache.set(cp, ok);
      }
      if (ok) out += ch;
    }
    return out.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  style(font, size, color = COLOR.text) {
    this.doc.font(font).fontSize(size).fillColor(color);
    return this;
  }

  /** Neue Seite, wenn weniger als h Punkte Platz sind. */
  ensureSpace(h) {
    if (this.doc.y + h > this.bottom) this.doc.addPage();
  }

  textHeight(text, font, size, width, extra = {}) {
    this.doc.font(font).fontSize(size);
    return this.doc.heightOfString(text, { width, lineGap: extra.lineGap || 0 });
  }

  lineHeight(font, size, lineGap = 0) {
    this.doc.font(font).fontSize(size);
    return this.doc.currentLineHeight(true) + lineGap;
  }

  write() {
    this.header();
    for (const q of this.results.questions) this.question(q);
    this.footers();
  }

  // ----- Kopf ---------------------------------------------------------------------------------------

  header() {
    const { doc } = this;
    const { survey, total, questions } = this.results;
    const x = this.left;
    const w = this.width;

    doc.save().rect(x, MARGIN, 48, 4).fill(COLOR.mango).restore();
    doc.y = MARGIN + 16;

    this.style('bold', 9, COLOR.mango);
    doc.text('Ergebnis der Umfrage', x, doc.y, { width: w });
    doc.moveDown(0.3);

    this.style('black', 24, COLOR.text);
    doc.text(this.clean(survey.title) || 'Umfrage', x, doc.y, { width: w, lineGap: 1 });
    doc.moveDown(0.5);

    const intro = this.clean(survey.intro);
    if (intro) {
      this.style('regular', 10, COLOR.text);
      for (const para of intro.split(/\n\s*\n/)) {
        doc.text(para.trim(), x, doc.y, { width: w, lineGap: 2 });
        doc.moveDown(0.5);
      }
    }
    doc.moveDown(0.4);

    // Kennzahlen
    const cells = [
      { label: 'Teilnahmen', value: String(total), share: 0.25 },
      { label: 'Zeitraum (geöffnet – geschlossen)', value: periodText(survey.openedAt, survey.closedAt), share: 0.5 },
      { label: 'Fragen', value: String(questions.length), share: 0.25 },
    ];
    const cellH = 54;
    this.ensureSpace(cellH + 40);
    const top = doc.y;
    let cx = x;
    const gap = 8;
    const usable = w - gap * (cells.length - 1);
    for (const cell of cells) {
      const cw = usable * cell.share;
      doc.save().lineWidth(0.75).strokeColor(COLOR.grid).rect(cx, top, cw, cellH).stroke().restore();
      let size = 18;
      doc.font('black');
      while (size > 9 && doc.fontSize(size).widthOfString(cell.value) > cw - 20) size -= 1;
      this.style('black', size, COLOR.text);
      doc.text(cell.value, cx + 10, top + 10, { width: cw - 20, lineBreak: false });
      this.style('regular', 8, COLOR.muted);
      doc.text(cell.label, cx + 10, top + 34, { width: cw - 20, lineBreak: false, ellipsis: true });
      cx += cw + gap;
    }
    doc.x = x;
    doc.y = top + cellH + 10;

    this.style('regular', 8.5, COLOR.muted);
    doc.text(`Version ${this.meta.version}${SEP}${this.clean(this.meta.integrityText)}`, x, doc.y, { width: w });
    doc.text(`Erstellt am ${formatDate(this.meta.generatedAt, true)} Uhr`, x, doc.y, { width: w });
    doc.text('Antworten sind pro Frage getrennt gespeichert. Freitexte erscheinen in zufälliger Reihenfolge.',
      x, doc.y, { width: w });
    doc.moveDown(1.6);
  }

  // ----- Fragen -------------------------------------------------------------------------------------

  question(q) {
    const { doc } = this;
    const x = this.left;
    const w = this.width;
    const bx = x + NUMBER_COL;
    const bw = w - NUMBER_COL;

    const title = this.clean(q.title) || `Frage ${q.number}`;
    const help = this.clean(q.help);
    const range = q.suppressed ? q.range : q.scale;
    const typeText = q.kind === 'scale' && range ? `Skala ${range.min}${DASH}${range.max}` : q.typeLabel;
    const meta = [q.answeredText, typeText].join(SEP);

    // Überschrift + Hinweis + Metazeile + erster Inhalt müssen zusammen auf die Seite passen.
    const titleH = this.textHeight(title, 'bold', 12.5, bw, { lineGap: 1 });
    const helpH = help ? this.textHeight(help, 'regular', 9, bw, { lineGap: 1 }) + 3 : 0;
    const metaH = this.lineHeight('regular', 9) + 8;
    const firstH = this.firstBlockHeight(q, bw);
    const needed = titleH + 4 + helpH + metaH + firstH;
    if (needed <= this.bottom - this.doc.page.margins.top) this.ensureSpace(needed);
    else this.ensureSpace(titleH + helpH + metaH + 40);

    const top = doc.y;
    this.style('black', 12.5, COLOR.mango);
    doc.text(`${q.number}`, x, top, { width: NUMBER_COL - 4, lineBreak: false });
    this.style('bold', 12.5, COLOR.text);
    doc.text(title, bx, top, { width: bw, lineGap: 1 });
    doc.y += 4;
    if (help) {
      this.style('regular', 9, COLOR.muted);
      doc.text(help, bx, doc.y, { width: bw, lineGap: 1 });
      doc.y += 3;
    }
    this.style('regular', 9, COLOR.muted);
    doc.text(meta, bx, doc.y, { width: bw });
    doc.y += 8;

    if (q.suppressed) this.suppressedBlock(q, bx, bw);
    else if (q.kind === 'scale') this.scaleBlock(q, bx, bw);
    else if (q.kind === 'choice') this.choiceBlock(q, bx, bw);
    else this.textBlock(q, bx, bw);

    doc.x = x;
    doc.y += 20;
  }

  firstBlockHeight(q, bw) {
    if (q.suppressed) return this.textHeight(this.clean(q.suppressedText), 'regular', 9.5, bw) + 4;
    // Skalen bleiben als Ganzes zusammen (höchstens 11 Zeilen plus Legende).
    if (q.kind === 'scale') return this.scaleBlockHeight(q, bw);
    if (q.kind === 'choice') {
      const first = q.choice.options[0];
      return first ? this.barRowHeight(this.clean(first.label), bw) : 16;
    }
    if (!q.answers.length) return 16;
    const first = this.clean(q.answers[0]);
    const h = this.textHeight(first, 'regular', 10, bw - 12, { lineGap: 2 });
    return Math.min(h, this.lineHeight('regular', 10, 2) * 3) + 4;
  }

  barGeometry(bx, bw) {
    const labelW = Math.round(bw * 0.36);
    const valueW = 78;
    const trackX = bx + labelW + 10;
    const trackW = bw - labelW - 10 - valueW - 8;
    return { labelW, valueW, trackX, trackW, valueX: trackX + trackW + 8 };
  }

  barRowHeight(label, bw) {
    const { labelW } = this.barGeometry(0, bw);
    return Math.max(this.textHeight(label || ' ', 'semibold', 9.5, labelW), 12) + 7;
  }

  /** Waagerechtes Balkendiagramm. rows: [{ label, count, percent, percentText }] */
  bars(rows, bx, bw) {
    const { doc } = this;
    const g = this.barGeometry(bx, bw);
    const barH = 10;
    for (const row of rows) {
      const label = this.clean(row.label) || DASH;
      const rowH = this.barRowHeight(label, bw);
      this.ensureSpace(rowH);
      const y = doc.y;
      this.style('semibold', 9.5, COLOR.text);
      doc.text(label, bx, y, { width: g.labelW });

      const by = y + 1;
      doc.save();
      doc.rect(g.trackX, by, g.trackW, barH).fill(COLOR.track);
      doc.lineWidth(0.5).strokeColor(COLOR.grid);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const lx = g.trackX + g.trackW * f;
        doc.moveTo(lx, by - 1.5).lineTo(lx, by + barH + 1.5).stroke();
      }
      const fillW = Math.max(0, Math.min(1, (Number(row.percent) || 0) / 100)) * g.trackW;
      if (fillW > 0) doc.rect(g.trackX, by, Math.max(fillW, 1), barH).fill(COLOR.mango);
      doc.restore();

      this.style('semibold', 9, COLOR.text);
      doc.text(`${row.count}${SEP}${this.clean(row.percentText)}`, g.valueX, y + 0.5,
        { width: g.valueW, align: 'right', lineBreak: false });
      doc.x = bx;
      doc.y = y + rowH;
    }
  }

  /** Legende der Skalenenden, z. B. „1 = gar nicht · 10 = voll und ganz“ (leer, wenn keine Labels). */
  scaleLegend(s) {
    const labels = [];
    if (s.minLabel) labels.push(`${s.min} = ${this.clean(s.minLabel)}`);
    if (s.maxLabel) labels.push(`${s.max} = ${this.clean(s.maxLabel)}`);
    return labels.join(SEP);
  }

  /** Höhe des ganzen Skalenblocks: Kennzahlen, Legende und alle Balkenzeilen. */
  scaleBlockHeight(q, bw) {
    const s = q.scale;
    const legend = this.scaleLegend(s);
    const legendH = legend ? this.textHeight(legend, 'regular', 8.5, bw) + 4 : 0;
    let rows = 0;
    for (const row of s.distribution) rows += this.barRowHeight(this.clean(row.label) || DASH, bw);
    return this.textHeight(`Durchschnitt ${s.meanText}${SEP}Median ${s.medianText}`, 'semibold', 10, bw) + 6 + legendH + rows;
  }

  scaleBlock(q, bx, bw) {
    const { doc } = this;
    const s = q.scale;
    // Den ganzen Block zusammenhalten, wenn er auf eine Seite passt (question() hat das in der Regel
    // schon erledigt). Die Legende steht direkt unter den Kennzahlen und damit immer beim Diagramm.
    const blockH = this.scaleBlockHeight(q, bw);
    if (blockH <= this.bottom - doc.page.margins.top) this.ensureSpace(blockH);
    this.style('semibold', 10, COLOR.text);
    doc.text(`Durchschnitt ${s.meanText}${SEP}Median ${s.medianText}`, bx, doc.y, { width: bw });
    const legend = this.scaleLegend(s);
    if (legend) {
      this.style('regular', 8.5, COLOR.muted);
      doc.text(legend, bx, doc.y + 2, { width: bw });
      doc.y += 2;
    }
    doc.y += 6;
    this.bars(s.distribution, bx, bw);
  }

  /** Frage mit zu wenigen Antworten: nur der Hinweis, keine Inhalte (SPEC §3 Regel 5). */
  suppressedBlock(q, bx, bw) {
    this.style('regular', 9.5, COLOR.muted);
    this.doc.text(this.clean(q.suppressedText), bx, this.doc.y, { width: bw });
  }

  choiceBlock(q, bx, bw) {
    if (!q.choice.options.length) {
      this.style('regular', 9.5, COLOR.muted);
      this.doc.text('Keine Optionen.', bx, this.doc.y, { width: bw });
      return;
    }
    this.bars(q.choice.options, bx, bw);
  }

  /** Freitexte: jede Antwort ein Absatz mit dünner linker Mango-Linie (auch über Seitenumbrüche). */
  textBlock(q, bx, bw) {
    const { doc } = this;
    if (!q.answers.length) {
      this.style('regular', 9.5, COLOR.muted);
      doc.text('Keine Antworten.', bx, doc.y, { width: bw });
      return;
    }
    const ruleX = bx + 0.75;
    const tx = bx + 12;
    const tw = bw - 12;
    const lh = this.lineHeight('regular', 10, 2);
    for (const raw of q.answers) {
      const text = this.clean(raw) || '(Antwort enthält nur nicht darstellbare Zeichen)';
      const h = this.textHeight(text, 'regular', 10, tw, { lineGap: 2 });
      // Mindestens drei Zeilen (oder die ganze Antwort) auf der aktuellen Seite, sonst neue Seite.
      this.ensureSpace(Math.min(h, lh * 3));

      const startPage = this.pageIndex;
      const startY = doc.y;
      this.style('regular', 10, COLOR.text);
      doc.text(text, tx, startY, { width: tw, lineGap: 2 });
      const endPage = this.pageIndex;
      const endY = doc.y - 2; // lineGap der letzten Zeile nicht mitziehen

      for (let p = startPage; p <= endPage; p += 1) {
        if (p !== endPage) doc.switchToPage(p);
        const y1 = p === startPage ? startY : doc.page.margins.top;
        const y2 = p === endPage ? endY : this.bottom;
        if (y2 > y1) {
          doc.save().lineWidth(1.5).strokeColor(COLOR.mango).moveTo(ruleX, y1).lineTo(ruleX, y2).stroke().restore();
        }
        if (p !== endPage) doc.switchToPage(endPage);
      }
      doc.x = bx;
      doc.y = endY + 2 + 9;
    }
  }

  // ----- Fußzeile -----------------------------------------------------------------------------------

  footers() {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const total = range.count;
    const fontSize = 7.5;
    for (let i = range.start; i < range.start + total; i += 1) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // sonst legt pdfkit beim Schreiben unterhalb des Rands eine neue Seite an
      const x = this.left;
      const w = this.width;
      this.style('regular', fontSize, COLOR.muted);
      const rest = `${SEP}Seite ${i - range.start + 1} von ${total}${SEP}Version ${this.meta.version}${SEP}${this.clean(this.meta.integrityText)}`;
      const title = this.fitText(this.clean(this.results.survey.title) || 'Umfrage', Math.max(40, w - doc.widthOfString(rest)));
      const y = doc.page.height - 32;
      doc.save().rect(x, y - 8, 24, 1.5).fill(COLOR.mango).restore();
      this.style('regular', fontSize, COLOR.muted);
      doc.text(`${title}${rest}`, x, y, { width: w, lineBreak: false, ellipsis: true });
      doc.page.margins.bottom = savedBottom;
    }
  }

  /** Kürzt Text mit „…“ auf die angegebene Breite (aktuelle Schrift). */
  fitText(text, maxWidth) {
    const { doc } = this;
    if (doc.widthOfString(text) <= maxWidth) return text;
    const chars = Array.from(text.replace(/\n/g, ' '));
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (doc.widthOfString(chars.slice(0, mid).join('').trimEnd() + ELLIPSIS) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
  }
}

module.exports = { renderResultsPdf, pdfFilename, contentDisposition, slugify, periodText };
