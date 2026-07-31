/**
 * The row fixtures the recovered specification's table tests are written against.
 *
 * Shared so the capability tables and the rule tables can live in separate files
 * without either restating what a capability, a screen or a guard looks like.
 */

import { renderFragment } from "../../engine/render/fragments.js";
import { kb } from "./fixture.js";

export function feature(
  name: string,
  endpoints: number,
  tables: readonly string[] = [],
  options: { nearby?: readonly string[]; roots?: readonly string[]; truncated?: boolean } = {},
) {
  return {
    id: `feat_${name}`,
    name,
    term: name.toLowerCase(),
    signals: [],
    filePaths: [],
    tables: [...tables],
    tablesNearby: [...(options.nearby ?? [])],
    tablesTruncated: options.truncated ?? false,
    endpoints: Array.from({ length: endpoints }, (_, n) => ({
      method: "GET",
      path: `/${name.toLowerCase()}/${n}`,
      rootName: "svc" })) };
}

export function screen(rootName: string, path: string) {
  return { rootName, path, method: null, middleware: [], handlerName: null };
}

export function guard(rootName: string, relPath: string, message: string, test: string) {
  return { rootName, message, messageKind: "stated", test, source: { relPath, line: 1 } };
}

export const render = (fragment: string, data: Readonly<Record<string, unknown>>) =>
  renderFragment(fragment, { kb, params: {}, data });
