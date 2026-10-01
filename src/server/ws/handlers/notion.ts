// The 🗂️ Notion board: fetching it again, picking the building's tasks database, and the Notion
// project each floor's board shows.
import type { NotionClientMsg } from '../../../shared/protocol.js';
import { notionId, notionRef } from '../../notion.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const notionView: ViewPieces['notion'] = (ctx, floor) => ctx.notion.view(floor?.def.notionProject);

export const notionHandlers = {
  'notion.refresh'(ctx) {
    void ctx.notion.refresh();
  },
  'notion.databases'(ctx, c) {
    void ctx.notion.databases().then(
      (databases) => ctx.sendTo(c, { t: 'notion.databases', databases }),
      (err: Error) => ctx.sendTo(c, { t: 'notion.databases', databases: [], error: `Couldn't list your Notion databases: ${err.message}` }),
    );
  },
  'notion.database'(ctx, c, msg) {
    const who = c.peer.name;
    const id = notionId(msg.id);
    if (!id) return;
    void ctx.notion.setDatabase(id).then((error) => {
      if (error) return ctx.warn(c, error);
      console.log(`  ${who} set the Notion board to ${ctx.notion.database?.name} (${id})`);
      ctx.toastAll(`🗂️ ${who} pointed the Notion boards at ${ctx.notion.database?.name}`);
    });
  },
  'notion.projects'(ctx, c, msg) {
    void ctx.notion.projects(msg.refresh === true).then(
      (projects) => ctx.sendTo(c, { t: 'notion.projects', projects }),
      (err: Error) => ctx.sendTo(c, { t: 'notion.projects', projects: [], error: `Couldn't list the Notion projects: ${err.message}` }),
    );
  },
  'notion.project'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const project = msg.project === null ? undefined : notionRef(msg.project);
    if (!floor || (msg.project !== null && !project)) return;
    if (!ctx.building.setNotionProject(floor.id, project)) return;
    ctx.toFloor(floor, { t: 'notion.tasks', state: ctx.notion.view(project) });
    ctx.floorsChanged();
    ctx.toastFloor(floor, project ? `🗂️ ${who} set this floor's Notion board to ${project.name}` : `🗂️ ${who} set this floor's Notion board to every task`);
  },
} satisfies HandlerMap<NotionClientMsg>;
