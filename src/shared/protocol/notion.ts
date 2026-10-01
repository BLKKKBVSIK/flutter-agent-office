// The 🗂️ Notion board: tasks assigned to the office's `ntn` login, from one tasks database for the
// whole building, each floor narrowed to a Notion project of its own.
import type { GhState } from './github.js';

/** A Notion page the office points at: the tasks database, or a project in the one it links to. */
export interface NotionRef {
  id: string;
  name: string;
}

/** A row of the Notion tasks database assigned to the office's `ntn` login. */
export interface NotionTask {
  /** The page's id. */
  id: string;
  /** Its unique ID property, as Notion shows it (TASK-42); '' when the database has none. */
  ref: string;
  title: string;
  url: string;
  /** Its status option, as named in Notion. */
  status: string;
  /** Which of the status property's groups that option is in. */
  stage: 'todo' | 'doing' | 'done';
  priority?: string;
  /** Notion's color for its priority option. */
  priorityColor?: NotionColor;
  /** Where its priority sits in the property's options, 0 first; past the end when it has none. */
  priorityRank: number;
  /** Who it's assigned to. */
  assignees: NotionPerson[];
  /** How bad it is (Bloquant, Majeur…): its own severity, or the linked ticket's. */
  severity?: NotionChip;
  /** What kind of work it is (Bug, Amélioration…), the same way. */
  kind?: NotionChip;
  /** The projects it's linked to, by page id. */
  projects: string[];
  /** How many Notion tickets it's linked to. */
  tickets: number;
  updatedAt: string;
}

/** The 🗂️ Notion board: tasks assigned to the office's `ntn` login, narrowed to the floor's project when it has one. */
export interface NotionState extends GhState<NotionTask> {
  /** The tasks database the building reads; none until someone picks it. */
  database?: NotionRef;
  /** The floor's Notion project: only its tasks are on the board. */
  project?: NotionRef;
  /** Who the tasks are assigned to (the `ntn` login). */
  me?: string;
}

/** The colors Notion gives select options. */
export type NotionColor = 'default' | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

/** An option of a select, in Notion's color for it. */
export interface NotionChip {
  name: string;
  color?: NotionColor;
}

/** Notion's light backgrounds for its option colors, for chips and notes. */
export const NOTION_COLORS: Record<NotionColor, string> = {
  default: '#e9e9e7',
  gray: '#e3e2e0',
  brown: '#eee0da',
  orange: '#fadec9',
  yellow: '#fdecc8',
  green: '#dbeddb',
  blue: '#d3e5ef',
  purple: '#e8deee',
  pink: '#f5e0e9',
  red: '#ffe2dd',
};

/** Notion's stronger shades of the same colors, for a dot or a stripe that has to show from across the room. */
export const NOTION_INKS: Record<NotionColor, string> = {
  default: '#9b9a97',
  gray: '#9b9a97',
  brown: '#a27763',
  orange: '#e8833a',
  yellow: '#dfab01',
  green: '#4dab9a',
  blue: '#529cca',
  purple: '#9a6dd7',
  pink: '#e255a1',
  red: '#e03e3e',
};

/** A file on a Notion page: in a files property, or in its content. */
export interface NotionFile {
  name: string;
  /** Files Notion hosts have signed links that stop working after about an hour. */
  url: string;
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'file';
}

export interface NotionPerson {
  name: string;
  avatar?: string;
}

/** One property of a Notion page, ready to show: whichever of these its type fills in. */
export interface NotionProp {
  name: string;
  type: string;
  text?: string;
  /** Multi-selects, rollups and the like. */
  items?: string[];
  people?: NotionPerson[];
  files?: NotionFile[];
  /** A link to go with `text` (url and email properties). */
  href?: string;
  /** Text long enough to read as a paragraph rather than a field. */
  long?: boolean;
}

/** A comment on a Notion page, or on a block in it. */
export interface NotionComment {
  id: string;
  /** Comments in the same discussion are a thread, the first one opening it. */
  discussion: string;
  author: string;
  avatar?: string;
  createdAt: string;
  /** Its text, as markdown. */
  text: string;
  files: NotionFile[];
  /** The start of the block it was left on; none for a comment on the page itself. */
  on?: string;
}

/** A Notion page as the task window shows it: its properties and its content. */
export interface NotionPageDetail {
  id: string;
  url: string;
  title: string;
  /** Its non-empty properties, in Notion's order, without the title. */
  props: NotionProp[];
  /** Its content, in Notion's markdown. */
  markdown: string;
  /** Notion cut the content short. */
  truncated?: boolean;
  /** Why the content couldn't be read (the properties still are). */
  markdownError?: string;
  /** Its open comments (Notion doesn't hand out resolved ones), oldest first. */
  comments: NotionComment[];
  /** Why the comments couldn't be read. */
  commentsError?: string;
}

/** Everything the task window shows beyond the board card: GET /api/notion/task?id=… */
export interface NotionTaskDetail extends NotionPageDetail {
  /** The Notion tickets it links to, each with its own properties, content and attachments. */
  tickets: NotionPageDetail[];
  /** Linked tickets past the ones read. */
  moreTickets: number;
}

/** A database that could be the tasks database: it has a people property to be assigned in. */
export interface NotionDatabaseChoice extends NotionRef {
  /** Its people property tasks are assigned in. */
  assignee: string;
}

/** A project in the database the tasks link to. */
export interface NotionProjectChoice extends NotionRef {
  status?: string;
  /** Finished or cancelled, going by its status. */
  closed: boolean;
}

export type NotionClientMsg =
  /** Fetch the Notion board again. */
  | { t: 'notion.refresh' }
  /** Databases that could be the tasks database; answered with `notion.databases`. */
  | { t: 'notion.databases' }
  /** Make this the building's tasks database. */
  | { t: 'notion.database'; id: string }
  /** The projects the tasks database links to; answered with `notion.projects`. */
  | { t: 'notion.projects'; refresh?: boolean }
  /** Show only this project's tasks on the floor you're on (none: every task assigned to you). */
  | { t: 'notion.project'; project: NotionRef | null };

export type NotionServerMsg =
  | { t: 'notion.tasks'; state: NotionState }
  /** Sent to whoever asked. */
  | { t: 'notion.databases'; databases: NotionDatabaseChoice[]; error?: string }
  /** Sent to whoever asked. */
  | { t: 'notion.projects'; projects: NotionProjectChoice[]; error?: string };
