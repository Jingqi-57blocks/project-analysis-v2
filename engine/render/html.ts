/**
 * Markdown as a page, for a reader who would rather not read Markdown.
 *
 * A view of the document, not a second document — the Markdown is the artifact
 * and this only renders it. Self-contained, so it opens from disk with no
 * network, which also means no diagram renderer: a mermaid block is shown as
 * its source, which is what the knowledge base stores anyway.
 */

import { marked } from "marked";

import { anchorFor } from "./contents.js";

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 54rem; padding: 2rem 1.25rem 6rem;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
h1, h2, h3 { line-height: 1.25; margin-top: 2.5rem; scroll-margin-top: 1rem; }
h1 { margin-top: 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9em; display: block; overflow-x: auto; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, currentColor 8%, transparent); }
code { font-size: 0.9em; }
pre { overflow-x: auto; padding: 0.75rem; background: color-mix(in srgb, currentColor 6%, transparent); border-radius: 4px; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent); }
`;

export function renderHtml(markdown: string, title: string): string {
  // Anchors are added here rather than left to the Markdown renderer, so a
  // link in the contents lands where the same link lands on GitHub.
  const body = anchored(marked.parse(markdown, { async: false, gfm: true }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Gives every heading the id its Markdown anchor points at.
 *
 * `marked` emits plain `<h2>` tags, so a contents entry linking to
 * `#what-it-stores` lands nowhere. The rule matches the one `contents.ts`
 * uses, which is GitHub's, so one document navigates the same way in both.
 */
function anchored(html: string): string {
  const taken = new Set<string>();
  return html.replaceAll(
    /<h([1-6])>(.*?)<\/h\1>/g,
    (_whole, level: string, inner: string) => {
      const title = inner.replaceAll(/<[^>]+>/g, "");
      return `<h${level} id="${escapeHtml(anchorFor(title, taken))}">${inner}</h${level}>`;
    },
  );
}
