/**
 * Observing validation and authorization generically, so the boundary deriver has
 * genuine facts to build from (PI-86).
 *
 * The boundary deriver (`boundary-derive.ts`) turns validation and auth records into
 * `validation-rule` and `auth-annotation` facts, but only the conventions enricher
 * ever produced those records — a validator decorator, a middleware name. The rules
 * a service actually enforces in the body of a handler — an `if` that rejects with a
 * message, an `if role == Admin` gate — reached the model only as guards and value
 * references, never as validation or auth. This lifts them, keyed on nothing but the
 * shape of the code and the project's own value sets.
 *
 * Two complements of the same evidence:
 *   - A guard that rejects *with a stated message* (PI-37) is a validation rule: the
 *     message is the rule in the code's own words. The signal is already extracted;
 *     this is the pure promotion of it.
 *   - A value-set member of a *role* set — a set whose name carries access-control
 *     vocabulary — *read* in a comparison or handed to a call is an authorization
 *     check. That is the read/decision complement of the state observer's write test
 *     (PI-83): where a member *assigned* is a state change, a member *compared or
 *     tested* is a permission gate. A member on the value side of an assignment, or a
 *     keyed composite value (`RoleID: Employee`), is a role *assignment*, not a check,
 *     and is excluded — the write branch, which is the state observer's territory.
 *
 * No project symbol, file or constant is named here: the role vocabulary is generic
 * access-control words, and the members come from whatever the project declares.
 *
 * Determinism: roots are walked in name order, files in path order, role sets by
 * name and their members by name; each file's AST is walked in document order;
 * identical observations on one span collapse; and the output is sorted by location
 * and requirement. A read that throws becomes a machine-neutral note, never a thrown
 * run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SgNode } from "@ast-grep/napi";

import { languageOf, parseSource } from "../text/ast.js";
import { offsetRef, resolved } from "../structural/provenance.js";
import { nameTokens, type ValueSet } from "../semantics/enums.js";
import type { AuthAnnotationRecord } from "../structural/boundaries.js";
import type { GuardRecord, ValidationRuleRecord } from "../structural/rules.js";
import type { RootFacts } from "./extract.js";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Part A — validation promoter.
// ---------------------------------------------------------------------------

/**
 * Promote guards that reject with a stated message into validation rules.
 *
 * A guard whose rejection carries a message a human wrote (`messageKind ===
 * "stated"`) is a validation rule stated in the code's own words. Two filters keep
 * it honest: the guard must actually *reject* (`rejects`) — a branch that returns a
 * display label or a query builder carries a message that is data, not a rule; and
 * an error-code guard is left out, because a symbol quoted as a rule tells a reader
 * nothing they can act on and `condition`/`decision` already carry it. Generic — it
 * keys on the shape of the rejection, not on any helper name, so it fires on Go and
 * JS/TS alike.
 */
export function promoteGuardValidations(guards: readonly GuardRecord[]): ValidationRuleRecord[] {
  const out: ValidationRuleRecord[] = [];
  for (const g of guards) {
    if (g.messageKind !== "stated" || !g.rejects) continue;
    out.push({
      rootName: g.rootName,
      subjectSymbolId: null,
      field: null,
      rule: g.message,
      expression: g.test ?? null,
      source: g.source,
      provenance: g.provenance,
    });
  }
  out.sort(
    (a, b) =>
      cmp(a.rootName, b.rootName) ||
      cmp(a.source.relPath, b.source.relPath) ||
      (a.source.startLine ?? 0) - (b.source.startLine ?? 0) ||
      (a.source.startColumn ?? 0) - (b.source.startColumn ?? 0) ||
      cmp(a.rule, b.rule),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Part B — authorization observer.
// ---------------------------------------------------------------------------

export interface AuthorizationObserveInput {
  readonly roots: readonly RootFacts[];
  readonly valueSets: readonly ValueSet[];
  /** rootName → absolute path, so a root's own files can be read. */
  readonly rootPaths?: ReadonlyMap<string, string>;
}

export interface AuthorizationObserveResult {
  readonly auth: readonly AuthAnnotationRecord[];
  /** Files that could not be read or scanned — an absence accounted for, not hidden. */
  readonly notes: readonly string[];
}

/**
 * Generic access-control vocabulary. A value set whose name carries one of these
 * words types a role/permission, whatever the project calls it — WCP's `RoleC` (name
 * token "role") qualifies. Mirrors `boundary-derive.ts`'s AUTHN_TOKENS: our own
 * judgement about what a value set *is*, never a project's own role names.
 */
const ACCESS_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  "role", "roles", "permission", "permissions", "scope", "scopes",
  "grant", "privilege", "authority", "acl",
]);

/** A leaf that can carry a value set member's name, per language. */
const REFERENCE_LEAF_KINDS = new Set<string>(["identifier", "field_identifier", "property_identifier"]);
/** `a.b` — Go `selector_expression`, JS/TS `member_expression`. */
const SELECTOR_KINDS = new Set<string>(["selector_expression", "member_expression"]);
const CALL_KINDS = new Set<string>(["call_expression", "call"]);
/** Comparison operators that make a member reference a role decision, both grammars. */
const COMPARISON_OPS = new Set<string>(["==", "!=", "===", "!=="]);
/**
 * Library-standard formatting/logging/serialization sinks. A role member handed to
 * one of these — `log.Info("role", AdminC)`, `fmt.Sprintf("%s", AdminF.String())`,
 * `json.Marshal(AdminC)` — is being printed or serialized, not checked. The call
 * argument is a weaker signal than a comparison, so this blocklist excludes the
 * common non-auth sinks; genuine membership calls (`funk.Contains`,
 * `HasPermissionWithRoles`) and every comparison keep emitting. Library vocabulary
 * matched on the call's method/function name, never a project symbol — the same
 * basis the state observer uses for its ORM read verbs.
 */
const NON_AUTH_CALLEES: ReadonlySet<string> = new Set([
  // logging
  "log", "logger", "info", "debug", "warn", "warning", "error", "trace",
  "print", "printf", "println", "sprint", "fatal", "fatalf", "panic", "panicf",
  // formatting
  "sprintf", "sprintln", "errorf", "format", "fprintf", "printfln",
  // serialization
  "marshal", "marshalindent", "unmarshal", "stringify", "json", "encode", "decode",
]);
/**
 * Wrappers and containers that pass a value through unchanged, so the context that
 * decides check-vs-assignment is the one around them: `(M)`, `M.String()`'s receiver
 * chain, a Go `expression_list`, a TS cast, and the composite-literal layers an
 * unkeyed role list (`[]RoleC{Admin, HR}`, `[Role.Admin]`) sits inside.
 */
const TRANSPARENT_KINDS = new Set<string>([
  "parenthesized_expression",
  "expression_list",
  "type_conversion_expression",
  "type_assertion_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
  "unary_expression",
  "literal_value",
  "composite_literal",
  "array",
]);

/** Two nodes are the same span — used in place of reference equality. */
function sameNode(a: SgNode, b: SgNode): boolean {
  const ra = a.range();
  const rb = b.range();
  return ra.start.index === rb.start.index && ra.end.index === rb.end.index;
}

function fieldNode(node: SgNode, name: string): SgNode | null {
  const value = node.field(name);
  return value === undefined ? null : value;
}

/** The lowercased final segment of the callee of the call whose arguments node this is. */
function enclosingCallMethod(argsNode: SgNode): string | null {
  const call = argsNode.parent();
  if (call === null || !CALL_KINDS.has(call.kind() as string)) return null;
  const callee = fieldNode(call, "function")?.text() ?? "";
  if (callee === "") return null;
  return (callee.split(".").pop() ?? callee).toLowerCase();
}

function setKey(set: ValueSet): string {
  return `${set.rootName}\0${set.relPath}\0${String(set.startLine)}\0${set.name}`;
}

/**
 * The value sets a project uses as roles/permissions.
 *
 * Keyed on the access-control vocabulary in the set's own name, not on any project
 * role name: a set eligible exactly when a token of its name is a generic
 * access-control word. Returned in a stable order.
 */
export function roleValueSets(valueSets: readonly ValueSet[]): readonly ValueSet[] {
  const sets = valueSets.filter((set) =>
    nameTokens(set.name).some((token) => ACCESS_CONTROL_TOKENS.has(token)),
  );
  return [...sets].sort((a, b) => cmp(setKey(a), setKey(b)));
}

/**
 * The reference expression a member-named leaf belongs to: the whole `pkg.Member` /
 * `Enum.Member` when the leaf is the qualifying field, else the bare leaf. This is
 * the node whose surrounding context decides check-vs-assignment.
 */
function referenceExpression(leaf: SgNode): SgNode {
  const parent = leaf.parent();
  if (parent !== null && SELECTOR_KINDS.has(parent.kind() as string)) {
    const field = fieldNode(parent, "field") ?? fieldNode(parent, "property");
    if (field !== null && sameNode(field, leaf)) return parent;
  }
  return leaf;
}

/**
 * Whether a role-member reference sits in an authorization *check* — a comparison or
 * a call — rather than being *assigned*. Climbs out through selector receiver chains
 * and value-preserving wrappers and classifies at the first structural parent that
 * settles it.
 *
 * A check is a member compared with `==`/`!=` (`role == Admin`), or handed to a call
 * — directly (`Contains(roles, Admin.String())`, through the `.String()` receiver
 * chain) or inside an unkeyed composite that is itself a call argument
 * (`HasPermissionWithRoles(id, []RoleC{Admin, HR})`). Deliberately NOT a member on
 * the value side of an assignment (`role = Admin`) or a keyed composite value
 * (`RoleID: Employee`): those are role *assignments*, the write branch PI-83 owns,
 * and a check asserted from one would be a false fact.
 */
function isRoleCheckContext(ref: SgNode): boolean {
  let child = ref;
  let parent = child.parent();

  while (parent !== null) {
    const kind = parent.kind() as string;

    // A comparison operand — a role decision. Only equality/inequality; a member in
    // an arithmetic operand is not a role test.
    if (kind === "binary_expression") {
      const operator = fieldNode(parent, "operator")?.text() ?? "";
      return COMPARISON_OPS.has(operator.trim());
    }

    // Handed to a call as an argument — a role-membership check, unless the callee is
    // a formatting/logging/serialization sink, where the member is printed, not
    // checked. The call argument is a weaker signal than a comparison, so this
    // excludes the common non-auth sinks while genuine membership calls keep emitting.
    if (kind === "argument_list" || kind === "arguments") {
      const method = enclosingCallMethod(parent);
      return method === null || !NON_AUTH_CALLEES.has(method);
    }

    // The member is the callee's own receiver chain (`Admin.String()`) — transparent.
    if (CALL_KINDS.has(kind)) {
      const fn = fieldNode(parent, "function");
      if (fn !== null && sameNode(fn, child)) {
        child = parent;
        parent = parent.parent();
        continue;
      }
      return false;
    }

    // Selector receiver chain (`constant.Admin`, `Role.Admin`) and value-preserving
    // wrappers — climb.
    if (SELECTOR_KINDS.has(kind) || TRANSPARENT_KINDS.has(kind)) {
      child = parent;
      parent = parent.parent();
      continue;
    }

    // A Go composite element: an unkeyed one (a bare `literal_element` under a
    // `literal_value`) is a role list — climb so the enclosing context decides; a
    // keyed value (`RoleID: Employee`, whose element's parent is a `keyed_element`)
    // is a role assignment — excluded.
    if (kind === "literal_element") {
      const grandparent = parent.parent();
      if (grandparent !== null && (grandparent.kind() as string) === "keyed_element") return false;
      child = parent;
      parent = parent.parent();
      continue;
    }

    // A keyed composite value — Go `keyed_element`, JS `pair` — is an assignment.
    if (kind === "keyed_element" || kind === "pair") return false;

    // Assignment / declaration value side — a role assignment, the write branch.
    if (
      kind === "assignment_statement" ||
      kind === "short_var_declaration" ||
      kind === "assignment_expression" ||
      kind === "augmented_assignment_expression" ||
      kind === "variable_declarator"
    ) {
      return false;
    }

    // Anything else — an index, a return, a statement — is not a recognized check.
    return false;
  }
  return false;
}

/**
 * The authorization checks observable in one file's source, fs-free so it is unit
 * testable. `roleSets` are the access-control value sets; a member of one *read* in a
 * comparison or a call becomes a role-membership annotation.
 */
export function observeAuthInFile(
  rootName: string,
  relPath: string,
  content: string,
  roleSets: readonly ValueSet[],
): readonly AuthAnnotationRecord[] {
  const language = languageOf(relPath);
  if (language === null) return [];
  const parsed = parseSource(language, content);
  if (parsed.root === null) return [];

  // member name → the role member names it may resolve to, in a stable order, so a
  // name shared by two role sets resolves the same way every run. Value irrelevant:
  // the requirement is the member *name* the code names.
  const members = new Set<string>();
  for (const set of [...roleSets].sort((a, b) => cmp(setKey(a), setKey(b)))) {
    for (const member of [...set.members].sort((a, b) => cmp(a.name, b.name))) {
      members.add(member.name);
    }
  }
  if (members.size === 0) return [];

  const out: AuthAnnotationRecord[] = [];
  const seen = new Set<string>();

  const visit = (node: SgNode): void => {
    if (REFERENCE_LEAF_KINDS.has(node.kind() as string) && members.has(node.text())) {
      const ref = referenceExpression(node);
      if (isRoleCheckContext(ref)) {
        const source = offsetRef(rootName, relPath, content, ref.range().start.index);
        const key = [relPath, source.startLine, source.startColumn, node.text()].join("\0");
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            rootName,
            symbolId: null,
            mechanism: "role-membership",
            requirement: node.text(),
            source,
            provenance: resolved(source, "high"),
          });
        }
      }
    }
    for (const child of node.children()) visit(child);
  };
  visit(parsed.root);

  out.sort(compareAuth);
  return out;
}

function compareAuth(a: AuthAnnotationRecord, b: AuthAnnotationRecord): number {
  return (
    cmp(a.rootName, b.rootName) ||
    cmp(a.source.relPath, b.source.relPath) ||
    (a.source.startLine ?? 0) - (b.source.startLine ?? 0) ||
    (a.source.startColumn ?? 0) - (b.source.startColumn ?? 0) ||
    cmp(a.requirement ?? "", b.requirement ?? "")
  );
}

/**
 * Observe authorization checks across every root, reading each root's own analyzed
 * files from disk. Fails open per file: a read or scan error is disclosed as a
 * machine-neutral note and the pass continues, never throwing an otherwise-complete
 * run down.
 */
export function observeAuthorization(input: AuthorizationObserveInput): AuthorizationObserveResult {
  const roleSets = roleValueSets(input.valueSets);
  const notes: string[] = [];
  const auth: AuthAnnotationRecord[] = [];
  if (roleSets.length === 0) return { auth, notes };

  const roots = [...input.roots].sort((a, b) => cmp(a.rootName, b.rootName));
  for (const root of roots) {
    const roleSetsForRoot = roleSets.filter((set) => set.rootName === root.rootName);
    if (roleSetsForRoot.length === 0) continue;
    const rootPath = input.rootPaths?.get(root.rootName);
    if (rootPath === undefined) {
      notes.push(`authorization observer: no path for root ${root.rootName}; its files were not scanned`);
      continue;
    }
    for (const relPath of [...root.analyzedFiles].sort(cmp)) {
      let content: string;
      try {
        content = readFileSync(join(rootPath, relPath), "utf8");
      } catch (error) {
        // Only the repo-relative identity and a machine-neutral error kind — never
        // the raw fs message, which carries the absolute path and would make a
        // persisted diagnostic diverge across machines.
        notes.push(`authorization observer: could not read ${root.rootName}/${relPath}: ${error instanceof Error ? error.name : "read error"}`);
        continue;
      }
      try {
        auth.push(...observeAuthInFile(root.rootName, relPath, content, roleSetsForRoot));
      } catch (error) {
        notes.push(`authorization observer: could not scan ${root.rootName}/${relPath}: ${error instanceof Error ? error.name : "scan error"}`);
      }
    }
  }

  auth.sort(compareAuth);
  notes.sort(cmp);
  return { auth, notes };
}
