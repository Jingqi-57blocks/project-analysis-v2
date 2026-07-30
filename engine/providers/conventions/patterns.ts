/**
 * Declarative patterns — business logic that is stated rather than executed.
 *
 * Every pattern matches a declaration: an annotation, a decorator, a struct
 * tag, a call to a well-known API. Statement-level control flow stays out,
 * since it needs per-language AST work and would arrive as a new provider.
 *
 * Nothing here is ever `declared`: a regex cannot know whether a match is real
 * code, a comment, or a string, so every record is `inferred` with a
 * confidence that consumers can filter on.
 *
 * Adding a language means adding entries here and nothing else.
 */

import type { Confidence } from "../../structural/provenance.js";
import type { StructuralKind } from "../../structural/kinds.js";

export interface DeclarativePattern {
  /** Which model kind a match produces. */
  readonly kind: Extract<
    StructuralKind,
    | "validation-rule"
    | "transaction-boundary"
    | "error-handling"
    | "auth-annotation"
    | "data-access"
    | "scheduled-task"
    | "notification-call"
  >;
  /** File extensions this applies to. Empty means any. */
  readonly extensions: readonly string[];
  readonly pattern: RegExp;
  /** A short name for what was matched, used as the record's mechanism or rule. */
  readonly label: string;
  readonly confidence: Confidence;
  /** Which capture group holds the interesting detail, if any. */
  readonly detailGroup?: number;
  /** For notification-call only: the channel the matched API implies. */
  readonly channel?: "mail" | "chat" | "push" | "unknown";
}

/**
 * Confidence reflects how specific the evidence is: `binding:"required"` is
 * unambiguous, a bare `.Find(` could be any method of that name.
 */
export const DECLARATIVE_PATTERNS: readonly DeclarativePattern[] = [
  // ---- validation ----
  {
    kind: "validation-rule",
    extensions: [".go"],
    pattern: /binding:"([^"]+)"/g,
    label: "binding",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "validation-rule",
    extensions: [".go"],
    pattern: /validate:"([^"]+)"/g,
    label: "validate",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "validation-rule",
    extensions: [".ts", ".js"],
    // class-validator and similar decorator libraries.
    pattern: /@(Is[A-Z]\w*|Min|Max|Length|IsNotEmpty|IsOptional)\s*\(/g,
    label: "decorator",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "validation-rule",
    extensions: [".java", ".kt"],
    pattern: /@(NotNull|NotBlank|NotEmpty|Size|Valid|Pattern|Email)\b/g,
    label: "bean-validation",
    confidence: "high",
    detailGroup: 1,
  },

  // ---- transactions ----
  {
    kind: "transaction-boundary",
    extensions: [".java", ".kt"],
    pattern: /@Transactional\b/g,
    label: "@Transactional",
    confidence: "high",
  },
  {
    kind: "transaction-boundary",
    extensions: [".go"],
    pattern: /\.Begin(?:Tx)?\s*\(/g,
    label: "Begin",
    confidence: "medium",
  },
  {
    kind: "transaction-boundary",
    extensions: [".go", ".ts", ".js"],
    pattern: /\.[Tt]ransaction\s*\(/g,
    label: "transaction",
    confidence: "medium",
  },

  // ---- error handling ----
  {
    kind: "error-handling",
    extensions: [".go"],
    pattern: /if\s+err\s*!=\s*nil\s*\{/g,
    label: "err-check",
    confidence: "high",
  },
  {
    kind: "error-handling",
    extensions: [".ts", ".js", ".java", ".kt", ".py", ".rb", ".swift"],
    pattern: /\bcatch\b\s*[({]/g,
    label: "catch",
    confidence: "high",
  },
  {
    kind: "error-handling",
    extensions: [".py"],
    pattern: /^\s*except\b/gm,
    label: "except",
    confidence: "high",
  },

  // ---- auth ----
  {
    kind: "auth-annotation",
    extensions: [".ts", ".js"],
    pattern: /@(UseGuards|Roles|Authenticated|RequirePermission)\s*\(([^)]*)\)/g,
    label: "guard",
    confidence: "high",
    detailGroup: 2,
  },
  {
    kind: "auth-annotation",
    extensions: [".java", ".kt"],
    pattern: /@(PreAuthorize|Secured|RolesAllowed)\s*\(([^)]*)\)/g,
    label: "spring-security",
    confidence: "high",
    detailGroup: 2,
  },
  {
    kind: "auth-annotation",
    extensions: [".go"],
    // Go has no auth annotation, so the only textual signal is a call to
    // something named for authentication.
    //
    // Measured on a real Go auth service: this produced 60 matches across 44
    // files, because in a service whose whole job is authentication almost
    // every function has "Auth" in its name. Name alone cannot separate
    // middleware from handler. Kept at low confidence rather than removed —
    // it is genuine weak evidence, and the declared limit below tells a
    // consumer not to count it.
    pattern: /\b(\w*(?:Auth|Authorize|Authenticate|RequireLogin)\w*)\s*\(/g,
    label: "auth-middleware",
    confidence: "low",
    detailGroup: 1,
  },

  // ---- scheduled work ----
  // Calibrated against the real targets: `schedule.scheduleJob('Check-Mail',
  // '30 * * * * *', fn)` and robfig/cron's `c.AddFunc("@every 5m", fn)`.
  // The detail keeps the first literal argument — a job name or a schedule —
  // when one is written; a spec read from configuration stays null.
  {
    kind: "scheduled-task",
    extensions: [".ts", ".js"],
    pattern: /\.scheduleJob\s*\(\s*['"]([^'"]+)['"]/g,
    label: "scheduleJob",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "scheduled-task",
    extensions: [".ts", ".js"],
    pattern: /\bcron\.schedule\s*\(\s*['"]([^'"]+)['"]/g,
    label: "cron.schedule",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "scheduled-task",
    extensions: [".ts", ".js"],
    pattern: /new\s+CronJob\s*\(\s*['"]([^'"]+)['"]/g,
    label: "CronJob",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "scheduled-task",
    extensions: [".go"],
    pattern: /\.AddFunc\s*\(\s*(?:"([^"]+)")?/g,
    label: "AddFunc",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "scheduled-task",
    extensions: [".java", ".kt"],
    pattern: /@Scheduled\s*\(([^)]*)\)/g,
    label: "@Scheduled",
    confidence: "high",
    detailGroup: 1,
  },
  {
    kind: "scheduled-task",
    extensions: [".ts", ".js"],
    // Polling loops are scheduling too, but the interval is in milliseconds
    // buried in an argument, and the same call drives UI animation. Weak.
    pattern: /\bsetInterval\s*\(/g,
    label: "setInterval",
    confidence: "low",
  },

  // ---- notifications ----
  {
    kind: "notification-call",
    extensions: [".ts", ".js"],
    // nodemailer and its many wrappers.
    pattern: /\.sendMail\s*\(/g,
    label: "sendMail",
    confidence: "high",
    channel: "mail",
  },
  {
    kind: "notification-call",
    extensions: [".ts", ".js"],
    // Firebase Cloud Messaging: `admin.messaging().send(...)`.
    pattern: /\.messaging\s*\(\s*\)\s*\.\s*send\w*\s*\(/g,
    label: "messaging().send",
    confidence: "high",
    channel: "push",
  },
  {
    kind: "notification-call",
    extensions: [".go"],
    pattern: /\bsmtp\.SendMail\s*\(/g,
    label: "smtp.SendMail",
    confidence: "high",
    channel: "mail",
  },
  {
    kind: "notification-call",
    extensions: [".go"],
    // slack-go's client.
    pattern: /\w+\.PostMessage\s*\(/g,
    label: "PostMessage",
    confidence: "medium",
    channel: "chat",
  },
  {
    kind: "notification-call",
    extensions: [".go", ".ts", ".js"],
    // Named-for-notification calls — a project's own mail/push helpers. Name
    // alone cannot separate the sender from a caller of the sender, so this
    // stays weak evidence, the same stance as the Go auth pattern above.
    pattern: /\b\w*(?:SendEmail|SendSlackMessage|SendPush|sendNotification|notifyUser)\w*\s*\(/g,
    label: "notify-helper",
    confidence: "low",
    channel: "unknown",
  },

  // ---- data access ----
  {
    kind: "data-access",
    extensions: [],
    // Raw SQL is unambiguous about intent even when the entity is not resolvable.
    pattern: /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/g,
    label: "sql",
    confidence: "medium",
    detailGroup: 1,
  },
  {
    kind: "data-access",
    extensions: [".go"],
    pattern: /\.(Find|First|Create|Save|Updates?|Delete|Where)\s*\(/g,
    label: "orm",
    confidence: "low",
    detailGroup: 1,
  },
  {
    kind: "data-access",
    extensions: [".ts", ".js"],
    pattern: /\.(findOne|findMany|findAll|createQueryBuilder|insertInto|deleteFrom)\s*\(/g,
    label: "orm",
    confidence: "low",
    detailGroup: 1,
  },
];

/** Patterns applying to a file, by extension. */
export function patternsFor(extension: string): readonly DeclarativePattern[] {
  return DECLARATIVE_PATTERNS.filter(
    (pattern) => pattern.extensions.length === 0 || pattern.extensions.includes(extension),
  );
}

/** Every kind this provider can produce, for capability declaration. */
export const SUPPORTED_KINDS = [
  ...new Set(DECLARATIVE_PATTERNS.map((pattern) => pattern.kind)),
] as const;
