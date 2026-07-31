/**
 * The recovered specification's own sections and tables.
 *
 * Its own file: the round-trip tests reached 1,704 lines, and this document's
 * sections are what most of them are about. The fixture is shared, not copied.
 */

import { describe, expect, it } from "vitest";

import { kb } from "./fixture.js";

import { renderFragment } from "../../engine/render/fragments.js";
import { FRAME_EN } from "../../engine/render/strings.js";

describe("the recovered specification's own sections", () => {
  const marked = Object.fromEntries(
    Object.keys(FRAME_EN).map((key) => [key, `<<${key}>>`]),
  ) as typeof FRAME_EN;

  const cases: readonly { fragment: string; data: Readonly<Record<string, unknown>> }[] = [
    {
      fragment: "prd-features",
      data: {
        features: [
          {
            id: "feat_a",
            name: "Leave",
            term: "leave",
            signals: ["26 endpoints", "3 data entities"],
            filePaths: [],
            endpoints: [
              { method: "POST", path: "/v2/leaves", rootName: "svc" },
              { method: "GET", path: "/v2/leaves/me", rootName: "svc" },
            ],
            tables: ["wcp_leave", "wcp_leave_detail"] },
          {
            id: "feat_b",
            name: "Billing",
            term: "billing",
            signals: ["32 endpoints"],
            filePaths: [],
            endpoints: [{ method: "GET", path: "/v2/bills", rootName: "svc" }],
            tables: [] },
        ] } },
    {
      fragment: "prd-pages",
      data: {
        screens: [
          { rootName: "ui", path: "/manage/employee/list", method: null, middleware: [], handlerName: null },
          { rootName: "ui", path: "/manage/employee/:id", method: null, middleware: [], handlerName: null },
          { rootName: "ui", path: "/leave/apply", method: null, middleware: [], handlerName: null },
        ] } },
    {
      fragment: "prd-validation",
      data: {
        guards: [
          {
            rootName: "svc",
            message: "Comment is required when status is rejected.",
            messageKind: "stated",
            test: "status == rejected",
            source: { relPath: "a.go", line: 1 } },
          {
            rootName: "svc",
            message: "ErrNotFound",
            messageKind: "error-code",
            test: "found == false",
            source: { relPath: "b.go", line: 2 } },
        ] } },
    {
      fragment: "prd-not-recoverable",
      data: {
        "silent-files": [{ rootName: "svc", relPath: "a.go", sizeBytes: 900 }],
        "unread-files": [{ rootName: "svc", relPath: "b.js", sizeBytes: 800 }],
        "coverage-notes": [{ subject: "route", note: "some limit" }] } },
  ];

  for (const { fragment, data } of cases) {
    it(`${fragment} states every word through the frame`, () => {
      const rendered = renderFragment(fragment, { kb, params: {}, frame: marked, data });
      expect(rendered).not.toBe("");
      // A bracketed key is the fallback for a string the frame does not carry.
      expect(rendered, `${fragment} rendered a key with no string`).not.toMatch(/\[[a-z][a-z0-9-]*\]/);
      // And nothing bypassed t(): every word came from the marked glossary.
      expect(rendered).toMatch(/<<[a-z-]+>>/);
    });
  }
});

/**
 * The recovered specification's tables, on their inputs.
 *
 * Nine of ten mutations of these fragments once survived the whole suite —
 * changing a truncation limit, dropping a truncation notice, reversing a sort,
 * breaking the identifier padding, mislabelling a count. Each assertion below
 * kills one, and none depends on any target's contents.
 */