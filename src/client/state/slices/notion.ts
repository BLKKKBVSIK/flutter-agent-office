import type { NotionDatabaseChoice, NotionProjectChoice, NotionState } from '../../../shared/protocol';
import type { Slice } from '../store';

/** A list asked of Notion: what came back, and when. */
interface Asked<T> {
  list: T[];
  error?: string;
  loading: boolean;
  at: number;
}

declare module '../store' {
  interface Store {
    /** The floor's 🗂️ Notion board. */
    notion: NotionState;
    /** Databases that could hold the tasks, and the projects they link to, once asked for. */
    notionDatabases: Asked<NotionDatabaseChoice>;
    notionProjects: Asked<NotionProjectChoice>;
  }
  interface Topics {
    notion: true;
    notionDatabases: true;
    notionProjects: true;
  }
}

const none = () => ({ list: [], loading: false, at: 0 });

export const notion: Slice = {
  init(s) {
    s.notion = { items: [], fetchedAt: 0, loading: true };
    s.notionDatabases = none();
    s.notionProjects = none();
  },
  on: {
    'notion.tasks'(s, m) {
      // Another database links to other projects.
      if (s.notion.database?.id !== m.state.database?.id) s.notionProjects = none();
      s.notion = m.state;
      return ['notion'];
    },
    'notion.databases'(s, m) {
      s.notionDatabases = { list: m.databases, error: m.error, loading: false, at: Date.now() };
      return ['notionDatabases'];
    },
    'notion.projects'(s, m) {
      s.notionProjects = { list: m.projects, error: m.error, loading: false, at: Date.now() };
      return ['notionProjects'];
    },
  },
  enter(s, v) {
    s.notion = v.notion;
    return ['notion'];
  },
};
