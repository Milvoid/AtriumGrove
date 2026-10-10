import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { invariant } from "../../domain/src/index.js";
const exec = promisify(execFile);
export type WorkspaceMode = "directory" | "git-worktree";
export async function git(root: string, args: string[]) {
  return (
    await exec("git", ["-C", root, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
      env: { ...process.env, LC_ALL: "C" },
    })
  ).stdout.trim();
}
/** Ordinary folder paths never invoke Git, including folders inside a repository. */
export async function verifyDirectory(root: string) {
  invariant(
    typeof root === "string" && root.startsWith("/") && !root.includes("\0"),
    "INVALID_PATH",
    "请选择绝对目录路径",
    400,
  );
  const path = await realpath(root);
  invariant(
    (await stat(path)).isDirectory(),
    "INVALID_DIRECTORY",
    "请选择文件夹",
    400,
  );
  return { rootPath: path };
}
export async function gitAssociation(root: string) {
  const { rootPath } = await verifyDirectory(root);
  try {
    const repositoryRoot = await realpath(
      await git(rootPath, ["rev-parse", "--show-toplevel"]),
    );
    let hasCommit = false;
    try {
      await git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
      hasCommit = true;
    } catch {
      /* Unborn branch. */
    }
    return { repositoryRoot, hasCommit };
  } catch (error) {
    // Missing Git and inaccessible repositories must not be mistaken for a new repository.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (!String((error as any).stderr).includes("not a git repository"))
      throw error;
    return null;
  }
}
export async function verifyProject(root: string, baseRef: string) {
  invariant(
    !baseRef.startsWith("-") && !/[\x00\r\n]/.test(baseRef),
    "INVALID_REF",
    "Unsafe Git ref",
  );
  const { rootPath } = await verifyDirectory(root);
  const repositoryRoot = await realpath(
    await git(rootPath, ["rev-parse", "--show-toplevel"]),
  );
  const commit = await git(repositoryRoot, [
    "rev-parse",
    "--verify",
    baseRef + "^{commit}",
  ]);
  return {
    rootPath,
    repositoryRoot,
    commit,
    dirty: !!(await git(repositoryRoot, ["status", "--porcelain"])),
  };
}
/** Explicit owner operation only; never called by browsing or runtime startup. */
export async function initializeGit(root: string) {
  const { rootPath } = await verifyDirectory(root);
  const association = await gitAssociation(rootPath);
  if (association?.hasCommit) return association; // Retry after a lost receipt.
  invariant(
    !association || association.repositoryRoot === rootPath,
    "GIT_PARENT_UNBORN",
    "上级目录已有未提交的 Git 仓库，请在该仓库根目录完成首次提交",
    409,
  );
  if (!association) await git(rootPath, ["init", "-b", "main"]);
  await git(rootPath, ["add", "--all", "--", "."]);
  await git(rootPath, [
    "-c",
    "user.name=Atrium Grove",
    "-c",
    "user.email=harbor@localhost",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize Atrium Grove workspace",
  ]);
  return { repositoryRoot: rootPath, hasCommit: true };
}
export async function ensureWorktree(
  state: string,
  workspaceId: string,
  agentId: string,
  generation: number,
  root: string,
  baseRef: string,
) {
  const project = await verifyProject(root, baseRef);
  const path = join(state, "worktrees", workspaceId, agentId);
  let existing = false;
  try {
    await stat(path);
    existing = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    const owned = await git(project.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    invariant(
      owned.split("\n").includes("worktree " + (await realpath(path))),
      "WORKTREE_NOT_OWNED",
      "Existing directory is not a registered project worktree",
    );
  } else {
    await mkdir(join(state, "worktrees", workspaceId, agentId, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await git(project.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      `harbor/${agentId}/${generation}`,
      path,
      project.commit,
    ]);
  }
  // Selecting a repository subfolder keeps that subfolder as cwd in each worktree.
  return (
    await verifyDirectory(
      join(path, relative(project.repositoryRoot, project.rootPath)),
    )
  ).rootPath;
}
export async function prepareWorkspace(
  state: string,
  workspaceId: string,
  agentId: string,
  generation: number,
  project: { rootPath: string; baseRef: string; workspaceMode: WorkspaceMode },
) {
  if (project.workspaceMode === "directory")
    return (await verifyDirectory(project.rootPath)).rootPath;
  invariant(
    project.workspaceMode === "git-worktree",
    "INVALID_WORKSPACE_MODE",
    "Unknown workspace mode",
  );
  return ensureWorktree(
    state,
    workspaceId,
    agentId,
    generation,
    project.rootPath,
    project.baseRef,
  );
}
