import type { Db } from './connection.js';

/**
 * The Dockerfile CaptureHost generated for a project, if any.
 *
 * Kept out of `projects.repo.ts` because it is one wide text column that the
 * dashboard never needs in a list — only a boolean ("has one") and, on demand,
 * the content.
 */

export interface DockerfileOverride {
  content: string;
  source: 'generated' | 'edited';
  updatedAt: number;
}

export function getDockerfileOverride(db: Db, projectId: number): DockerfileOverride | null {
  const row = db
    .prepare('SELECT dockerfile_override, dockerfile_override_source, dockerfile_override_at FROM projects WHERE id = ?')
    .get(projectId) as
    | { dockerfile_override: string | null; dockerfile_override_source: string | null; dockerfile_override_at: number | null }
    | undefined;

  if (!row?.dockerfile_override) return null;
  return {
    content: row.dockerfile_override,
    source: row.dockerfile_override_source === 'edited' ? 'edited' : 'generated',
    updatedAt: row.dockerfile_override_at ?? 0,
  };
}

export function setDockerfileOverride(
  db: Db,
  projectId: number,
  content: string,
  source: 'generated' | 'edited',
): void {
  db.prepare(
    'UPDATE projects SET dockerfile_override = ?, dockerfile_override_source = ?, dockerfile_override_at = ? WHERE id = ?',
  ).run(content, source, Date.now(), projectId);
}

export function clearDockerfileOverride(db: Db, projectId: number): boolean {
  const result = db
    .prepare(
      'UPDATE projects SET dockerfile_override = NULL, dockerfile_override_source = NULL, dockerfile_override_at = NULL WHERE id = ?',
    )
    .run(projectId);
  return result.changes > 0;
}
