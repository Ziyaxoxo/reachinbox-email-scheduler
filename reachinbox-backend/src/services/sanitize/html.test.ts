import { describe, it, expect } from "vitest";
import { sanitizeEmailBody } from "./html.js";

describe("sanitizeEmailBody", () => {
  it("preserves supported formatting", () => {
    const html =
      "<p>Hello <strong>world</strong> and <em>team</em></p>" +
      "<ul><li>one</li><li>two</li></ul>";

    const { html: out, modified } = sanitizeEmailBody(html);
    expect(out).toContain("<strong>world</strong>");
    expect(out).toContain("<em>team</em>");
    expect(out).toContain("<li>one</li>");
    expect(modified).toBe(false);
  });

  it("keeps safe links", () => {
    const { html } = sanitizeEmailBody('<a href="https://example.com">x</a>');
    expect(html).toContain('href="https://example.com"');
  });

  it("keeps mailto links", () => {
    const { html } = sanitizeEmailBody('<a href="mailto:a@example.com">m</a>');
    expect(html).toContain("mailto:");
  });

  it("removes script elements and their contents", () => {
    const { html } = sanitizeEmailBody(
      "<p>ok</p><script>alert(1)</script>",
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert");
    expect(html).toContain("ok");
  });

  it("removes an unclosed script tag and everything after it", () => {
    const { html } = sanitizeEmailBody("<p>ok</p><script>alert(1)");
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert");
  });

  it("defeats nested script obfuscation", () => {
    const { html } = sanitizeEmailBody("<scr<script>ipt>alert(1)</script>");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("alert");
  });

  it("strips event handler attributes", () => {
    const { html } = sanitizeEmailBody('<p onclick="steal()">t</p>');
    expect(html).not.toContain("onclick");
    expect(html).toContain("t");
  });

  it("strips img onerror payloads", () => {
    const { html } = sanitizeEmailBody('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: URLs", () => {
    const { html } = sanitizeEmailBody(
      '<a href="javascript:alert(1)">c</a>',
    );
    expect(html).not.toContain("javascript:");
  });

  it("strips obfuscated javascript: URLs with control characters", () => {
    const { html } = sanitizeEmailBody(
      '<a href="java\tscript:alert(1)">c</a>',
    );
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("strips iframes and style blocks", () => {
    const { html } = sanitizeEmailBody(
      '<iframe src="https://evil.example"></iframe><style>*{}</style>',
    );
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("<style");
  });

  it("strips style attributes", () => {
    const { html } = sanitizeEmailBody(
      '<p style="background:url(https://evil)">x</p>',
    );
    expect(html).not.toContain("style=");
  });

  it("adds noopener to target=_blank links", () => {
    const { html } = sanitizeEmailBody(
      '<a href="https://example.com" target="_blank">x</a>',
    );
    expect(html).toContain("noopener");
  });

  it("removes HTML comments", () => {
    const { html } = sanitizeEmailBody(
      "<!--[if IE]><script>alert(1)</script><![endif]--><p>x</p>",
    );
    expect(html).not.toContain("alert");
  });

  it("preserves text of disallowed inline tags", () => {
    const { html } = sanitizeEmailBody("<p>a <blink>b</blink> c</p>");
    expect(html).toContain("a ");
    expect(html).toContain(" b ");
    expect(html).toContain(" c");
    expect(html).not.toContain("blink");
  });

  it("handles empty input", () => {
    expect(sanitizeEmailBody("")).toEqual({ html: "", modified: false });
  });

  it("is idempotent", () => {
    const dirty = '<p onclick="x">a</p><script>y</script>';
    const once = sanitizeEmailBody(dirty).html;
    const twice = sanitizeEmailBody(once).html;
    expect(twice).toBe(once);
  });

  it("flags modification when something was removed", () => {
    expect(sanitizeEmailBody("<p>clean</p>").modified).toBe(false);
    expect(sanitizeEmailBody("<script>x</script>").modified).toBe(true);
  });
});
