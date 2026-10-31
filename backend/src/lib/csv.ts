/**
 * Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines
 * inside quotes, and escaped quotes ("") — unlike a plain split(","), which
 * corrupts every field after a comma or newline embedded in a quoted value.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\r") {
      // skip — \n handles the line break
    } else if (char === "\n") {
      row.push(field.trim());
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // Last field/row (file may or may not end with a newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses a CSV with a header row into an array of header→value objects. */
export function parseCSVWithHeaders(text: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCSV(text);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0];
  const records = rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, i) => { record[header] = row[i] ?? ""; });
    return record;
  });

  return { headers, records };
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Inverse of parseCSVWithHeaders — re-serializes a subset of records back to CSV text. */
export function stringifyCSV(headers: string[], records: Record<string, string>[]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const record of records) {
    lines.push(headers.map((h) => csvEscape(record[h] ?? "")).join(","));
  }
  return lines.join("\n");
}
