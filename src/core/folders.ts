/** Pure folder helpers for creating sessions: no React Native / Expo imports so `node --test` can load this file directly. */

const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

/** Trims whitespace and trailing separators (keeping a bare root like `/` or `C:\`). */
export function normalizeDirectory(value: string) {
  const trimmed = value.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped === "" || /^[A-Za-z]:$/.test(stripped) ? trimmed.slice(0, stripped.length + 1) : stripped;
}

export function folderName(directory: string) {
  return normalizeDirectory(directory).split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
}

export type FolderResolution = { ok: true; directory: string } | { ok: false; error: string };

/**
 * Turns user input into an absolute directory. An absolute path is taken as is (the server still has to confirm it
 * exists). A bare folder name must match exactly one folder this server already has sessions in; OpenCode resolves
 * relative paths against its own working directory, which is rarely what the user means, so those are never sent.
 */
export function resolveFolderInput(input: string, knownDirectories: readonly string[]): FolderResolution {
  const value = normalizeDirectory(input);
  if (!value) return { ok: false, error: "Enter a folder name or an absolute path." };
  if (value.startsWith("~")) return { ok: false, error: "Use the full path (the server can't expand ~)." };
  if (isAbsolute(value)) return { ok: true, directory: value };
  if (/[\\/]/.test(value)) return { ok: false, error: "Use a folder name or an absolute path starting with /." };
  const matches = [...new Set(knownDirectories.map(normalizeDirectory))].filter(directory => folderName(directory) === value);
  if (matches.length === 1) return { ok: true, directory: matches[0]! };
  if (matches.length > 1) return { ok: false, error: `More than one folder is named “${value}”: ${matches.join(", ")}. Enter the full path.` };
  return { ok: false, error: `Folder “${value}” does not exist in any project on this server. Enter the full path to start somewhere new.` };
}
