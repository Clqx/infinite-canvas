import fs from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
    constructor() {
        super("path is outside the allowed workspace");
        this.name = "WorkspacePathError";
    }
}

/** Resolve an existing path and reject traversal or symlink escapes from the workspace. */
export async function resolveWorkspacePath(workspaceRoot: string, candidate: string) {
    if (!path.isAbsolute(candidate)) throw new WorkspacePathError();
    let root: string;
    let target: string;
    try {
        [root, target] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(candidate)]);
    } catch {
        throw new WorkspacePathError();
    }
    const relative = path.relative(root, target);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) return target;
    throw new WorkspacePathError();
}
