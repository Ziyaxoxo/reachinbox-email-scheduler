/**
 * HTML sanitization for rich-text email bodies.
 *
 * The editor produces HTML via `document.execCommand`, and that HTML is
 * persisted and later rendered in mail clients. Anything executable — script
 * tags, event handlers, javascript: URLs, iframes — must be stripped before the
 * value leaves the browser. Client sanitization is defence in depth only; the
 * backend is still the security boundary and re-validates.
 */
import DOMPurify from "isomorphic-dompurify";

/** Tags the editor toolbar can legitimately produce. */
const ALLOWED_TAGS = [
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
];

const ALLOWED_ATTR = ["href", "title", "target", "rel"];

let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      // Only safe schemes, and always noopener for target=_blank.
      const href = node.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href.trim())) {
        node.removeAttribute("href");
      }
      if (node.getAttribute("target") === "_blank") {
        node.setAttribute("rel", "noopener noreferrer");
      }
    }
  });
}

export function sanitizeEmailHtml(dirty: string): string {
  if (!dirty) return "";
  installHooks();

  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Drop anything that is not explicitly permitted.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,
  });
}

/** True when the value contains markup that the sanitizer would strip. */
export function hasUnsafeMarkup(dirty: string): boolean {
  return sanitizeEmailHtml(dirty) !== dirty;
}
