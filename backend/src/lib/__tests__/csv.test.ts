import { parseCSV, parseCSVWithHeaders } from "../csv";

describe("parseCSV", () => {
  it("parses a plain comma-separated file", () => {
    const rows = parseCSV("name,phone\nVirat,919999999999\nNavin,918888888888");
    expect(rows).toEqual([
      ["name", "phone"],
      ["Virat", "919999999999"],
      ["Navin", "918888888888"],
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    const rows = parseCSV('name,note\nVirat,"Says, hello"\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Virat", "Says, hello"],
    ]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    const rows = parseCSV('name,note\nVirat,"line1\nline2"\nNavin,ok');
    expect(rows).toEqual([
      ["name", "note"],
      ["Virat", "line1\nline2"],
      ["Navin", "ok"],
    ]);
  });

  it("handles escaped double quotes inside a quoted field", () => {
    const rows = parseCSV('name,quote\nVirat,"She said ""hi"""');
    expect(rows).toEqual([
      ["name", "quote"],
      ["Virat", 'She said "hi"'],
    ]);
  });

  it("strips carriage returns from CRLF line endings", () => {
    const rows = parseCSV("name,phone\r\nVirat,919999999999\r\n");
    expect(rows).toEqual([
      ["name", "phone"],
      ["Virat", "919999999999"],
    ]);
  });

  it("handles a file with no trailing newline", () => {
    const rows = parseCSV("name,phone\nVirat,919999999999");
    expect(rows[1]).toEqual(["Virat", "919999999999"]);
  });
});

describe("parseCSVWithHeaders", () => {
  it("maps rows to header-keyed records", () => {
    const { headers, records } = parseCSVWithHeaders(
      "name,phone,workshop_date\nVirat,919999999999,15 June\nNavin,918888888888,20 June"
    );
    expect(headers).toEqual(["name", "phone", "workshop_date"]);
    expect(records).toEqual([
      { name: "Virat", phone: "919999999999", workshop_date: "15 June" },
      { name: "Navin", phone: "918888888888", workshop_date: "20 June" },
    ]);
  });

  it("does not misalign columns when a name contains a comma", () => {
    const { records } = parseCSVWithHeaders(
      'name,phone\n"Doe, Jane",919999999999\n'
    );
    expect(records).toEqual([{ name: "Doe, Jane", phone: "919999999999" }]);
  });

  it("returns empty output for empty input", () => {
    expect(parseCSVWithHeaders("")).toEqual({ headers: [], records: [] });
  });
});
