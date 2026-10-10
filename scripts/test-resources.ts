// Test resources belong to this process. Never scan or remove user directories.
import {
  mkdtempSync as allocate,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname } from "node:path";
let root: string | undefined;
export function mkdtempSync(prefix: string): string {
  if (!root) {
    root = allocate(join(tmpdir(), "harbor-tests-"));
    writeFileSync(join(root, ".harbor-test-owner"), "harbor-test-resources-v1");
  }
  return allocate(join(root, basename(prefix)));
}
export function cleanupTestResources() {
  if (root && !process.argv.includes("--keep-state")) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
}
process.once("exit", cleanupTestResources);

export function cleanupRetainedTestResources(stateDirectory: string) {
  const parent = dirname(stateDirectory);
  if (
    !basename(parent).startsWith("harbor-tests-") ||
    readFileSync(join(parent, ".harbor-test-owner"), "utf8") !==
      "harbor-test-resources-v1"
  )
    throw new Error(
      "Refusing to remove a directory not allocated by Atrium Grove tests",
    );
  rmSync(parent, { recursive: true, force: true });
}
