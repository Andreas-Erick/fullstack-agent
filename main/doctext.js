// The text of a document, from its bytes: PDF (pdf.js), Word (mammoth), HTML (tags stripped), anything else
// as text. Pure (no Electron), so it runs both in the main process (documents.js: read_document) and in the
// worker thread that reads files dropped into the chat (extractworker.js, main/attachments.js).
const { decodeText, unpacksTooFar } = require('./attachcore');

/** A Word file is a zip: one that says it unpacks to far more than a document would (a zip bomb) isn't opened. */
function checkDocx(buf) {
  if (unpacksTooFar(buf)) throw new Error('This Word file unpacks to far more than a document would, so Siren doesn’t open it.');
}

let pdfjsPromise = null;
function getPdfjs() {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** A PDF's text page by page, until `maxChars`: { text, pages (in all), pagesRead (the last page read) }. */
async function pdfText(buf, maxChars) {
  const pdfjs = await getPdfjs();
  // pdf.js 6: only the loading task has destroy(); always release it, also when a page fails.
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    let out = '';
    let pagesRead = 0;
    for (let i = 1; i <= pdf.numPages && out.length < maxChars; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out += `\n\n--- Page ${i} ---\n` + tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      pagesRead = i;
    }
    return { text: out.trim(), pages: pdf.numPages, pagesRead };
  } finally {
    task.destroy().catch(() => {}); // the loading task already ended: nothing to release
  }
}

const htmlText = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** A text file's text: UTF-16 by its byte-order mark, an 8-bit file as Windows-1252 (attachcore.decodeText);
 *  what doesn't look like text at all is read as UTF-8, as before. */
function asText(buf) {
  const { text, binary } = decodeText(buf);
  return binary ? Buffer.from(buf).toString('utf8') : text;
}

/** { text, pages?, pagesRead? } for a document of `kind` (documents.js kindOf: pdf, docx, html, image, text…). */
async function textOf(buf, kind, { maxChars = 30000 } = {}) {
  if (kind === 'pdf') return pdfText(buf, maxChars);
  if (kind === 'docx') {
    checkDocx(buf);
    return { text: (await require('mammoth').extractRawText({ buffer: Buffer.from(buf) })).value };
  }
  if (kind === 'image') return { text: '[Image file — no text content available]' };
  if (kind === 'html') return { text: htmlText(asText(buf)) };
  return { text: asText(buf) };
}

module.exports = { textOf, pdfText, htmlText, asText, checkDocx };
