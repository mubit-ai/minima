import { describe, expect, test } from "bun:test";
import { parseCsv, parseRecords, serializeCsv, serializeRecords } from "../src/csv.ts";

describe("parseCsv", () => {
  test("parses simple rows", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("ignores a trailing newline and yields no rows for empty input", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("")).toEqual([]);
  });

  test("keeps empty fields, quoted or bare", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    expect(parseCsv('a,"",b')).toEqual([["a", "", "b"]]);
  });

  test("parses CRLF row terminators", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("parses a quoted field containing the delimiter", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  test("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', "x"]]);
  });

  test("supports single-character custom delimiters only", () => {
    expect(parseCsv("a;b;c", { delimiter: ";" })).toEqual([["a", "b", "c"]]);
    expect(() => parseCsv("a,b", { delimiter: ",," })).toThrow(RangeError);
  });
});

describe("serializeCsv", () => {
  test("serializes plain rows", () => {
    expect(
      serializeCsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a,b\nc,d");
  });

  test("quotes fields containing the delimiter", () => {
    expect(serializeCsv([["a,b", "c"]])).toBe('"a,b",c');
  });

  test("escapes embedded quotes by doubling them", () => {
    expect(serializeCsv([['say "hi"']])).toBe('"say ""hi"""');
  });

  test("renders null and undefined as empty fields", () => {
    expect(serializeCsv([["a", null, undefined, "d"]])).toBe("a,,,d");
  });

  test("joins rows with a custom newline", () => {
    expect(serializeCsv([["a"], ["b"]], { newline: "\r\n" })).toBe("a\r\nb");
  });

  test("round-trips rows containing delimiters and quotes", () => {
    const rows = [
      ["id", "note"],
      ["1", 'said "ok", then left'],
      ["2", "plain"],
    ];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });
});

describe("record I/O", () => {
  test("parseRecords maps the header row onto each body row, padding short rows", () => {
    expect(parseRecords("name,age\nada,36\ngrace,45")).toEqual([
      { name: "ada", age: "36" },
      { name: "grace", age: "45" },
    ]);
    expect(parseRecords("a,b\n1")).toEqual([{ a: "1", b: "" }]);
  });

  test("serializeRecords derives headers from key union in first-seen order", () => {
    const text = serializeRecords([
      { name: "ada", age: 36 },
      { name: "grace", born: 1906 },
    ]);
    expect(text).toBe("name,age,born\nada,36,\ngrace,,1906");
  });

  test("serializeRecords honours an explicit header order", () => {
    const text = serializeRecords([{ a: 1, b: 2 }], { headers: ["b", "a"] });
    expect(text).toBe("b,a\n2,1");
  });
});
