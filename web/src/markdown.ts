/**
 * Companion replies come back as markdown (headers, bold, tables, lists).
 * We render only the FINAL text this way — streamed deltas stay plain text
 * while they arrive, since re-parsing partial markdown on every token is
 * wasted work and looks janky (headers flickering mid-word).
 *
 * Sanitized with DOMPurify before it ever touches innerHTML: the text is
 * model output, and a companion with web search could in principle relay
 * something that looks like markup.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "hr",
      "table", "thead", "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: ["href"],
  });
}
