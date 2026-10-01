// The Notion task window: a task in full, with the tickets it links to.
import { notionId } from '../../notion.js';
import { send } from '../util.js';
import type { Route } from '../router.js';

export const notionRoutes = {
  task: {
    method: 'GET',
    path: '/api/notion/task',
    auth: 'session',
    async handle(ctx, { res, url }) {
      // What the task window shows beyond the board card (see notion.ts).
      const id = notionId(url.searchParams.get('id'));
      if (!id) return send(res, 400, { error: 'Bad id' });
      try {
        const detail = await ctx.notion.taskDetail(id);
        return detail ? send(res, 200, detail) : send(res, 404, { error: "That task isn't on the Notion board" });
      } catch (err) {
        return send(res, 502, { error: (err as Error).message });
      }
    },
  },
} satisfies Record<string, Route>;
