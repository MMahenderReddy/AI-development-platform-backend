/**
 * Safe file writing for AI-generated code.
 *
 * Security properties:
 *  - Path traversal prevention: resolved path must stay inside repoRoot
 *  - Forbidden directory blocklist: .git, node_modules, dist, etc.
 *  - File extension allowlist: only well-known source code extensions
 *  - Hard block on .env files (secrets must never be AI-generated)
 *  - No eval or execution of AI-provided content — only writeFile
 */
import { writeFile, mkdir } from "fs/promises";
import { join, resolve, extname, dirname, sep } from "path";

const ALLOWED_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".css", ".scss", ".less", ".html", ".htm",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt", ".csv",
  ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php",
  ".c", ".cpp", ".h", ".hpp",
  ".sh", ".bash",
  ".gitignore", ".gitattributes",
  ".eslintrc", ".prettierrc", ".editorconfig", ".babelrc",
  ".svg", ".xml", ".graphql", ".gql",
  ".sql",
]);

const FORBIDDEN_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", "out",
  "__pycache__", "vendor", ".terraform", "coverage", ".cache",
]);

/**
 * Validate that writing relativePath inside repoRoot is safe.
 * Returns the absolute path to write.
 * Throws with a descriptive message if the write is not safe.
 */
export function validateWritePath(repoRoot, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("relativePath must be a non-empty string");
  }

  // Normalize slashes to OS separator for safe path.resolve behaviour
  const normalized = relativePath.replace(/\//g, sep).replace(/\\/g, sep);
  const fullPath = resolve(join(repoRoot, normalized));
  const rootResolved = resolve(repoRoot);

  // Path traversal check: fullPath must start with repoRoot + separator
  if (!fullPath.startsWith(rootResolved + sep) && fullPath !== rootResolved) {
    throw new Error(`Path traversal blocked: "${relativePath}"`);
  }

  // Check for forbidden directory components
  const parts = relativePath.split(/[/\\]/);
  for (const part of parts.slice(0, -1)) {
    if (FORBIDDEN_DIRS.has(part)) {
      throw new Error(`Forbidden directory in write path: "${part}"`);
    }
  }

  // Block .env files explicitly
  const filename = parts[parts.length - 1] ?? "";
  if (filename === ".env" || filename.startsWith(".env.")) {
    throw new Error("AI-generated .env files are blocked");
  }

  // Extension allowlist (files without an extension, like Makefile, are allowed)
  const ext = extname(relativePath).toLowerCase();
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension not allowed for AI-generated files: "${ext}"`);
  }

  return fullPath;
}

/**
 * Validate and write AI-generated content to a file.
 * Creates parent directories as needed.
 */
export async function writeFileSafe(repoRoot, relativePath, content) {
  if (typeof content !== "string") {
    throw new Error("File content must be a string");
  }
  const fullPath = validateWritePath(repoRoot, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  return fullPath;
}
