/**
 * Manifest filenames across the ecosystems we analyze.
 *
 * A manifest is evidence that a directory is a project in its own right. It is
 * never *required* — a folder of source files with no manifest is a first-class
 * target — but where one exists it settles the question cheaply.
 */
export const MANIFEST_FILENAMES: readonly string[] = [
  "package.json",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "Package.swift",
  "pubspec.yaml",
  "mix.exs",
];

/**
 * Directories that are never source roots. Dependencies, build output, editor
 * and tooling state. Skipping them is not the same as ignoring them — each skip
 * is recorded with its reason.
 */
export const NON_ROOT_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "tmp",
  "temp",
  "__pycache__",
  "venv",
  ".venv",
  "Pods",
  "DerivedData",
]);

/** Extensions treated as source when deciding whether a directory is itself a root. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".go", ".py", ".rb", ".php", ".java", ".kt", ".scala", ".swift",
  ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".cs",
  ".ex", ".exs", ".dart", ".sh",
]);
