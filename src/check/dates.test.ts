import { describe, it, expect } from "vitest";
import { addDays, daysBetween } from "./dates.js";

describe("dates", () => {
  it("addDays correctly handles year boundaries", () => {
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
  });

  it("addDays correctly handles leap years", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("addDays correctly handles non-leap years", () => {
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
  });

  it("addDays correctly handles adding multiple days across months", () => {
    expect(addDays("2025-01-31", 30)).toBe("2025-03-02");
  });

  it("addDays correctly handles adding 0 days", () => {
    expect(addDays("2025-03-10", 0)).toBe("2025-03-10");
  });

  it("daysBetween correctly computes positive, negative and zero day differences", () => {
    expect(daysBetween("2025-03-10", "2025-03-12")).toBe(2);
    expect(daysBetween("2025-03-12", "2025-03-10")).toBe(-2);
    expect(daysBetween("2025-03-10", "2025-03-10")).toBe(0);
  });

  it("daysBetween correctly handles leap year boundaries", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });

  it("addDays throws for an impossible month", () => {
    expect(() => addDays("2025-13-01", 1)).toThrow(/YYYY-MM-DD/);
  });

  it("addDays throws for an impossible calendar date", () => {
    expect(() => addDays("2025-02-30", 1)).toThrow(/YYYY-MM-DD/);
  });

  it("daysBetween throws for a malformed date string", () => {
    expect(() => daysBetween("2025-03-10", "not a date")).toThrow(/YYYY-MM-DD/);
  });
});
