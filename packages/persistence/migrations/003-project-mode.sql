-- Preserve existing worktree bindings; new API bindings explicitly default to directory.
ALTER TABLE projects ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'git-worktree' CHECK(workspace_mode IN ('directory','git-worktree'));
