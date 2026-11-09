import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/**
 * Puts a generated Dockerfile into a clone.
 *
 * Two rules, both intentional:
 *
 * 1. **The repository wins.** If the clone already has a file at the configured
 *    path, nothing is written. A generated file must never silently replace the
 *    project's own build definition.
 * 2. **The path cannot escape.** `dockerfile_path` is user input; a value like
 *    `../Dockerfile` would write outside the clone, so it is refused here as well
 *    as in the validator.
 */

export type OverrideResult = 'applied' | 'repo-wins' | 'unsafe-path';

export function applyDockerfileOverride(root: string, dockerfilePath: string, content: string): OverrideResult {
  const target = resolve(root, dockerfilePath);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  if (isAbsolute(dockerfilePath) || normalize(dockerfilePath).split(/[\\/]/).includes('..') || !target.startsWith(rootWithSep)) {
    return 'unsafe-path';
  }

  if (existsSync(target)) return 'repo-wins';

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o644 });
  return 'applied';
}
