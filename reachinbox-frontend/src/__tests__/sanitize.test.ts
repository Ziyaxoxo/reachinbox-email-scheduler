import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml, hasUnsafeMarkup } from "../lib/sanitize";

describe("sanitizeEmailHtml", () => {
  it("preserves the formatting the editor produces", () => {
    const html = "<p>Hello <strong>world</strong> and <em>team</em></p>";
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it("keeps list and heading structure", () => {
    const html = "<h2>Title</h2><ul><li>one</li><li>two</li></ul>";
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it("strips script tags", () => {
    const dirty = "<p>ok</p><script>alert('xss')</script>";
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toContain("script");
    expect(clean).toContain("ok");
  });

  it("strips inline event handlers", () => {
    const dirty = '<p onclick="steal()">text</p>';
    expect(sanitizeEmailHtml(dirty)).not.toContain("onclick");
  });

  it("strips img onerror payloads", () => {
    const dirty = '<img src=x onerror="alert(1)">';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toContain("onerror");
  });

  it("strips javascript: urls", () => {
    const dirty = '<a href="javascript:alert(1)">click</a>';
    expect(sanitizeEmailHtml(dirty)).not.toContain("javascript:");
  });

  it("keeps safe links", () => {
    const dirty = '<a href="https://example.com">site</a>';
    expect(sanitizeEmailHtml(dirty)).toContain("https://example.com");
  });

  it("keeps mailto links", () => {
    const dirty = '<a href="mailto:a@example.com">mail</a>';
    expect(sanitizeEmailHtml(dirty)).toContain("mailto:");
  });

  it("adds noopener to target=_blank links", () => {
    const dirty = '<a href="https://example.com" target="_blank">site</a>';
    expect(sanitizeEmailHtml(dirty)).toContain("noopener");
  });

  it("strips iframes", () => {
    const dirty = '<iframe src="https://evil.example"></iframe>';
    expect(sanitizeEmailHtml(dirty)).not.toContain("iframe");
  });

  it("strips style attributes used for exfiltration", () => {
    const dirty = '<p style="background:url(https://evil.example)">x</p>';
    expect(sanitizeEmailHtml(dirty)).not.toContain("url(");
  });

  it("handles empty input", () => {
    expect(sanitizeEmailHtml("")).toBe("");
  });

  it("keeps text content when stripping an unsafe wrapper", () => {
    const clean = sanitizeEmailHtml("<script>alert(1)</script><p>safe</p>");
    expect(clean).toContain("safe");
  });

  it("is idempotent", () => {
    const dirty = "<p>a</p><script>x</script>";
    const once = sanitizeEmailHtml(dirty);
    expect(sanitizeEmailHtml(once)).toBe(once);
  });
});

describe("hasUnsafeMarkup", () => {
  it("detects markup that would be stripped", () => {
    expect(hasUnsafeMarkup("<p onclick='x()'>a</p>")).toBe(true);
  });

  it("reports clean markup as safe", () => {
    expect(hasUnsafeMarkup("<p><strong>clean</strong></p>")).toBe(false);
  });
});
