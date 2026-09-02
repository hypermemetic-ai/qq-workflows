export const PATH_KEYS = ["path", "file_path", "filePath", "file"];

export const extractPath = (args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

export const summarizeToolArgs = (args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const path = extractPath(args);
  if (path) return path;
  for (const key of ["command", "query", "pattern", "description"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
  }
  return "";
};

export const parseToolArgs = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A malformed streamed call is still represented, but never interpreted as
    // structured file activity.
    return {};
  }
};
