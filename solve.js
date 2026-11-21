// Fast CSV reader producing exactly csv-reader 1.0.0's answer {columns, rows, errors}
// for an input {text, header}, under its broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next undoubled quote ("" inside is one
//     quote; CRLF and lone CR inside read as LF); text after the closing quote, up to
//     the next comma or line break, is appended as it stands (quote_junk); a quote
//     that never closes is a literal character and the rest is re-read unquoted
//     (unterminated_quote);
//   - quotes inside unquoted fields are literal; fields stay strings, untouched;
//   - columns is the first record when header is true (else null); rows are padded
//     with "" (short_row, with fields: the count) or cut (long_row, with extra: the
//     cut fields) to the first record's width;
//   - each error is {code, line, row}: line is the 1-based line the record starts on
//     (LF, CRLF and lone CR inside quotes counted), row its index in rows (null for
//     the header), in the order met.
//
// One left-to-right pass. Field text is taken with slice() between special
// characters instead of being built a character at a time, so clean fields cost a
// single scan plus one substring. Pure: nothing kept between calls.

// How a field ended.
const COMMA = 0; // at a comma: the record goes on
const BREAK = 1; // at a line break: the record ends
const END = 2; // at the end of the text: the record ends

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: header).
  let recLine = 1;
  let recRow = null;

  // Result of the last field read.
  let fValue = '';
  let fEnd = END;
  let fAdded = 0; // characters the unquoted reader kept (for quote_junk)

  function err(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr).
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ,
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        fValue = value;
        fEnd = COMMA;
        fAdded = added;
        return;
      }
      if (c === 10) {
        // LF
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        line += 1;
        fValue = value;
        fEnd = BREAK;
        fAdded = added;
        return;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(pos + 1) === 10) {
          value += text.slice(start, pos);
          added += pos - start;
          pos += 2;
          line += 1;
          fValue = value;
          fEnd = BREAK;
          fAdded = added;
          return;
        }
        // Stray CR: keep what came before it, drop it, keep scanning.
        value += text.slice(start, pos);
        added += pos - start;
        err('stray_cr');
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(start, pos);
    added += pos - start;
    fValue = value;
    fEnd = END;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let start = p; // start of the current plain run
    let parts = null; // plain runs + replacements, once the field is not one plain run
    let breaks = 0; // line breaks inside the quotes, committed to `line` on close
    let closed = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        // "
        if (text.charCodeAt(p + 1) === 34) {
          // Doubled quote: one literal quote.
          if (parts === null) parts = [text.slice(start, p), '"'];
          else parts.push(text.slice(start, p), '"');
          p += 2;
          start = p;
          continue;
        }
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF or a lone CR inside quotes reads as one LF.
        if (parts === null) parts = [text.slice(start, p), '\n'];
        else parts.push(text.slice(start, p), '\n');
        breaks += 1;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        start = p;
        continue;
      }
      if (c === 10) {
        breaks += 1;
        p += 1;
        continue;
      }
      p += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as an unquoted field (line breaks re-counted from openLine).
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      readUnquoted('"');
      return;
    }
    let value;
    if (parts === null) {
      value = text.slice(start, p);
    } else {
      parts.push(text.slice(start, p));
      value = parts.join('');
    }
    line += breaks;
    pos = p + 1; // past the closing quote
    if (pos >= n) {
      fValue = value;
      fEnd = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnd = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnd = BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnd = BREAK;
      fAdded = 0;
      return;
    }
    // Whatever follows the closing quote is appended as it stands.
    readUnquoted(value);
    if (fAdded > 0) err('quote_junk');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        readQuoted();
      } else {
        lastQuoted = false;
        readUnquoted('');
      }
      fields.push(fValue);
    } while (fEnd === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
