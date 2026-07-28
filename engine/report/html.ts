/**
 * Renders a report as browsable local HTML.
 *
 * Self-contained: plain HTML, CSS and JavaScript, no build step, no framework,
 * opens from disk. A separate renderer consuming the report model, so DOCX and
 * PDF can be siblings rather than rewrites.
 *
 * ## Written for a PM
 *
 * No source locators — no `service.ts:113`, no symbol ids, no call-edge
 * counts. A reader should never need to open the codebase to follow this.
 * Uncertainty is stated in words rather than shown as a confidence enum.
 */

import { stringsFor } from "./strings.js";
import type { ReportModel } from "./model.js";
import type { Severity } from "../health/signals.js";

export interface RenderedPage {
  readonly filename: string;
  readonly title: string;
  readonly html: string;
}

/** Escapes text for HTML. Report content includes project prose, which is untrusted input. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Mermaid labels are not HTML — quotes and newlines would break the diagram. */
function mermaidLabel(value: string): string {
  return value.replace(/["\n\r]/g, " ").replace(/[[\]{}()]/g, "").trim() || "?";
}

const STYLE = `
:root { --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --bg:#fff; --accent:#2b5fa8;
        --concern:#b23c17; --notice:#8a6d1f; --info:#3a6b3a; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",
       "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
       color:var(--fg); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
nav.side { width:230px; flex:none; border-right:1px solid var(--line); padding:24px 18px; }
nav.side h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
              color:var(--muted); margin:0 0 12px; }
nav.side a { display:block; padding:6px 8px; margin:2px -8px; color:var(--fg);
             text-decoration:none; border-radius:5px; font-size:14px; }
nav.side a:hover { background:#f2f4f7; }
nav.side a.active { background:#eaf0fa; color:var(--accent); font-weight:600; }
main { flex:1; padding:32px 40px 80px; max-width:900px; }
h1 { font-size:26px; margin:0 0 4px; }
h2 { font-size:19px; margin:34px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
h3 { font-size:16px; margin:22px 0 6px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:20px; }
.toc { background:#fafbfc; border:1px solid var(--line); border-radius:6px; padding:12px 16px; margin:18px 0; }
.toc h2 { border:none; margin:0 0 6px; font-size:13px; text-transform:uppercase;
          letter-spacing:.06em; color:var(--muted); }
.toc ul { margin:0; padding-left:18px; }
.toc a { color:var(--accent); text-decoration:none; }
table { border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }
th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.card { border:1px solid var(--line); border-radius:6px; padding:14px 16px; margin:10px 0; }
.card.concern { border-left:4px solid var(--concern); }
.card.notice  { border-left:4px solid var(--notice); }
.card.info    { border-left:4px solid var(--info); }
.tag { display:inline-block; font-size:11px; padding:2px 8px; border-radius:20px;
       background:#f0f2f5; color:var(--muted); margin-right:6px; }
.evidence { border-left:3px solid var(--line); padding:2px 0 2px 12px; margin:6px 0;
            color:#444; font-size:14px; }
.note { color:var(--muted); font-size:14px; }
.scroll { overflow-x:auto; }
@media (max-width:760px){ .layout{display:block;} nav.side{width:auto;border-right:none;
  border-bottom:1px solid var(--line);} main{padding:24px 18px 60px;} }
`;

const SCRIPT = `
document.querySelectorAll('nav.side a').forEach(function (a) {
  if (a.getAttribute('href') === location.pathname.split('/').pop()) a.classList.add('active');
});
`;

function page(model: ReportModel, title: string, body: string, pages: readonly string[][]): string {
  const nav = pages
    .map(([file, label]) => `<a href="${escapeHtml(file!)}">${escapeHtml(label!)}</a>`)
    .join("\n      ");

  return `<!doctype html>
<html lang="${escapeHtml(model.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(model.projectName)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="layout">
  <nav class="side">
    <h2>${escapeHtml(model.projectName)}</h2>
      ${nav}
  </nav>
  <main>
${body}
  </main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function toc(entries: readonly string[][], label: string): string {
  if (entries.length < 4) return "";
  const items = entries
    .map(([id, text]) => `<li><a href="#${escapeHtml(id!)}">${escapeHtml(text!)}</a></li>`)
    .join("");
  return `<div class="toc"><h2>${escapeHtml(label)}</h2><ul>${items}</ul></div>`;
}

function severityLabel(severity: Severity, s: ReturnType<typeof stringsFor>): string {
  if (severity === "concern") return s.severityConcern;
  if (severity === "notice") return s.severityNotice;
  return s.severityInfo;
}

function overviewPage(model: ReportModel, pages: readonly string[][]): RenderedPage {
  const s = stringsFor(model.language);
  const d = model.dispositions;

  const rootRows = model.roots
    .map(
      (root) =>
        `<tr><td>${escapeHtml(root.name)}</td><td>${escapeHtml(root.language ?? "—")}</td>` +
        `<td>${root.analyzed}</td><td>${root.excluded}</td></tr>`,
    )
    .join("");

  // Rendered as a readable list first and a Mermaid source block second. The
  // report must open from disk with no network, so pulling a diagram library
  // from a CDN is not an option; the source stays available for anyone who
  // wants to paste it into a tool that draws it.
  const mermaidSource = [
    "graph LR",
    ...model.integrations.map(
      (i) => `  ${mermaidLabel(i.from)} -->|"${i.calls}"| ${mermaidLabel(i.to)}`,
    ),
  ].join("\n");

  const diagram =
    model.integrations.length > 0
      ? `<ul>${model.integrations
          .map(
            (i) =>
              `<li><strong>${escapeHtml(i.from)}</strong> → <strong>${escapeHtml(i.to)}</strong> · ${i.calls} ${escapeHtml(s.calls)}</li>`,
          )
          .join("")}</ul>
      <details><summary class="note">Mermaid</summary>
      <div class="scroll"><pre class="mermaid">${escapeHtml(mermaidSource)}</pre></div></details>`
      : `<p class="note">${escapeHtml(s.noIntegrations)}</p>`;

  const sections: string[][] = [
    ["roots", s.roots],
    ["integrations", s.integrations],
    ["disposition", s.dispositionTitle],
    ["health", s.health],
    ["coverage", s.coverage],
  ];

  const body = `
    <h1>${escapeHtml(model.projectName)}</h1>
    <p class="meta">${escapeHtml(s.run)}: ${escapeHtml(model.runId)} · ${escapeHtml(s.generated)}: ${escapeHtml(model.generatedAt)}</p>
    ${model.description ? `<p>${escapeHtml(model.description)}</p>` : ""}
    ${s.languageFallback ? `<p class="note">${escapeHtml(s.languageFallback)}</p>` : ""}
    ${toc(sections, s.contents)}

    <h2 id="roots">${escapeHtml(s.roots)}</h2>
    <div class="scroll"><table><thead><tr>
      <th>${escapeHtml(s.project)}</th><th>—</th><th>${escapeHtml(s.files)}</th><th>—</th>
    </tr></thead><tbody>${rootRows}</tbody></table></div>

    <h2 id="integrations">${escapeHtml(s.integrations)}</h2>
    ${diagram}

    <h2 id="disposition">${escapeHtml(s.dispositionTitle)}</h2>
    <div class="scroll"><table><tbody>
      <tr><td>${escapeHtml(s.behavioural)}</td><td>${d.behavioralSource}</td></tr>
      <tr><td>${escapeHtml(s.sharedInfrastructure)}</td><td>${d.sharedInfrastructure}</td></tr>
      <tr><td>${escapeHtml(s.technicalOnly)}</td><td>${d.technicalOnly}</td></tr>
      <tr><td>${escapeHtml(s.unclassified)}</td><td>${d.unclassified}</td></tr>
    </tbody></table></div>

    <h2 id="health">${escapeHtml(s.health)}</h2>
    ${model.signals
      .map(
        (signal) => `<div class="card ${escapeHtml(signal.severity)}">
      <span class="tag">${escapeHtml(severityLabel(signal.severity, s))}</span>
      <h3>${escapeHtml(signal.title)}</h3>
      <p>${escapeHtml(signal.finding)}</p>
      ${
        signal.evidence.length === 0
          ? ""
          : `<ul class="note">${signal.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      }
    </div>`,
      )
      .join("\n")}

    <h2 id="coverage">${escapeHtml(s.coverage)}</h2>
    <p class="note">${escapeHtml(s.whatWeCouldNotSee)}</p>
    ${
      model.coverageNotes.length === 0
        ? ""
        : `<ul>${model.coverageNotes
            .map((note) => `<li><strong>${escapeHtml(note.subject)}</strong> — ${escapeHtml(note.note)}</li>`)
            .join("")}</ul>`
    }
  `;

  return { filename: "index.html", title: s.overview, html: page(model, s.overview, body, pages) };
}

function modulesPage(model: ReportModel, pages: readonly string[][]): RenderedPage {
  const s = stringsFor(model.language);

  const body =
    model.modules.length === 0
      ? `<h1>${escapeHtml(s.modules)}</h1><p class="note">${escapeHtml(s.noModules)}</p>`
      : `
    <h1>${escapeHtml(s.modules)}</h1>
    <p class="meta">${escapeHtml(s.run)}: ${escapeHtml(model.runId)}</p>
    ${toc(model.modules.map((m) => [m.id, m.name]), s.contents)}
    ${model.modules
      .map(
        (module) => `<div class="card" id="${escapeHtml(module.id)}">
      <h3>${escapeHtml(module.name)}</h3>
      <p class="note">${escapeHtml(s.partOf)}: ${escapeHtml(module.rootNames.join(", "))}</p>
      <p class="note">${escapeHtml(s.entryPoints)}: ${module.entryPoints.length}</p>
      ${module.evidence
        .slice(0, 5)
        .map((text) => `<p class="evidence">${escapeHtml(text)}</p>`)
        .join("")}
    </div>`,
      )
      .join("\n")}`;

  return { filename: "features.html", title: s.modules, html: page(model, s.modules, body, pages) };
}

function componentsPage(model: ReportModel, pages: readonly string[][]): RenderedPage {
  const s = stringsFor(model.language);

  const rows = model.components
    .map(
      (component) =>
        `<tr><td>${escapeHtml(component.name)}</td><td>${escapeHtml(component.rootName)}</td>` +
        `<td>${component.memberCount}</td><td>${escapeHtml(component.signals.join("; "))}</td></tr>`,
    )
    .join("");

  const body =
    model.components.length === 0
      ? `<h1>${escapeHtml(s.components)}</h1><p class="note">${escapeHtml(s.noComponents)}</p>`
      : `<h1>${escapeHtml(s.components)}</h1>
    <p class="meta">${escapeHtml(s.run)}: ${escapeHtml(model.runId)}</p>
    <div class="scroll"><table><thead><tr>
      <th>${escapeHtml(s.components)}</th><th>${escapeHtml(s.project)}</th>
      <th>${escapeHtml(s.files)}</th><th>${escapeHtml(s.evidence)}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;

  return {
    filename: "components.html",
    title: s.components,
    html: page(model, s.components, body, pages),
  };
}

export function renderHtmlReport(model: ReportModel): readonly RenderedPage[] {
  const s = stringsFor(model.language);
  const pages: string[][] = [
    ["index.html", s.overview],
    ["features.html", s.modules],
    ["components.html", s.components],
  ];

  return [overviewPage(model, pages), modulesPage(model, pages), componentsPage(model, pages)];
}
