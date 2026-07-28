# Coverage matrix

Generated from declared capabilities and observed record counts. Do not edit by hand.

| Kind | Provider | Language | Support | Records | Notes |
| --- | --- | --- | --- | --- | --- |
| `source-file` | codegraph | * | full | 44 | — |
| `symbol` | codegraph | * | full | 295 | at most 100000 nodes per root |
| `call-edge` | codegraph | * | partial | 371 | only functions and methods are queried for callees; only calls to indexed symbols are reported; calls into dependencies do not appear at all; dynamic dispatch and reflection are reported as unresolved where they surface; one subprocess call per callable symbol, so extraction time grows with symbol count; at most 200 callees are read per symbol; hitting the cap is recorded as a failure |
| `import` | codegraph | * | partial | 140 | import specifiers are not resolved to files; imported names are not itemized |
| `export` | codegraph | * | absent | 0 | CodeGraph does not expose export records |
| `reference` | codegraph | * | absent | 0 | CodeGraph does not expose reference sites |
| `type-relation` | codegraph | * | absent | 0 | CodeGraph does not expose inheritance or interface conformance |
| `module-containment` | codegraph | * | absent | 0 | supplied by the manifest reader, not by this provider |
| `module-containment` | manifests | * | partial | 72 | folder containment only; language package and namespace structure is not read |
| `package-dependency` | codegraph | * | absent | 0 | supplied by the manifest reader, not by this provider |
| `package-dependency` | manifests | * | partial | 27 | readable formats: package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml, pom.xml, composer.json; recognized but not yet readable: build.gradle, build.gradle.kts, Package.swift, Podfile, Gemfile, pubspec.yaml, mix.exs, CMakeLists.txt, *.csproj; npm: resolved versions require a lockfile, which is not read; go: replace and exclude directives are not applied; pypi: environment markers, extras and -r includes are not followed; pypi: only PEP 621 and Poetry dependency tables are understood; cargo: workspace inheritance and target-specific dependency tables are not resolved; maven: parent POM inheritance is not resolved; maven: property placeholders in versions are left uninterpolated; composer: resolved versions require composer.lock, which is not read |
| `build-target` | codegraph | * | absent | 0 | supplied by the manifest reader, not by this provider |
| `build-target` | manifests | * | partial | 0 | only executables a manifest declares outright are recorded |
| `route` | codegraph | * | partial | 14 | framework router-group prefixes are not resolved, so paths may be incomplete; routes are not linked to their handler symbols; routes registered through a wrapper or closure may be missed entirely |
| `outbound-call` | codegraph | * | absent | 0 | supplied by the outbound-call detector, not by this provider |
| `outbound-call` | outbound-calls | * | partial | 3 | absolute URL literals only; relative paths and base-URL composition are not detected; destinations built at runtime are recorded as unresolved, never guessed; matches are textual, so URLs in comments or documentation strings are possible; XML namespace, schema and licence URIs are excluded as identifiers rather than destinations; the calling symbol is not resolved here; it is attached later from source ranges; this is never a complete list of what a service talks to |
| `external-call` | codegraph | * | absent | 0 | — |
| `data-access` | codegraph | * | absent | 0 | — |
| `data-access` | conventions | * | partial | 7 | matches declared patterns only; logic expressed in control flow is not reached; matches are textual, so occurrences in comments or strings are possible; files larger than 1000000 bytes are skipped; ORM method names are matched without resolving the receiver, so unrelated methods of the same name match; the entity touched is not resolved and is always null |
| `auth-annotation` | codegraph | * | absent | 0 | — |
| `auth-annotation` | conventions | * | partial | 60 | matches declared patterns only; logic expressed in control flow is not reached; matches are textual, so occurrences in comments or strings are possible; files larger than 1000000 bytes are skipped; languages without auth annotations are matched by name alone, which over-matches heavily in auth-centric codebases |
| `test-relation` | codegraph | * | absent | 0 | — |
| `test-relation` | test-relations | * | partial | 0 | 1 test files were found but no call edges reach them, so no relation could be derived; test files are identified by path and filename convention only; relations follow existing call edges, so a test exercising code indirectly may be missed; a project using an unrecognized test convention yields no relations rather than wrong ones |
| `validation-rule` | codegraph | * | absent | 0 | — |
| `validation-rule` | conventions | * | partial | 3 | matches declared patterns only; logic expressed in control flow is not reached; matches are textual, so occurrences in comments or strings are possible; files larger than 1000000 bytes are skipped |
| `transaction-boundary` | codegraph | * | absent | 0 | — |
| `transaction-boundary` | conventions | * | partial | 1 | matches declared patterns only; logic expressed in control flow is not reached; matches are textual, so occurrences in comments or strings are possible; files larger than 1000000 bytes are skipped |
| `error-handling` | codegraph | * | absent | 0 | — |
| `error-handling` | conventions | * | partial | 42 | matches declared patterns only; logic expressed in control flow is not reached; matches are textual, so occurrences in comments or strings are possible; files larger than 1000000 bytes are skipped |

## Empty results worth questioning

These kinds fall out of code structure in any language, so an empty result suggests a gap rather than a property of the project:

- `export`
- `reference`
- `type-relation`
