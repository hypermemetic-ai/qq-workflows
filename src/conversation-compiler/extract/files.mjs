import { extractPath } from "../tool-args.mjs";

const FILE_READ_TOOLS = new Set(["read", "read_file", "view"]);
const FILE_WRITE_TOOLS = new Set(["edit", "write", "edit_file", "write_file", "multiedit", "quick_edit", "target_edit", "apply_patch"]);
const FILE_CREATE_TOOLS = new Set(["write", "write_file"]);
const matches = (tools, name) => tools.has(name.toLowerCase());

const longestCommonDirPrefix = (paths) => {
  const absolute = paths.filter((path) => path.startsWith("/"));
  if (absolute.length < 2) return "";
  const split = absolute.map((path) => path.split("/"));
  const minimum = Math.min(...split.map((segments) => segments.length));
  let index = 0;
  while (index < minimum - 1) {
    const segment = split[0][index];
    if (!split.every((segments) => segments[index] === segment)) break;
    index += 1;
  }
  if (index < 2) return "";
  return `${split[0].slice(0, index).join("/")}/`;
};

const trimPaths = (set, prefix) => {
  if (!prefix) return set;
  const output = new Set();
  for (const path of set) output.add(path.startsWith(prefix) ? path.slice(prefix.length) : path);
  return output;
};

export const extractFiles = (blocks, fileOps) => {
  const activity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };
  for (const block of blocks ?? []) {
    if (block.kind !== "tool_call") continue;
    const path = extractPath(block.args);
    if (!path) continue;
    if (matches(FILE_READ_TOOLS, block.name)) activity.read.add(path);
    if (matches(FILE_WRITE_TOOLS, block.name)) activity.modified.add(path);
    if (matches(FILE_CREATE_TOOLS, block.name)) activity.created.add(path);
  }
  const prefix = longestCommonDirPrefix([...activity.read, ...activity.modified, ...activity.created]);
  if (prefix) {
    activity.read = trimPaths(activity.read, prefix);
    activity.modified = trimPaths(activity.modified, prefix);
    activity.created = trimPaths(activity.created, prefix);
  }
  return activity;
};
