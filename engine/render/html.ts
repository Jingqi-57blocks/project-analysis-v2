/**
 * Markdown as a page, for a reader who would rather not read Markdown.
 *
 * A view of the document, not a second document — the Markdown is the artifact
 * and this only renders it. The page carries a left sidebar built from the
 * document's own headings at render time (no client-side parsing), a small
 * script for scroll-tracking and the mobile toggle, and Mermaid from a CDN so
 * diagrams draw; opened without a network a diagram falls back to its source
 * text, which is still readable and is what the knowledge base stores anyway.
 */

import { marked } from "marked";

import { anchorFor, readHeadings } from "./contents.js";

/** One sidebar link. `children` nest one level; `current` marks this page. */
export interface NavEntry {
  readonly title: string;
  readonly href: string;
  readonly children?: readonly NavEntry[];
  readonly current?: boolean;
}

export interface RenderOptions {
  /**
   * The sidebar, when the caller knows the document's shape better than this
   * page does — a split export linking sibling pages. Omitted, the sidebar is
   * built from this page's own headings.
   */
  readonly nav?: readonly NavEntry[];
  /**
   * The title of the inline contents section to drop from the body. The
   * sidebar replaces it; rendered as well it would be the same list twice.
   * The Markdown keeps its Contents — this is a property of the view.
   */
  readonly contentsLabel?: string;
  /** Where the sidebar's title links — a split page points it at the index. */
  readonly homeHref?: string;
}

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

/**
 * Scroll tracking and the small-screen toggle.
 *
 * The sidebar itself is server-rendered; this only moves the highlight as the
 * reader scrolls (nearest heading above the viewport top wins — an observer
 * alone loses the highlight between long sections) and opens the sidebar on
 * narrow screens.
 */
const NAV_SCRIPT = `<script>
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll("#sidebar a[href*='#']"));
  var byId = {};
  links.forEach(function (link) {
    var hash = link.getAttribute("href").split("#")[1];
    if (hash) byId[hash] = link;
  });
  var headings = Array.prototype.slice.call(document.querySelectorAll("main h2[id], main h3[id]"))
    .filter(function (h) { return byId[h.id]; });

  function highlight() {
    var active = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= 80) active = headings[i];
      else break;
    }
    links.forEach(function (link) { link.classList.remove("active"); });
    if (active) {
      var link = byId[active.id];
      link.classList.add("active");
      var group = link.closest("li[data-group]");
      if (group) {
        var parent = group.querySelector(":scope > a");
        if (parent && parent !== link) parent.classList.add("active");
      }
    }
  }
  var ticking = false;
  addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { highlight(); ticking = false; });
  }, { passive: true });
  highlight();

  var toggle = document.getElementById("nav-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    document.body.classList.toggle("nav-open");
  });
  document.querySelectorAll("#sidebar a").forEach(function (link) {
    link.addEventListener("click", function () { document.body.classList.remove("nav-open"); });
  });
})();
</script>`;

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1c1e21; --muted: #616770; --line: #e4e6eb;
  --nav-bg: #f7f8fa; --accent: #2563eb; --accent-soft: rgba(37, 99, 235, 0.1);
  --code-bg: rgba(0, 0, 0, 0.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181c; --fg: #e6e8eb; --muted: #9aa2ad; --line: #2c2e33;
    --nav-bg: #1d1f24; --accent: #7aa2ff; --accent-soft: rgba(122, 162, 255, 0.14);
    --code-bg: rgba(255, 255, 255, 0.07);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
#layout { display: flex; min-height: 100vh; }

#sidebar {
  width: 264px; flex: none; position: sticky; top: 0; height: 100vh; overflow-y: auto;
  background: var(--nav-bg); border-right: 1px solid var(--line); padding: 1.1rem 0.9rem 2rem;
}
#sidebar .doc-title {
  display: block; font-weight: 700; font-size: 1.02rem; line-height: 1.3;
  color: var(--fg); text-decoration: none; padding: 0.25rem 0.6rem 0.9rem;
  border-bottom: 1px solid var(--line); margin-bottom: 0.7rem;
}
#sidebar ul { list-style: none; margin: 0; padding: 0; }
#sidebar li ul { margin-left: 0.65rem; border-left: 1px solid var(--line); }
#sidebar a {
  display: block; padding: 0.32rem 0.6rem; border-radius: 6px;
  color: var(--muted); text-decoration: none; font-size: 0.92rem; line-height: 1.35;
}
#sidebar li ul a { font-size: 0.86rem; padding: 0.24rem 0.6rem; }
#sidebar a:hover { color: var(--fg); background: var(--accent-soft); }
#sidebar a.active, #sidebar a[aria-current] { color: var(--accent); background: var(--accent-soft); font-weight: 600; }

main { flex: 1; min-width: 0; padding: 2.2rem clamp(1.25rem, 4vw, 3.5rem) 6rem; }
main > * { max-width: 54rem; }
h1, h2, h3 { line-height: 1.25; scroll-margin-top: 4.5rem; }
h1 { font-size: 1.9rem; margin: 0 0 1rem; }
h2 { font-size: 1.4rem; margin-top: 3rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.12rem; margin-top: 2rem; }
a { color: var(--accent); }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9em; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 0.45rem 0.65rem; text-align: left; vertical-align: top; }
th { background: var(--nav-bg); }
code { font-size: 0.9em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
pre { overflow-x: auto; padding: 0.85rem 1rem; background: var(--code-bg); border-radius: 8px; }
pre code { background: none; padding: 0; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
pre.mermaid { background: none; padding: 1rem 0; text-align: center; }
pre.mermaid:not([data-processed]) { font-size: 0.85em; text-align: left; opacity: 0.8; }

#nav-toggle {
  display: none; position: fixed; top: 0.7rem; left: 0.7rem; z-index: 20;
  border: 1px solid var(--line); background: var(--nav-bg); color: var(--fg);
  border-radius: 8px; padding: 0.35rem 0.6rem; font-size: 1rem; cursor: pointer;
}
@media (max-width: 900px) {
  #nav-toggle { display: block; }
  #sidebar {
    position: fixed; z-index: 10; transform: translateX(-100%); transition: transform 0.18s ease;
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.25);
  }
  body.nav-open #sidebar { transform: none; }
  main { padding-top: 3.4rem; }
}
@media print { #sidebar, #nav-toggle { display: none; } main { padding: 0; } }
`;

export function renderHtml(markdown: string, title: string, options: RenderOptions = {}): string {
  const body = withoutContentsSection(markdown, options.contentsLabel ?? "Contents");
  const rendered = withDiagrams(anchored(marked.parse(body, { async: false, gfm: true })));
  const nav = navHtml(options.nav ?? ownNav(body), title, options.homeHref ?? "#");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<button id="nav-toggle" aria-label="Menu">☰</button>
<div id="layout">
${nav}
<main>
${rendered}
</main>
</div>
${NAV_SCRIPT}
${MERMAID_SCRIPT}
</body>
</html>
`;
}

/** This page's own h2s, with their h3s nested — the whole-document sidebar. */
function ownNav(markdown: string): NavEntry[] {
  const nav: { title: string; href: string; children: NavEntry[] }[] = [];
  for (const heading of readHeadings(markdown)) {
    if (heading.level === 2) {
      nav.push({ title: heading.title, href: `#${heading.anchor}`, children: [] });
    } else if (heading.level === 3 && nav.length > 0) {
      nav[nav.length - 1]!.children.push({ title: heading.title, href: `#${heading.anchor}` });
    }
  }
  return nav;
}

function navHtml(entries: readonly NavEntry[], title: string, homeHref: string): string {
  const item = (entry: NavEntry): string => {
    const current = entry.current === true ? ' aria-current="page"' : "";
    const link = `<a href="${escapeHtml(entry.href)}"${current}>${escapeHtml(entry.title)}</a>`;
    const children =
      entry.children === undefined || entry.children.length === 0
        ? ""
        : `<ul>${entry.children.map(item).join("")}</ul>`;
    return `<li${children === "" ? "" : ' data-group=""'}>${link}${children}</li>`;
  };
  return `<nav id="sidebar">
<a class="doc-title" href="${escapeHtml(homeHref)}">${escapeHtml(title)}</a>
<ul>${entries.map(item).join("\n")}</ul>
</nav>`;
}

/**
 * The document without its inline contents section.
 *
 * The sidebar shows the same list; rendered as well it would open every page
 * with a duplicate. Dropped only from this view — the Markdown keeps it.
 */
function withoutContentsSection(markdown: string, label: string): string {
  const lines = markdown.split("\n");
  const headings = readHeadings(markdown);
  const contents = headings.find(
    (heading) => heading.level === 2 && heading.title === label,
  );
  if (contents === undefined) return markdown;

  const next = headings.find(
    (heading) => heading.level <= 2 && heading.line > contents.line,
  );
  const end = next === undefined ? lines.length : next.line;
  return [...lines.slice(0, contents.line), ...lines.slice(end)].join("\n");
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
