import path from "node:path";
import { describe, expect, it } from "vitest";
import { displayPath, formatCell, formatTable } from "./format.js";

describe("displayPath", () => {
  const cwd = path.resolve("/work/project");

  it("keeps a relative path inside the project", () => {
    expect(displayPath("data/raw", cwd)).toBe("data/raw");
  });

  it("makes an absolute path inside the project relative", () => {
    expect(displayPath(path.join(cwd, "data", "raw"), cwd)).toBe("data/raw");
  });

  it("shows the project root as '.'", () => {
    expect(displayPath(cwd, cwd)).toBe(".");
  });

  it("never reveals where a path outside the project lives", () => {
    expect(displayPath(path.resolve("/elsewhere/private/raw"), cwd)).toBe("<outside project>/raw");
    expect(displayPath("../sibling/raw", cwd)).toBe("<outside project>/raw");
  });

  it("does not mistake a folder whose name starts with '..' for a parent", () => {
    expect(displayPath("..cache/raw", cwd)).toBe("..cache/raw");
  });
});

describe("formatCell", () => {
  it("formats null and undefined as '—'", () => {
    expect(formatCell(null)).toBe("—");
    expect(formatCell(undefined)).toBe("—");
  });

  it("formats numbers with commas and strings/booleans correctly", () => {
    expect(formatCell(1234567)).toBe("1,234,567");
    expect(formatCell(0.25)).toBe("0.25");
    expect(formatCell(true)).toBe("true");
  });
});

describe("formatTable", () => {
  it("formats an empty array as '    (no rows)'", () => {
    expect(formatTable([])).toBe("    (no rows)");
  });

  it("formats a table with headers, rules, aligned columns, and 4 leading spaces", () => {
    const table = formatTable([{ name: "a", n: 5 }, { name: "bbb", n: 1200 }]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    
    // Check leading spaces and alignment
    expect(lines[0]).toBe("    name      n");
    expect(lines[1]).toBe("    ────  ─────");
    expect(lines[2]).toBe("    a         5");
    expect(lines[3]).toBe("    bbb   1,200");
  });

  it("right-aligns a column where one row has null and the rest are numbers", () => {
    const table = formatTable([{ v: 1200 }, { v: null }, { v: 5 }]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(5);
    
    expect(lines[0]).toBe("        v");
    expect(lines[1]).toBe("    ─────");
    expect(lines[2]).toBe("    1,200");
    expect(lines[3]).toBe("        —");
    expect(lines[4]).toBe("        5");
  });
});
