// JSON a model wrote, read leniently (persona.extractJson and everything that uses it: the handoff note,
// the Inner World's day, journal entries, reflections, rehearsals, looks). One slip lost the whole
// result: "Expected ':' after property name" (the handoff note) and "Expected ',' or ']' after array
// element at line 153" (a day in the village). Pure (test/jsonrepair.test.js).
//  - parseLoose: the object in the reply (code fences and chatter around it ignored), then repairs of
//    the usual slips: quotes inside text left unescaped, raw line breaks in strings, a missing comma
//    between lines, trailing commas, comments.
//  - withRetry: when even that fails, the model gets one chance to correct its own JSON.

/** The first complete {...} or [...] in the text, found string-aware (braces inside text don't count). */
function slice(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // cut off: the repairs below may still close it
}

// Inside strings: a quote not followed by , } ] : (or a line break and the next key) is text, so it
// is escaped; raw line breaks and tabs become escapes.
function fixStrings(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') {
      out += c + (s[i + 1] ?? '');
      i++;
    } else if (c === '"') {
      const rest = s.slice(i + 1);
      const closes = /^\s*($|[,}\]:])/.test(rest) || /^[ \t]*\r?\n\s*"/.test(rest);
      if (closes) inStr = false;
      out += closes ? c : '\\"';
    } else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c !== '\r') out += c;
  }
  return inStr ? `${out}"` : out;
}

// Outside strings (masked while fixing): comments, trailing commas, missing commas between lines,
// unclosed brackets at the end.
function fixStructure(s) {
  const strings = [];
  let masked = s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => `\u0001${strings.push(m) - 1}\u0002`);
  masked = masked.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  masked = masked.replace(/,(\s*[}\]])/g, '$1');
  masked = masked.replace(/([}\]\u0002]|\d|true|false|null)(\s*\n\s*)(?=[{[\u0001])/g, '$1,$2');
  const open = [];
  for (const c of masked.replace(/\u0001\d+\u0002/g, '')) {
    if (c === '{' || c === '[') open.push(c);
    else if (c === '}' || c === ']') open.pop();
  }
  masked = masked.replace(/,\s*$/, '') + open.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  return masked.replace(/\u0001(\d+)\u0002/g, (_, n) => strings[Number(n)]);
}

/** The JSON value in a model's reply. Throws the parse error when even the repairs don't help. */
function parseLoose(text) {
  const raw = slice(text);
  if (!raw) throw new Error('The reply has no JSON in it.');
  try {
    return JSON.parse(raw);
  } catch (first) {
    try {
      return JSON.parse(fixStructure(fixStrings(raw)));
    } catch {
      throw first; // the original position is the one worth reporting
    }
  }
}

const FIX_PROMPT = (text, err) =>
  `This JSON you wrote does not parse (${String(err?.message || err).slice(0, 200)}). Return the same content as valid JSON only: no comments, no text around it. Escape quotes inside strings.\n\n${String(text).slice(0, 24000)}`;

/** parseLoose, else one request to the model (`ask(prompt)` → its reply) to correct it. */
async function withRetry(text, ask) {
  try {
    return parseLoose(text);
  } catch (err) {
    if (typeof ask !== 'function') throw err;
    return parseLoose(await ask(FIX_PROMPT(text, err)));
  }
}

module.exports = { parseLoose, withRetry, FIX_PROMPT };
