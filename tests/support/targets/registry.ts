import type { TargetDefinition } from "./types.js";

/**
 * Known analysis targets.
 *
 * These are real projects on the developer's machine, not fixtures. Analyzing
 * a *new* project never requires an entry here — the registry exists so tests
 * and development commands have stable names for the projects we grade
 * against.
 *
 * Paths change per machine; override any of them with the environment variable
 * reported by `envVarFor(id)`.
 */
export const TARGETS: readonly TargetDefinition[] = [
  {
    id: "wcp-v2",
    defaultPath: "~/Documents/WCP-V2",
    roots: ["wcp-ui", "wcp-service", "wcp-service-v2", "wcp_review_service", "wcp-auth"],
    vcs: "git",
    covers:
      "git roots, TypeScript and Go, both route-definition styles, " +
      "cross-root calls with templated paths and a base-URL constant",
  },
  {
    id: "angels-pizza",
    defaultPath: "~/Documents/angels-pizza",
    roots: [
      "web-admin",
      "ionic-vue",
      "web-vue",
      "kitchen",
      "backend",
      "admin-backend",
      "rider-app",
    ],
    vcs: "none",
    covers:
      "roots with no version control, a different root count, " +
      "JavaScript/JSX and Vue",
  },
];

/** The environment variable that overrides a target's path. */
export function envVarFor(id: string): string {
  return `PA_TARGET_${id.toUpperCase().replaceAll("-", "_")}`;
}

export function findTarget(id: string): TargetDefinition | undefined {
  return TARGETS.find((t) => t.id === id);
}

export function targetIds(): readonly string[] {
  return TARGETS.map((t) => t.id);
}
