import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
function hasErrorCode(error, code) {
    return typeof error === 'object'
        && error !== null
        && Reflect.get(error, 'code') === code;
}
export function parseNtmProjectsBase(raw) {
    const match = raw.match(/projects_base\s*[=:]\s*"?([^"\n]+)"?/);
    return match?.[1]?.trim() || null;
}
export function ntmProjectName(cwd) {
    return basename(cwd);
}
async function resolveProjectRoot(cwd) {
    const resolvedCwd = await realpath(cwd);
    let candidate = resolvedCwd;
    while (true) {
        try {
            const marker = await lstat(join(candidate, '.git'));
            if (marker.isDirectory() || marker.isFile())
                return candidate;
        }
        catch (error) {
            if (!hasErrorCode(error, 'ENOENT'))
                throw error;
        }
        const parent = dirname(candidate);
        if (parent === candidate)
            return resolvedCwd;
        candidate = parent;
    }
}
export async function classifyNtmProjectTarget(cwd, projectsBase) {
    const root = await resolveProjectRoot(cwd);
    const project = ntmProjectName(root);
    const target = join(projectsBase, project);
    let targetStat;
    try {
        targetStat = await lstat(target);
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return { kind: 'missing', project, root, target };
        }
        throw error;
    }
    let resolvedTarget;
    try {
        resolvedTarget = await realpath(target);
    }
    catch (error) {
        if (targetStat.isSymbolicLink() && hasErrorCode(error, 'ENOENT')) {
            const link = await readlink(target);
            return {
                kind: 'collision',
                reason: 'dangling-symlink',
                project,
                root,
                target,
                resolvedTarget: isAbsolute(link)
                    ? link
                    : resolve(dirname(target), link),
            };
        }
        throw error;
    }
    if (!targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
        return {
            kind: 'collision',
            reason: 'regular-file',
            project,
            root,
            target,
            resolvedTarget,
        };
    }
    if (resolvedTarget === root) {
        return { kind: 'matching', project, root, target, resolvedTarget };
    }
    return {
        kind: 'collision',
        reason: 'different-target',
        project,
        root,
        target,
        resolvedTarget,
    };
}
//# sourceMappingURL=ntm-project.js.map