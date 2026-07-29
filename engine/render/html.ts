/**
 * Markdown as a page, for a reader who would rather not read Markdown.
 *
 * A view of the document, not a second document — the Markdown is the artifact
 * and this only renders it. Self-contained, so it opens from disk with no
 * network: the mermaid blocks are left as-is and drawn by a script the page
 * carries, or shown as their source when it is absent.
 */

import { marked } from "marked";

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 54rem; padding: 2rem 1.25rem 6rem;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
h1, h2, h3 { line-height: 1.25; margin-top: 2.5rem; }
h1 { margin-top: 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9em; display: block; overflow-x: auto; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, currentColor 8%, transparent); }
code { font-size: 0.9em; }
pre { overflow-x: auto; padding: 0.75rem; background: color-mix(in srgb, currentColor 6%, transparent); border-radius: 4px; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent); }
`;

export function renderHtml(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
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
