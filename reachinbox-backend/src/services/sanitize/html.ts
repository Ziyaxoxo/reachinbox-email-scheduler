/**
 * Server-side HTML sanitization for rich-text email bodies.
 *
 * The browser sanitizes before submission, but the browser is not trusted
 * (FE-SEC-001). A direct API caller can post any body, and the stored value is
 * later rendered in mail clients, so the same allowlist is enforced here.
 *
 * Implemented without a DOM dependency: markup is tokenized and anything not
 * explicitly permitted is dropped. Script-bearing elements, event-handler
 * attributes and dangerous URL schemes are removed outright.
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "pre",
  "code",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "span",
  "div",
  "hr",
]);

const ALLOWED_ATTRS = new Set(["href", "title", "target", "rel"]);

/** Elements whose entire contents must be discarded, not just the tag. */
const DANGEROUS_TAGS = ["script", "style", "iframe", "object", "embed"] as const;

/** Alternation must be grouped, or `a|b` binds as `a` OR `b`. */
const DANGEROUS_ALT = `(?:${DANGEROUS_TAGS.join("|")})`;

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

/** C0 control characters except tab/newline/carriage return. */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHARS, "");
}

export interface SanitizeResult {
  html: string;
  /** True when anything not on the allowlist was removed. */
  modified: boolean;
}

export function sanitizeEmailBody(dirty: string): SanitizeResult {
  if (!dirty) return { html: "", modified: false };

  let text = stripControlChars(dirty);
  let modified = false;

  // 1. Remove dangerous elements *with* their contents, repeatedly, so nested
  //    obfuscation (`<scr<script>ipt>`) cannot survive a single pass.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;

    for (const tag of DANGEROUS_TAGS) {
      const block = new RegExp(
        `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,
        "gi",
      );
      if (block.test(text)) {
        text = text.replace(block, "");
        modified = true;
        changed = true;
      }
    }

    // An unclosed dangerous tag swallows the remainder of the document in a
    // real parser, so drop the tail too.
    const unclosed = new RegExp(
      `<${DANGEROUS_ALT}\\b[^>]*>[\\s\\S]*$`,
      "i",
    );
    if (unclosed.test(text)) {
      text = text.replace(unclosed, "");
      modified = true;
      changed = true;
    }

    if (!changed) break;
  }

  // 2. Comments can smuggle conditional script in some clients.
  if (/<!--/.test(text)) {
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    modified = true;
  }

  // 3. Rewrite remaining tags: drop disallowed elements, strip disallowed
  //    attributes.
  text = text.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g,
    (match, rawTag: string, rawAttrs: string) => {
      const tag = rawTag.toLowerCase();

      if (!ALLOWED_TAGS.has(tag)) {
        modified = true;
        return "";
      }

      if (match.startsWith("</")) return `</${tag}>`;
      if (tag === "br" || tag === "hr") return `<${tag} />`;

      const attrs = sanitiseAttributes(rawAttrs, tag);
      if (attrs.modified) modified = true;

      return `<${tag}${attrs.value}>`;
    },
  );

  // 4. Any surviving bare `<` is literal text, not a tag.
  if (/<(?![a-zA-Z/!])/.test(text)) {
    text = text.replace(/<(?![a-zA-Z/!])/g, "&lt;");
    modified = true;
  }

  return { html: text, modified };
}

function sanitiseAttributes(
  raw: string,
  tag: string,
): { value: string; modified: boolean } {
  let modified = false;
  const out: string[] = [];
  let hasBlankTarget = false;
  let hasRel = false;

  const attrRe =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;

  while ((m = attrRe.exec(raw)) !== null) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";

    // Event handlers and anything not explicitly allowed.
    if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) {
      modified = true;
      continue;
    }

    if (name === "href") {
      const trimmed = stripControlChars(value).trim();
      if (!SAFE_SCHEME.test(trimmed)) {
        modified = true;
        continue;
      }
      out.push(`href="${escapeAttr(trimmed)}"`);
      continue;
    }

    if (name === "target") {
      if (value === "_blank") {
        hasBlankTarget = true;
      } else {
        modified = true;
      }
      continue;
    }

    if (name === "rel") {
      hasRel = true;
      out.push(`rel="${escapeAttr(value)}"`);
      continue;
    }

    out.push(`${name}="${escapeAttr(stripControlChars(value))}"`);
  }

  // _blank without noopener is a tabnabbing vector.
  if (hasBlankTarget) {
    modified = true;
    if (!hasRel) out.push('rel="noopener noreferrer"');
  }

  void tag;
  return { value: out.length ? ` ${out.join(" ")}` : "", modified };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Convenience wrapper for callers that only need the sanitized string. */
export function sanitizeEmailBodyToString(dirty: string): string {
  return sanitizeEmailBody(dirty).html;
}
