import { gitAssociation } from "../../../packages/worktrees/src/index.js";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../../../packages/domain/src/index.js";
export async function browseDirectories(
  requested?: string,
  inspectGit = false,
) {
  invariant(
    !requested ||
      (typeof requested === "string" &&
        requested.startsWith("/") &&
        requested.length < 4096 &&
        !requested.includes("\0")),
    "INVALID_PATH",
    "请输入绝对路径",
    400,
  );
  let path: string;
  try {
    path = await realpath(requested || homedir());
    invariant(
      (await stat(path)).isDirectory(),
      "INVALID_DIRECTORY",
      "请选择文件夹",
      400,
    );
  } catch {
    throw Object.assign(new Error("目录不存在或没有访问权限"), {
      code: "DIRECTORY_UNAVAILABLE",
      status: 400,
    });
  }
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw Object.assign(new Error("没有读取此目录的权限"), {
      code: "DIRECTORY_DENIED",
      status: 403,
    });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    path,
    parent: dirname(path) === path ? null : dirname(path),
    ...(inspectGit ? { git: await gitAssociation(path) } : {}),
    entries: dirs
      .slice(0, 500)
      .map((e) => ({ name: e.name, path: join(path, e.name) })),
    truncated: dirs.length > 500,
  };
}
