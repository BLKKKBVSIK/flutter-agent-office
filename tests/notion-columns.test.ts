import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotionTask } from '../src/shared/protocol.js';
import { store } from '../src/client/state/index.js';
import { boardColumns } from '../src/client/features/notion/status.js';

const task = (id: string, status: string, stage: NotionTask['stage'], updatedAt = '2026-10-01'): NotionTask => ({ id, ref: '', title: id, url: '', status, stage, priorityRank: 0, severityRank: 5, assignees: [], projects: [], tickets: 0, updatedAt });

test('the Notion board has a column per open status, a waiting one sharing the column before it, and one for the finished ones', () => {
  store.notion = {
    ...store.notion,
    statuses: [
      { name: 'Pas commencé', stage: 'todo' },
      { name: 'En cours', stage: 'doing' },
      { name: 'En attente / bloquer', stage: 'doing' },
      { name: 'À valider', stage: 'doing' },
      { name: 'Terminé', stage: 'done' },
      { name: 'Archivé', stage: 'done' },
    ],
  };
  const cols = boardColumns([task('a', 'Pas commencé', 'todo'), task('b', 'En attente / bloquer', 'doing'), task('c', 'En cours', 'doing'), task('d', 'À valider', 'doing'), task('e', 'Archivé', 'done', '2026-10-03'), task('f', 'Terminé', 'done', '2026-10-02')]);
  assert.deepEqual(cols.map((c) => [c.title, c.status, c.items.map((t) => t.id)]), [
    ['📥 Pas commencé', 'Pas commencé', ['a']],
    ['🚧 En cours', 'En cours', ['b', 'c']],
    ['🔍 À valider', 'À valider', ['d']],
    ['✅ Terminé', 'Terminé', ['e', 'f']],
  ]);
});

test('without a status property the columns are the three stages', () => {
  store.notion = { ...store.notion, statuses: undefined };
  const cols = boardColumns([task('a', '', 'todo')]);
  assert.deepEqual(cols.map((c) => [c.title, c.status, c.items.length]), [['📥 To do', undefined, 1], ['🚧 In progress', undefined, 0], ['✅ Done', undefined, 0]]);
});
