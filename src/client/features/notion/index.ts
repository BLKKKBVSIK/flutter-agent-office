/**
 * The 🗂️ Notion board: the cork board in the north-west corner, E to open it, and its window (the
 * Notion tasks assigned to the office's `ntn` login, narrowed to the floor's Notion project).
 */
import type { Ctx } from '../../core/context';
import type * as THREE from 'three';
import { boardHint, onE } from '../../core/hint';
import { store } from '../../state';
import type { BoardActions } from '../../ui/github/prompts';
import { openNotionBoard } from './ui';
import { NotionBoardTexture } from './world';

// The kind of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    notion: true;
  }
}

export interface NotionDeps {
  /** What the board's buttons do: hand a task to a worker, ask one about it. */
  boardActions(): BoardActions;
}

export function installNotion(ctx: Ctx, deps: NotionDeps) {
  const tex = new NotionBoardTexture();
  const mat = ctx.office.notionBoard.material as THREE.MeshBasicMaterial;
  mat.map = tex.texture;
  mat.needsUpdate = true;
  const render = () => tex.render(store.notion);
  store.on('notion', render);
  render();
  const open = () => openNotionBoard(ctx.net, deps.boardActions());
  ctx.interactions.define('notion', {
    reach: 9,
    hint: () => boardHint(store.notion.project ? `🗂️ Notion · ${store.notion.project.name}` : '🗂️ Notion board'),
    use: onE(open),
  });
  return { openNotion: open };
}
