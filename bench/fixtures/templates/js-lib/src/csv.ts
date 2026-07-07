/**
 * CSV parsing and serialization (RFC 4180-flavoured).
 *
 * The parser is a single-pass character state machine that supports:
 *   - quoted fields containing the delimiter, quote characters (escaped as
 *     `""`), and embedded line breaks (LF, CR, or CRLF);
 *   - configurable single-character delimiters;
 *   - LF, CRLF, and lone-CR row terminators (mixed terminators are fine);
 *   - a trailing row terminator (it does not produce a phantom empty row).
 *
 * The serializer quotes a field only when the parser would need it quoted
 * (it contains the delimiter, a quote character, or a line-break character),
 * so `parseCsv(serializeCsv(rows))` round-trips losslessly for string data.
 */

export interface CsvParseOptions {
  /** Field delimiter; must be a single character. Defaults to ",". */
  delimiter?: string;
}

export interface CsvSerializeOptions {
  /** Field delimiter; must be a single character. Defaults to ",". */
  delimiter?: string;
  /** Row separator placed between output rows. Defaults to "\n". */
  newline?: string;
}

export interface CsvRecordSerializeOptions extends CsvSerializeOptions {
  /**
   * Column order for the header row. When omitted, the union of all record
   * keys is used, in first-seen order.
   */
  headers?: string[];
}

function checkDelimiter(delimiter: string): void {
  if (delimiter.length !== 1) {
    throw new RangeError(`delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }
  if (delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new RangeError("delimiter must not be a quote or line-break character");
  }
}

/**
 * Parse CSV text into an array of rows, each row an array of string fields.
 *
 * Quoting rules follow RFC 4180: a field that begins with `"` is a quoted
 * field; inside it, `""` denotes a literal quote and delimiters/line breaks
 * are literal text. Unquoted fields are read verbatim up to the next
 * delimiter or row terminator (a stray quote mid-field is kept as-is).
 *
 * An empty input string yields zero rows.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ",";
  checkDelimiter(delimiter);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let fieldQuoted = false; // current field began with an opening quote
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
        } else {
          inQuotes = false; // closing quote
          i += 1;
        }
      } else {
        field += ch; // delimiters and line breaks are literal inside quotes
        i += 1;
      }
      continue;
    }
    if (ch === '"' && field === "" && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      fieldQuoted = false;
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldQuoted = false;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || fieldQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True when a field must be wrapped in quotes to survive a round trip. */
function needsQuoting(field: string, delimiter: string): boolean {
  return (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  );
}

/** Encode one field, quoting and escaping only when necessary. */
function encodeField(value: unknown, delimiter: string): string {
  const field = value === null || value === undefined ? "" : String(value);
  if (!needsQuoting(field, delimiter)) return field;
  return '"' + field.replaceAll('"', '""') + '"';
}

/**
 * Serialize rows of values to CSV text.
 *
 * `null` and `undefined` become empty fields; other values are converted
 * with `String()`. Fields containing the delimiter, quotes, or line breaks
 * are quoted, with embedded quotes doubled. Rows are joined with
 * `options.newline` (default "\n"); no trailing newline is appended.
 */
export function serializeCsv(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: CsvSerializeOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const newline = options.newline ?? "\n";
  checkDelimiter(delimiter);
  return rows
    .map((row) => row.map((value) => encodeField(value, delimiter)).join(delimiter))
    .join(newline);
}

/**
 * Parse CSV text whose first row is a header into an array of records.
 *
 * Each subsequent row becomes an object keyed by the header names. Rows
 * shorter than the header are padded with empty strings; extra cells beyond
 * the header are dropped. An input with no rows yields an empty array.
 */
export function parseRecords(
  text: string,
  options: CsvParseOptions = {},
): Record<string, string>[] {
  const rows = parseCsv(text, options);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((cells) => {
    const record: Record<string, string> = {};
    header!.forEach((name, idx) => {
      record[name] = cells[idx] ?? "";
    });
    return record;
  });
}

/** Union of record keys, in first-seen order. */
function collectHeaders(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

/**
 * Serialize an array of records to CSV text with a leading header row.
 *
 * Column order is `options.headers` when given, otherwise the union of all
 * record keys in first-seen order. Missing values become empty fields.
 */
export function serializeRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  options: CsvRecordSerializeOptions = {},
): string {
  const headers = options.headers ?? collectHeaders(records);
  const rows: unknown[][] = [headers, ...records.map((r) => headers.map((h) => r[h]))];
  return serializeCsv(rows, options);
}
