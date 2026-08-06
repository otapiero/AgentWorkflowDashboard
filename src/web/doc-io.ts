import { api, type DocumentPayload } from './api.ts';
import type { DocId } from './doc-model.ts';

/**
 * The one place that knows the plan and the artifacts sit behind different
 * routes. Components address documents purely by `DocId`.
 */

export async function loadDocument(issue: number, id: DocId): Promise<DocumentPayload> {
  if (id.kind === 'artifact') return api.readArtifact(issue, id.name);

  const { content } = await api.plan(issue);
  // plan.md has no checkout counterpart — it *is* the real file, so there is
  // never a "snapshot only" caveat to show for it.
  return { content, class: 'markdown', writeTarget: 'original', originalPath: '' };
}

export async function saveDocument(
  issue: number,
  id: DocId,
  content: string,
): Promise<'original' | 'snapshot'> {
  if (id.kind === 'artifact') {
    const { writeTarget } = await api.saveArtifact(issue, id.name, content);
    return writeTarget;
  }
  await api.savePlan(issue, content);
  return 'original';
}
