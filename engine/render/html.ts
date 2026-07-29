/**
 * Markdown as a page, for a reader who would rather not read Markdown.
 *
 * A view of the document, not a second document — the Markdown is the artifact
 * and this only renders it. Diagrams are drawn by Mermaid, loaded from a CDN so
 * the page stays a single small file; opened without a network the diagram
 * falls back to its source text, which is still readable and is what the
 * knowledge base stores anyway.
 */

import { marked } from "marked";

import { anchorFor } from "./contents.js";

/**
 * Mermaid, loaded as a module and told to draw every `pre.mermaid`.
 *
 * Pinned to a major version so a breaking release cannot change a published
 * report. `securityLevel: loose` lets a label carry the punctuation our
 * diagrams use; the content is our own, never a reader's input.
 */
const MERMAID_SCRIPT = `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: true, securityLevel: "loose", theme: dark ? "dark" : "default" });
</script>`;

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
pre.mermaid { background: none; padding: 1rem 0; text-align: center; }
pre.mermaid:not([data-processed]) { font-size: 0.85em; text-align: left; opacity: 0.8; }
`;

export function renderHtml(markdown: string, title: string): string {
  // Anchors are added here rather than left to the Markdown renderer, so a
  // link in the contents lands where the same link lands on GitHub.
  const body = withDiagrams(anchored(marked.parse(markdown, { async: false, gfm: true })));
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
${MERMAID_SCRIPT}
</body>
</html>
`;
}

/**
 * Turns a fenced mermaid block into an element Mermaid will draw.
 *
 * `marked` renders ```mermaid as `<pre><code class="language-mermaid">`; Mermaid
 * looks for `pre.mermaid`. The diagram text is un-escaped because Mermaid reads
 * the element's text content and re-parses it — a label written `q["x"]` must
 * reach it as `"`, not `&quot;`.
 */
function withDiagrams(html: string): string {
  return html.replaceAll(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_whole, source: string) => `<pre class="mermaid">${unescapeHtml(source)}</pre>`,
  );
}

function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
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
