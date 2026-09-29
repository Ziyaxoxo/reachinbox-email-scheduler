import { describe, it, expect } from "vitest";
import { parseCsvContent } from "../workers/csvParser";

describe("parseCsvContent", () => {
  it("parses valid CSV content", () => {
    const content = "test@example.com\nuser@domain.com";
    const result = parseCsvContent(content);

    expect(result.valid).toEqual(["test@example.com", "user@domain.com"]);
    expect(result.invalid).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.totalRows).toBe(2);
  });

  it("handles comma-separated values", () => {
    const content = "test@example.com,user@domain.com,other@test.com";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(3);
    expect(result.valid).toContain("test@example.com");
    expect(result.valid).toContain("user@domain.com");
    expect(result.valid).toContain("other@test.com");
  });

  it("detects invalid emails", () => {
    const content = "test@example.com\ninvalid-email\nuser@domain.com";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toEqual(["invalid-email"]);
  });

  it("removes duplicates", () => {
    const content = "test@example.com\ntest@example.com\nuser@domain.com";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
    expect(result.duplicates).toEqual(["test@example.com"]);
  });

  it("normalizes email addresses", () => {
    const content = "Test@Example.COM\nUSER@DOMAIN.COM";
    const result = parseCsvContent(content);

    expect(result.valid).toEqual(["test@example.com", "user@domain.com"]);
  });

  it("handles empty lines", () => {
    const content = "test@example.com\n\n\nuser@domain.com\n";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
    expect(result.totalRows).toBe(2);
  });

  it("handles quoted emails", () => {
    const content = '"test@example.com"\n"user@domain.com"';
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
  });

  it("handles tab-separated values", () => {
    const content = "test@example.com\tuser@domain.com";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
  });

  it("handles semicolon-separated values", () => {
    const content = "test@example.com;user@domain.com";
    const result = parseCsvContent(content);

    expect(result.valid).toHaveLength(2);
  });
});
