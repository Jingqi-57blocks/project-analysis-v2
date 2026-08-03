/**
 * Observing state changes generically, so the state deriver has transitions to
 * build from (PI-83).
 *
 * The state deriver (`state-derive.ts`) turns an observed change of a status
 * field into a `transition` fact, but nothing produced those observations from a
 * real analysis — `BehaviorStateInput.changes` was always empty, so every
 * transition the truth ledger expects stayed missing. This reads them out of the
 * source directly, keyed on nothing but the project's own extracted value sets.
 *
 * What makes a value set a *state* machine is not the words "status" or "state":
 * it is that the code compares a field against one of its members. That is the
 * same evidence the deriver uses to promote a member to a state, reused here as
 * the eligibility test — a value set no comparison resolves into is a plain
 * vocabulary and is never scanned. Within an eligible set, a member *name* seen
 * in a write or value context — an assignment right-hand side, a `:=`, a keyed
 * composite-literal value, a call argument — is a change *into* that member; a
 * member read in a comparison, or listed in an unkeyed slice, is not. No project
 * symbol, file or constant is named in this file: it works on whatever the
 * project happens to call its states.
 *
 * Determinism: roots are walked in name order, files in path order, a set's
 * members in name order; each file's AST is walked in document order; identical
 * observations on one span collapse; and the output is sorted by location and
 * value. A read that throws — a file gone between inventory and here, a grammar
 * that will not parse — becomes a note, never a thrown run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SgNode } from "@ast-grep/napi";

import { enclosingFunctionName, languageOf, parseSource } from "../text/ast.js";
import { offsetRef } from "../structural/provenance.js";
import { resolveValue, type ValueSet, type ValueSetMember } from "../semantics/enums.js";
import type { ConditionRecord } from "../structural/rules.js";
import type { RootFacts } from "./extract.js";
import type { StateChangeObservation } from "./state-derive.js";

export interface StateTransitionObserveInput {
  readonly roots: readonly RootFacts[];
  readonly valueSets: readonly ValueSet[];
  readonly conditions: readonly ConditionRecord[];
  /** rootName → absolute path, so a root's own files can be read. */
  readonly rootPaths?: ReadonlyMap<string, string>;
}

export interface StateTransitionObserveResult {
  readonly changes: readonly StateChangeObservation[];
  /** Files that could not be read or scanned — an absence accounted for, not hidden. */
  readonly notes: readonly string[];
}

/** A leaf that can carry a value set member's name, per language. */
const REFERENCE_LEAF_KINDS = new Set<string>(["identifier", "field_identifier", "property_identifier"]);
/** `a.b` — Go `selector_expression`, JS/TS `member_expression`. */
const SELECTOR_KINDS = new Set<string>(["selector_expression", "member_expression"]);
const CALL_KINDS = new Set<string>(["call_expression", "call"]);

/**
 * Library-standard query/read builder verbs. A keyed composite value handed to one
 * of these (`Where(map{"status": M})`, `find({status: M})`) is a *filter*, not a
 * state write — the member is being matched, not assigned. This is ORM/SQL-builder
 * vocabulary (gorm, database/sql builders, Mongoose), never a project's own method
 * name, so keying on it is the same basis the notification-reachability deriver
 * uses for standard send sinks. A blocklist, so an unrecognized call defaults to a
 * write; write verbs (`Updates`, `Create`, `Save`) are deliberately absent — the
 * cron `Updates(map{"status": M})` must stay a genuine transition.
 */
const READ_BUILDER_METHODS = new Set<string>([
  // gorm / SQL query builders
  "where", "not", "or", "first", "find", "take", "last", "preload", "joins",
  "having", "group", "order", "limit", "offset", "count", "pluck", "scan",
  "select", "distinct",
  // Mongoose / JS document reads
  "findone", "findbyid", "countdocuments", "exists",
]);
/**
 * Wrappers that pass a value through unchanged, so the context that decides
 * read-vs-write is the one around them: `(M)`, `M.Uint8()`'s receiver chain, an
 * `expression_list` Go wraps an assignment side in, a TS `as`/`!` cast.
 */
const TRANSPARENT_WRAPPER_KINDS = new Set<string>([
  "parenthesized_expression",
  "expression_list",
  "type_conversion_expression",
  "type_assertion_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
  "unary_expression",
]);

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function setKey(set: ValueSet): string {
  return `${set.rootName}\0${set.relPath}\0${String(set.startLine)}\0${set.name}`;
}

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

/**
 * The value sets a project actually uses as states.
 *
 * Keyed on comparison evidence, not on the words a field is named with: a set is
 * eligible exactly when some condition resolves to one of its members — the same
 * promotion rule the state deriver applies. Returned in a stable order.
 */
export function eligibleStateSets(
  valueSets: readonly ValueSet[],
  conditions: readonly ConditionRecord[],
): readonly ValueSet[] {
  const eligible = new Map<string, ValueSet>();
  for (const condition of conditions) {
    const resolved = resolveValue(condition.subject, condition.literal, valueSets, condition.rootName);
    if (resolved !== null) eligible.set(setKey(resolved.set), resolved.set);
  }
  return [...eligible.values()].sort((a, b) => cmp(setKey(a), setKey(b)));
}

/**
 * The reference expression a member-named leaf belongs to: the whole `pkg.Member`
 * / `Enum.Member` when the leaf is the qualifying field, else the bare leaf. This
 * is the node whose surrounding context decides read-vs-write, and whose start is
 * the observation's location.
 */
function referenceExpression(leaf: SgNode): SgNode {
  const parent = leaf.parent();
  if (parent !== null && SELECTOR_KINDS.has(parent.kind() as string)) {
    const field = fieldNode(parent, "field") ?? fieldNode(parent, "property");
    if (field !== null && sameNode(field, leaf)) return parent;
  }
  return leaf;
}

/** The value literal_element of a Go `keyed_element` (`Key: Value`), or null. */
function goKeyedValueElement(keyed: SgNode): SgNode | null {
  const elements = keyed.children().filter((c) => (c.kind() as string) === "literal_element");
  // Exactly two: key then value. The value is the one after the colon.
  return elements.length >= 2 ? elements[elements.length - 1]! : null;
}

/** The method a call names: the final segment of a selector callee, or a bare name. */
function callMethodName(call: SgNode): string | null {
  const fn = fieldNode(call, "function");
  if (fn === null) return null;
  if (SELECTOR_KINDS.has(fn.kind() as string)) {
    const method = fieldNode(fn, "field") ?? fieldNode(fn, "property");
    return method === null ? null : method.text();
  }
  return fn.text();
}

/**
 * Whether the nearest call a keyed composite value is *handed to* is a query/read
 * builder (`Where`, `find`, …), which makes the value a filter, not a state write.
 * Climbs to the first enclosing call in whose arguments the value sits — a call on
 * which the value is only the receiver (`Model{...}.Save()`) is a construction, so
 * it is skipped. No enclosing call (a plain `x := Model{...}`) defaults to a write.
 */
function underReadBuilderCall(from: SgNode): boolean {
  let child = from;
  let current: SgNode | null = from.parent();
  while (current !== null) {
    if (CALL_KINDS.has(current.kind() as string)) {
      const fn = fieldNode(current, "function");
      // The value is the call's receiver, not an argument — a construction, keep going.
      if (fn !== null && sameNode(fn, child)) {
        child = current;
        current = current.parent();
        continue;
      }
      const method = callMethodName(current);
      return method !== null && READ_BUILDER_METHODS.has(method.toLowerCase());
    }
    child = current;
    current = current.parent();
  }
  return false;
}

/**
 * Whether a member reference sits in a write/value context — a change *into* the
 * member — rather than a read of it. Climbs out through value-preserving wrappers
 * and classifies at the first structural parent that settles the question.
 *
 * A write is a member on the value side of an assignment/declaration, or a keyed
 * value of a composite literal (`Model{Status: M}`, `map{"status": M}`) — a
 * record or update payload being built with that state. Deliberately NOT a bare
 * call argument: `updateLvStatus(tx, id, M)`, `Where("status = ?", M)`,
 * `Sprintf("%d", M)`, `Contains(list, M)` all hand the member to a call that as
 * often reads it (a query filter, a format arg) as writes it, and a to-only
 * transition asserted from a read is a false fact. The cited state writes survive
 * because the code also assigns them (`leave.Status = M`, `nextStatus := M`) or
 * builds them into an update map (`Updates(map{"status": M}`).
 *
 * The one exception to the keyed-value rule: a keyed value handed to a standard
 * query/read builder (`Where(map{"status": M})`, `find({status: M})`) is a filter,
 * not a write — see `READ_BUILDER_METHODS`. A `map{"status": M}` is otherwise
 * indistinguishable from an update payload, so the enclosing verb is the only
 * honest signal, and it is library vocabulary rather than a project name.
 */
function isWriteContext(ref: SgNode): boolean {
  let child = ref;
  let parent = child.parent();

  while (parent !== null) {
    const kind = parent.kind() as string;

    if (TRANSPARENT_WRAPPER_KINDS.has(kind) || SELECTOR_KINDS.has(kind)) {
      child = parent;
      parent = parent.parent();
      continue;
    }

    if (CALL_KINDS.has(kind)) {
      const fn = fieldNode(parent, "function");
      // The member is the callee's own receiver chain (`M.Uint8()`) — transparent.
      if (fn !== null && sameNode(fn, child)) {
        child = parent;
        parent = parent.parent();
        continue;
      }
      // Otherwise it is being handed to a call — as likely a read as a write.
      return false;
    }
    if (kind === "argument_list" || kind === "arguments") return false;

    // Assignment / declaration: a write only when the member is on the value side.
    if (kind === "assignment_statement" || kind === "short_var_declaration") {
      const right = fieldNode(parent, "right");
      return right !== null && sameNode(right, child);
    }
    if (kind === "assignment_expression" || kind === "augmented_assignment_expression") {
      const right = fieldNode(parent, "right");
      return right !== null && sameNode(right, child);
    }
    if (kind === "variable_declarator") {
      const value = fieldNode(parent, "value");
      return value !== null && sameNode(value, child);
    }

    // Keyed composite-literal value: `Field: M`, `"status": M`. The key is a read,
    // and a value handed to a query builder (`Where(map{"status": M})`) is a filter.
    if (kind === "pair") {
      const value = fieldNode(parent, "value");
      if (value === null || !sameNode(value, child)) return false;
      return !underReadBuilderCall(parent);
    }
    if (kind === "literal_element") {
      const grandparent = parent.parent();
      if (grandparent !== null && (grandparent.kind() as string) === "keyed_element") {
        const value = goKeyedValueElement(grandparent);
        if (value === null || !sameNode(value, parent)) return false;
        return !underReadBuilderCall(parent);
      }
      // A bare literal_element directly in a literal_value is an unkeyed slice/
      // array/struct element — membership-list noise, a read.
      return false;
    }

    // An array element (`[M, …]`) and a comparison/arithmetic operand are reads.
    // Anything else — a return, an index, a statement — is not a recognized write.
    return false;
  }
  return false;
}

/**
 * The state changes observable in one file's source, fs-free so it is unit
 * testable. `eligible` is the state-bearing value sets; a member of one appearing
 * in a write/value context becomes a to-only observation.
 */
export function observeChangesInFile(
  rootName: string,
  relPath: string,
  content: string,
  eligible: readonly ValueSet[],
): readonly StateChangeObservation[] {
  const language = languageOf(relPath);
  if (language === null) return [];
  const parsed = parseSource(language, content);
  if (parsed.root === null) return [];

  // A source root can only reference its own extracted vocabularies. Without
  // this boundary, two repositories that reuse a member name (for example
  // `Approved`) produce competing observations for the same source write.
  const localEligible = eligible.filter((set) => set.rootName === rootName);

  // member name → the (set, member) pairs that declare it, in a stable order, so
  // a name shared by two eligible sets resolves the same way every run.
  const byName = new Map<string, { set: ValueSet; member: ValueSetMember }[]>();
  for (const set of localEligible) {
    for (const member of set.members) {
      const list = byName.get(member.name) ?? [];
      list.push({ set, member });
      byName.set(member.name, list);
    }
  }
  if (byName.size === 0) return [];
  for (const list of byName.values()) {
    list.sort((a, b) => cmp(`${setKey(a.set)}\0${a.member.name}`, `${setKey(b.set)}\0${b.member.name}`));
  }

  const out: StateChangeObservation[] = [];
  const seen = new Set<string>();

  const visit = (node: SgNode): void => {
    if (REFERENCE_LEAF_KINDS.has(node.kind() as string)) {
      const pairs = byName.get(node.text());
      if (pairs !== undefined) {
        const ref = referenceExpression(node);
        if (isWriteContext(ref)) {
          const source = offsetRef(rootName, relPath, content, ref.range().start.index);
          const trigger = enclosingFunctionName(ref) ?? "<file-scope>";
          for (const { set, member } of pairs) {
            const key = [relPath, source.startLine, source.startColumn, set.name, String(member.value)].join("\0");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              rootName,
              field: set.name,
              fromValue: null,
              toValue: member.value,
              trigger,
              guard: null,
              source,
              valueSet: {
                rootName: set.rootName,
                relPath: set.relPath,
                startLine: set.startLine,
                name: set.name,
              },
            });
          }
        }
      }
    }
    for (const child of node.children()) visit(child);
  };
  visit(parsed.root);

  out.sort(compareObservations);
  return out;
}

function compareObservations(a: StateChangeObservation, b: StateChangeObservation): number {
  // rootName leads so observations from two roots that share a relPath never tie.
  const byRoot = cmp(a.rootName, b.rootName);
  if (byRoot !== 0) return byRoot;
  const byPath = cmp(a.source.relPath, b.source.relPath);
  if (byPath !== 0) return byPath;
  const byLine = (a.source.startLine ?? 0) - (b.source.startLine ?? 0);
  if (byLine !== 0) return byLine;
  const byColumn = (a.source.startColumn ?? 0) - (b.source.startColumn ?? 0);
  if (byColumn !== 0) return byColumn;
  const byField = cmp(a.field, b.field);
  if (byField !== 0) return byField;
  return cmp(String(a.toValue), String(b.toValue));
}

/**
 * Observe state changes across every root, reading each root's own analyzed files
 * from disk. Fails open per file: a read or scan error is disclosed as a note and
 * the pass continues, never throwing an otherwise-complete run down.
 */
export function observeStateChanges(input: StateTransitionObserveInput): StateTransitionObserveResult {
  const eligible = eligibleStateSets(input.valueSets, input.conditions);
  const notes: string[] = [];
  const changes: StateChangeObservation[] = [];
  if (eligible.length === 0) return { changes, notes };

  const roots = [...input.roots].sort((a, b) => cmp(a.rootName, b.rootName));
  for (const root of roots) {
    const rootPath = input.rootPaths?.get(root.rootName);
    if (rootPath === undefined) {
      notes.push(`state-transition observer: no path for root ${root.rootName}; its files were not scanned`);
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
        notes.push(`state-transition observer: could not read ${root.rootName}/${relPath}: ${error instanceof Error ? error.name : "read error"}`);
        continue;
      }
      try {
        changes.push(...observeChangesInFile(root.rootName, relPath, content, eligible));
      } catch (error) {
        notes.push(`state-transition observer: could not scan ${root.rootName}/${relPath}: ${error instanceof Error ? error.name : "scan error"}`);
      }
    }
  }

  changes.sort(compareObservations);
  notes.sort(cmp);
  return { changes, notes };
}
