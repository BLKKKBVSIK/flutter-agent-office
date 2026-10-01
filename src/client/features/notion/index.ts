/**
 * The 🗂️ Notion board: the Notion tasks assigned to the office's `ntn` login, narrowed to the floor's
 * Notion project. It hangs where the issues board did (see features/boards), and opens its window.
 */
import type { Ctx } from '../../core/context';
import { boardHint } from '../../core/hint';
import { store } from '../../state';
import type { BoardActions } from '../../ui/github/prompts';
import { openNotionBoard } from './ui';
import { NotionBoardTexture } from './world';

export interface NotionDeps {
  /** What the board's buttons do: hand a task to a worker, ask one about it. */
  boardActions(): BoardActions;
}

export function installNotion(ctx: Ctx, deps: NotionDeps) {
  const tex = new NotionBoardTexture();
  const open = () => openNotionBoard(ctx.net, deps.boardActions());
  return {
    /** The board, for features/boards to hang on the wall. */
    board: {
      texture: tex.texture,
      render: () => tex.render(store.notion),
      hint: () => boardHint(store.notion.project ? `🗂️ Notion · ${store.notion.project.name}` : '🗂️ Notion board'),
      open,
    },
  };
}
