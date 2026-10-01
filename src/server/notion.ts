import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GhState, NotionChip, NotionColor, NotionComment, NotionDatabaseChoice, NotionFile, NotionPageDetail, NotionPerson, NotionProjectChoice, NotionProp, NotionRef, NotionState, NotionTask, NotionTaskDetail } from '../shared/protocol.js';

// The 🗂️ Notion board: the tasks assigned to whoever the office machine's `ntn` (Notion CLI) is
// logged in as, from one tasks database picked for the whole building. Each floor can narrow it to
// a Notion project, through the database's relation to its projects. Everything goes through
// `ntn api`, the way the GitHub boards go through `gh`.

/** How long the list of projects is reused before Notion is asked again. */
const PROJECTS_TTL_MS = 5 * 60_000;
/** Open tasks are read a hundred at a time, up to this many pages. */
const MAX_PAGES = 5;
/** Finished tasks shown, most recently edited first. */
const DONE_SHOWN = 30;

const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** A Notion id as the API takes it, from a bare or dashed id; undefined when it isn't one. */
export function notionId(v: unknown): string | undefined {
  return typeof v === 'string' && ID_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined;
}

/** A project or database as a client sent it, checked. */
export function notionRef(v: unknown): NotionRef | undefined {
  const r = v as { id?: unknown; name?: unknown } | null;
  const id = notionId(r?.id);
  return id ? { id, name: typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 200) : 'Untitled' } : undefined;
}

/** Turns ntn's stderr into something a person standing at the board can act on. */
function friendly(raw: string): string {
  if (/unauthori[sz]ed|not logged in|no credentials|log in|login/i.test(raw)) return "ntn isn't logged in on the server — run `ntn login`";
  if (/object_not_found|could not find/i.test(raw)) return "Notion can't find that database — check that your Notion login can see it";
  return raw;
}

let bin = 'ntn';

function run(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      // ntn prints the API's error body on stdout or stderr, depending on the failure.
      const raw = `${stderr || ''}\n${stdout || ''}`.trim() || err.message;
      let msg = raw;
      try {
        const body = JSON.parse(stdout) as { message?: string; code?: string };
        if (body.message) msg = `${body.code ? `${body.code}: ` : ''}${body.message}`;
      } catch {
        msg = raw.split('\n').filter(Boolean).slice(-2).join(' ');
      }
      reject(new Error(friendly(msg)));
    });
    // `ntn api` reads a request body from stdin when it's a pipe, and would wait on it until the timeout.
    child.stdin?.end();
  });
}

/** Runs `ntn`, from $PATH or where its installer puts it (a service's $PATH often leaves ~/.local/bin out). */
export async function ntn(args: string[], timeout = 60_000): Promise<string> {
  try {
    return await run(args, timeout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const local = path.join(os.homedir(), '.local', 'bin', 'ntn');
    if (bin === 'ntn' && existsSync(local)) {
      bin = local;
      return ntn(args, timeout);
    }
    throw new Error('The Notion CLI (ntn) is not installed on the server');
  }
}

/** Notion's own hiccups, worth asking again: a 5xx, a rate limit, or the connection dropping. */
const PASSING = /internal_server_error|service_unavailable|bad gateway|gateway_timeout|rate_limited|\b(500|502|503|504|429)\b|cross-cell|ECONNRESET|ETIMEDOUT/i;

/** Calls the public Notion API through `ntn api`: a GET, or a POST of `body`. Asks again, twice, when Notion hiccups. */
async function api<T = any>(route: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await ntn(body === undefined ? ['api', route] : ['api', route, '-d', JSON.stringify(body)]);
      const res = JSON.parse(out) as { object?: string; message?: string; code?: string };
      if (res?.object === 'error') throw new Error(friendly(`${res.code ? `${res.code}: ` : ''}${res.message ?? 'Notion said no'}`));
      return res as T;
    } catch (err) {
      if (attempt >= 3 || !PASSING.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
}

/** Every page of a query or search, a hundred at a time, up to `pages` of them. */
async function all(route: string, body: Record<string, unknown>, pages = MAX_PAGES): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const res = await api<{ results?: any[]; has_more?: boolean; next_cursor?: string | null }>(route, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(res.results ?? []));
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

function plain(rich: unknown): string {
  return Array.isArray(rich) ? rich.map((r) => String(r?.plain_text ?? '')).join('') : '';
}

type Stage = NotionTask['stage'];

/** Where a status option goes on the board, by the name of its group in Notion (To-do, In progress, Complete). */
export function stageOfGroup(group: string, index: number, groups: number): Stage {
  if (/complete|done|termin/i.test(group)) return 'done';
  if (/progress|cours|doing/i.test(group)) return 'doing';
  if (/to-?do|faire|not started/i.test(group)) return 'todo';
  return index === 0 ? 'todo' : index === groups - 1 ? 'done' : 'doing';
}

/** For a plain select used as a status, which has no groups: by the option's name. */
export function stageOfName(name: string): Stage {
  if (/termin|done|complete|clos|archiv|annul|cancel|refus|fini/i.test(name)) return 'done';
  if (/cours|progress|doing|valider|livrer|review|test/i.test(name)) return 'doing';
  return 'todo';
}

/** What the board reads from the tasks database, found by the properties' types and names. */
export interface TaskSchema {
  title: string;
  assignee: string;
  status?: { name: string; type: 'status' | 'select'; stages: Map<string, Stage> };
  priority?: { name: string; options: string[] };
  project?: { name: string; dataSource: string };
  tickets?: string;
  ref?: string;
  /** A select, or a rollup of one from the linked ticket. */
  severity?: string;
  kind?: string;
}

const SEVERITY_RE = /s[ée]v[ée]rit|severity|gravit/i;
const KIND_RE = /(^|[^\p{L}])type$/iu;

const ASSIGNEE_RE = /assign|attribu|responsable|owner|propriétaire/i;

/** Reads the tasks database's properties: which one is the assignee, the status, the project… */
export function readSchema(properties: Record<string, any>): TaskSchema | string {
  const entries = Object.entries(properties ?? {});
  const named = (type: string, re?: RegExp) => entries.find(([k, v]) => v?.type === type && (!re || re.test(k)));
  const title = named('title');
  const people = named('people', ASSIGNEE_RE) ?? named('people');
  if (!title) return "That database has no title property, so it can't be the tasks database";
  if (!people) return 'That database has no people property to assign tasks in';
  const schema: TaskSchema = { title: title[0], assignee: people[0] };
  const status = named('status') ?? named('select', /statu|état|etat|state|stage/i);
  if (status) {
    const [name, v] = status;
    const stages = new Map<string, Stage>();
    if (v.type === 'status') {
      const groups = (v.status?.groups ?? []) as { name: string; option_ids: string[] }[];
      const options = (v.status?.options ?? []) as { id: string; name: string }[];
      groups.forEach((g, i) => {
        for (const o of options) if (g.option_ids?.includes(o.id)) stages.set(o.name, stageOfGroup(g.name, i, groups.length));
      });
      for (const o of options) if (!stages.has(o.name)) stages.set(o.name, stageOfName(o.name));
    } else for (const o of (v.select?.options ?? []) as { name: string }[]) stages.set(o.name, stageOfName(o.name));
    schema.status = { name, type: v.type, stages };
  }
  const priority = named('select', /priorit/i);
  if (priority) schema.priority = { name: priority[0], options: ((priority[1].select?.options ?? []) as { name: string }[]).map((o) => o.name) };
  const project = named('relation', /proje/i);
  if (project?.[1].relation?.data_source_id) schema.project = { name: project[0], dataSource: String(project[1].relation.data_source_id) };
  const tickets = named('relation', /ticket/i);
  if (tickets) schema.tickets = tickets[0];
  const ref = named('unique_id');
  if (ref) schema.ref = ref[0];
  const severity = named('select', SEVERITY_RE) ?? named('rollup', SEVERITY_RE);
  if (severity) schema.severity = severity[0];
  const kind = named('select', KIND_RE) ?? named('rollup', KIND_RE);
  if (kind) schema.kind = kind[0];
  return schema;
}

const COLORS = new Set(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);

/** A select's option with its color; from a rollup, the first one it shows. Notion's "_background" colors count as the plain ones. */
export function chipOf(v: any): NotionChip | undefined {
  const opt = v?.type === 'rollup' ? (v.rollup?.array ?? []).map((x: any) => x?.select ?? x?.status ?? x?.multi_select?.[0]).find((o: any) => o?.name) : (v?.select ?? v?.status);
  if (!opt?.name) return undefined;
  const color = String(opt.color ?? '').replace(/_background$/, '');
  return { name: String(opt.name), ...(COLORS.has(color) ? { color: color as NotionColor } : {}) };
}

/** A row of the tasks database as the board shows it. */
export function toTask(page: any, schema: TaskSchema): NotionTask {
  const props = page?.properties ?? {};
  const st = schema.status ? props[schema.status.name] : undefined;
  const status = String((st?.status ?? st?.select)?.name ?? '');
  const priority = schema.priority ? (props[schema.priority.name]?.select?.name as string | undefined) : undefined;
  const uid = schema.ref ? props[schema.ref]?.unique_id : undefined;
  const rank = priority && schema.priority ? schema.priority.options.indexOf(priority) : -1;
  return {
    id: String(page.id),
    ref: uid?.number != null ? (uid.prefix ? `${uid.prefix}-${uid.number}` : `#${uid.number}`) : '',
    title: plain(props[schema.title]?.title) || 'Untitled',
    url: String(page.url ?? ''),
    status,
    stage: schema.status?.stages.get(status) ?? (status ? stageOfName(status) : 'todo'),
    priority: priority || undefined,
    priorityColor: schema.priority ? chipOf(props[schema.priority.name])?.color : undefined,
    assignees: people(props[schema.assignee]?.people),
    severity: schema.severity ? chipOf(props[schema.severity]) : undefined,
    kind: schema.kind ? chipOf(props[schema.kind]) : undefined,
    priorityRank: rank >= 0 ? rank : (schema.priority?.options.length ?? 0),
    projects: schema.project ? ((props[schema.project.name]?.relation ?? []) as { id: string }[]).map((r) => String(r.id)) : [],
    tickets: schema.tickets ? (props[schema.tickets]?.relation ?? []).length : 0,
    updatedAt: String(page.last_edited_time ?? ''),
  };
}

/** Whether a task is linked to a project; ids compare without their dashes. */
export function inProject(task: NotionTask, projectId: string): boolean {
  const want = projectId.replace(/-/g, '');
  return task.projects.some((p) => p.replace(/-/g, '') === want);
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|ogv)$/i;
const AUDIO_RE = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;

/** What kind of file a name (or else its link) says it is. */
export function fileKind(name: string, url: string): NotionFile['kind'] {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    // not a link we can read
  }
  const test = (re: RegExp) => re.test(name) || re.test(path);
  if (test(IMAGE_RE)) return 'image';
  if (test(VIDEO_RE)) return 'video';
  if (test(AUDIO_RE)) return 'audio';
  if (test(/\.pdf$/i)) return 'pdf';
  return 'file';
}

function files(raw: unknown): NotionFile[] {
  return (Array.isArray(raw) ? raw : [])
    .map((f: any) => {
      const url = String(f?.file?.url ?? f?.external?.url ?? '');
      const name = String(f?.name ?? '') || decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'file';
      return { name, url, kind: fileKind(name, url) };
    })
    .filter((f) => /^https?:\/\//i.test(f.url));
}

function people(raw: unknown): NotionPerson[] {
  return (Array.isArray(raw) ? raw : []).filter((u: any) => u?.name).map((u: any) => ({ name: String(u.name), avatar: typeof u.avatar_url === 'string' ? u.avatar_url : undefined }));
}

/** A date as people read it: the day, and the time when there is one; nothing for the formula placeholder 1970-01-01. */
function day(d: any): string {
  const fmt = (v: unknown) => (typeof v === 'string' && v ? (v.includes('T') && !/T00:00:00(\.000)?(Z|[+-]00:00)?$/.test(v) ? v.slice(0, 16).replace('T', ' ') : v.slice(0, 10)) : '');
  const start = fmt(d?.start);
  if (!start || start.startsWith('1970-01-01')) return '';
  const end = fmt(d?.end);
  return end ? `${start} → ${end}` : start;
}

/** Texts that are read as paragraphs however short they are: a ticket's description, how to reproduce it… */
const TEXT_RE = /descri|repro|note|comment|détail|detail|context|steps|étapes/i;

/** A property's value, ready to show; undefined when it's empty. */
export function formatProp(name: string, v: any, relationNames?: (ids: string[]) => string[]): NotionProp | undefined {
  const type = String(v?.type ?? '');
  const val = v?.[type];
  const out: NotionProp = { name, type };
  const text = (t: string) => {
    const s = t.trim();
    if (!s || s === '—') return undefined;
    return { ...out, text: s, long: s.length > 90 || s.includes('\n') || (type === 'rich_text' && TEXT_RE.test(name)) };
  };
  switch (type) {
    case 'title':
    case 'rich_text':
      return text(plain(val));
    case 'number':
      return val == null ? undefined : { ...out, text: String(val) };
    case 'select':
    case 'status':
      return val?.name ? { ...out, text: String(val.name) } : undefined;
    case 'multi_select': {
      const items = (val ?? []).map((o: any) => String(o?.name ?? '')).filter(Boolean);
      return items.length ? { ...out, items } : undefined;
    }
    case 'date':
      return text(day(val));
    case 'created_time':
    case 'last_edited_time':
      return text(day({ start: val }));
    case 'people':
    case 'created_by':
    case 'last_edited_by': {
      const ps = people(Array.isArray(val) ? val : [val]);
      return ps.length ? { ...out, people: ps } : undefined;
    }
    case 'files': {
      const fs = files(val);
      return fs.length ? { ...out, files: fs } : undefined;
    }
    case 'checkbox':
      return val === true ? { ...out, text: '✔︎' } : undefined;
    case 'url':
      return typeof val === 'string' && val ? { ...out, text: val, href: val } : undefined;
    case 'email':
      return typeof val === 'string' && val ? { ...out, text: val, href: `mailto:${val}` } : undefined;
    case 'phone_number':
      return typeof val === 'string' && val ? { ...out, text: val, href: `tel:${val}` } : undefined;
    case 'unique_id':
      return val?.number != null ? { ...out, text: val.prefix ? `${val.prefix}-${val.number}` : String(val.number) } : undefined;
    case 'formula': {
      const t = val?.type;
      if (t === 'date') return text(day(val.date));
      if (t === 'boolean') return val.boolean ? { ...out, text: '✔︎' } : undefined;
      return val?.[t] == null ? undefined : text(String(val[t]));
    }
    case 'relation': {
      const ids = (val ?? []).map((r: any) => String(r?.id ?? '')).filter(Boolean);
      if (!ids.length) return undefined;
      const names = relationNames?.(ids) ?? [];
      return names.length === ids.length ? { ...out, items: names } : { ...out, text: `${ids.length} linked` };
    }
    case 'rollup': {
      if (val?.type === 'number') return val.number == null ? undefined : { ...out, text: String(val.number) };
      if (val?.type === 'date') return text(day(val.date));
      // An array of other properties' values: each one shown as they would be.
      const parts = ((val?.array ?? []) as any[]).map((x) => formatProp(name, x)).filter((p): p is NotionProp => !!p);
      const ps = parts.flatMap((p) => p.people ?? []);
      const fs = parts.flatMap((p) => p.files ?? []);
      const items = [...new Set(parts.flatMap((p) => p.items ?? (p.text ? [p.text] : [])))];
      if (ps.length) return { ...out, people: ps };
      if (fs.length) return { ...out, files: fs };
      return items.length ? { ...out, items } : undefined;
    }
    default:
      return undefined;
  }
}

/** A page's title and properties, as the task window shows them; `skip` leaves properties out. */
export function pageProps(page: any, skip: Set<string> = new Set(), relationNames?: (ids: string[]) => string[]): { title: string; props: NotionProp[] } {
  let title = '';
  const props: NotionProp[] = [];
  for (const [name, v] of Object.entries(page?.properties ?? {}) as [string, any][]) {
    if (v?.type === 'title') {
      title = plain(v.title).trim();
      continue;
    }
    if (skip.has(name)) continue;
    const p = formatProp(name, v, relationNames);
    if (p) props.push(p);
  }
  return { title: title || 'Untitled', props };
}

/** Blocks of a page whose comments are read, from the top. */
const MAX_COMMENTED_BLOCKS = 60;

/** A page's or a block's open comments, all of them. */
async function listComments(blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const res = await api<{ results?: any[]; has_more?: boolean; next_cursor?: string | null }>(`v1/comments?block_id=${blockId}&page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...(res.results ?? []));
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** `fn` over `items`, `size` at a time. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** The start of a block's text, to say which part of the page a comment is about. */
function blockSnippet(b: any): string | undefined {
  const t = plain(b?.[b?.type]?.rich_text).trim();
  if (t) return t.length > 90 ? `${t.slice(0, 88)}…` : t;
  return b?.type === 'image' ? 'an image' : b?.type ? `a ${String(b.type).replace(/_/g, ' ')}` : undefined;
}

/** Notion rich text as markdown: bold, italics, strikethrough, code and links kept; mentions as their names. */
export function richToMarkdown(rich: unknown): string {
  if (!Array.isArray(rich)) return '';
  return rich
    .map((r: any) => {
      let t = String(r?.plain_text ?? '');
      if (!t) return '';
      const a = r?.annotations ?? {};
      // Markers go around the words, not the spaces and line breaks next to them, or markdown ignores them.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t) ?? ['', '', t, ''];
      if (!core) return t;
      let m = core;
      if (a.code) m = `\`${m}\``;
      else {
        if (a.bold) m = `**${m}**`;
        if (a.italic) m = `_${m}_`;
        if (a.strikethrough) m = `~~${m}~~`;
      }
      const href = r?.href ?? r?.text?.link?.url;
      if (typeof href === 'string' && /^https?:\/\//i.test(href)) m = `[${m}](${href})`;
      t = `${lead}${m}${trail}`;
      return t;
    })
    .join('');
}

/** How many linked tickets the task window reads. */
const MAX_TICKETS = 10;
/** A task's details are read again after this long (Notion's file links last an hour). */
const DETAIL_TTL_MS = 60_000;

interface Saved {
  database?: NotionRef;
}

/**
 * The building's Notion connection: which database the tasks are in (saved in <office>/notion.json),
 * who `ntn` is logged in as, and the tasks assigned to them. One fetch serves every floor.
 */
export class Notion {
  tasks: GhState<NotionTask> = { items: [], fetchedAt: 0, loading: false };
  database?: NotionRef;
  me?: { id: string; name: string };
  private file: string;
  private schema?: { database: string; schema: TaskSchema };
  private projectCache?: { database: string; at: number; projects: Promise<NotionProjectChoice[]> };
  /** Bumped when the database changes, so a fetch from the old one doesn't land. */
  private generation = 0;
  private details = new Map<string, { at: number; detail: Promise<NotionTaskDetail> }>();
  private users = new Map<string, Promise<NotionPerson | undefined>>();

  constructor(
    dataDir: string,
    /** The tasks changed: every floor's board gets its view again. */
    private onChange: () => void,
  ) {
    this.file = path.join(dataDir, 'notion.json');
    try {
      if (existsSync(this.file)) this.database = notionRef((JSON.parse(readFileSync(this.file, 'utf8')) as Saved).database);
    } catch (err) {
      console.error(`agent-office: ${this.file} couldn't be read: ${(err as Error).message}`);
    }
  }

  /** A floor's board: the tasks linked to its project, or every task when it has none. */
  view(project?: NotionRef): NotionState {
    const items = project ? this.tasks.items.filter((t) => inProject(t, project.id)) : this.tasks.items;
    return { ...this.tasks, items, database: this.database, project, me: this.me?.name };
  }

  async refresh(): Promise<void> {
    if (this.tasks.loading) return;
    const gen = this.generation;
    const database = this.database;
    if (!database) {
      this.tasks = { items: [], fetchedAt: Date.now(), loading: false };
      this.onChange();
      return;
    }
    this.tasks = { ...this.tasks, loading: true };
    this.onChange();
    let next: GhState<NotionTask>;
    try {
      const [schema, me] = await Promise.all([this.schemaOf(database.id), this.whoami()]);
      const mine = { property: schema.assignee, people: { contains: me.id } };
      const done = schema.status ? [...schema.status.stages].filter(([, s]) => s === 'done').map(([name]) => name) : [];
      const type = schema.status?.type ?? 'status';
      const route = `v1/data_sources/${database.id}/query`;
      const [open, finished] = await Promise.all([
        all(route, { filter: done.length ? { and: [mine, ...done.map((name) => ({ property: schema.status!.name, [type]: { does_not_equal: name } }))] } : mine }),
        done.length
          ? api<{ results?: any[] }>(route, {
              filter: { and: [mine, { or: done.map((name) => ({ property: schema.status!.name, [type]: { equals: name } })) }] },
              sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
              page_size: DONE_SHOWN,
            }).then((r) => r.results ?? [])
          : Promise.resolve([]),
      ]);
      const items = [...open, ...finished].map((p) => toTask(p, schema));
      // Most urgent first; within a priority, the one touched last.
      items.sort((a, b) => a.priorityRank - b.priorityRank || b.updatedAt.localeCompare(a.updatedAt));
      next = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      next = { ...this.tasks, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    if (gen !== this.generation) return;
    this.tasks = next;
    this.onChange();
    // The task windows name the projects; have the list ready before anyone opens one.
    if (!next.error) void this.projects().catch(() => undefined);
  }

  /** Databases that could be the tasks database: the ones with a people property, those with a status too first. */
  async databases(): Promise<NotionDatabaseChoice[]> {
    const found = await all('v1/search', { filter: { property: 'object', value: 'data_source' } });
    const choices: (NotionDatabaseChoice & { score: number })[] = [];
    for (const ds of found) {
      const schema = readSchema(ds.properties ?? {});
      if (typeof schema === 'string') continue;
      const id = notionId(ds.id);
      if (!id) continue;
      const score = (schema.status ? 2 : 0) + (schema.project ? 1 : 0) + (ASSIGNEE_RE.test(schema.assignee) ? 1 : 0);
      choices.push({ id, name: plain(ds.title).trim() || 'Untitled', assignee: schema.assignee, score });
    }
    return choices.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map(({ score: _, ...c }) => c);
  }

  /** Makes `id` the tasks database; resolves to why not, if it can't be. */
  async setDatabase(id: string): Promise<string | undefined> {
    let ds: any;
    try {
      ds = await api(`v1/data_sources/${id}`);
    } catch (err) {
      return `Couldn't open that database: ${(err as Error).message}`;
    }
    const schema = readSchema(ds.properties ?? {});
    if (typeof schema === 'string') return schema;
    this.generation++;
    this.database = { id, name: plain(ds.title).trim() || 'Untitled' };
    this.schema = { database: id, schema };
    this.projectCache = undefined;
    this.tasks = { items: [], fetchedAt: 0, loading: false };
    try {
      writeFileSync(this.file, JSON.stringify({ database: this.database } satisfies Saved, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
    void this.refresh();
    return undefined;
  }

  /**
   * A task on the board with everything Notion has on it: its properties, its content, and the
   * tickets it links to with theirs. Only tasks on the board can be asked for.
   */
  async taskDetail(id: string): Promise<NotionTaskDetail | undefined> {
    const want = id.replace(/-/g, '');
    if (!this.tasks.items.some((t) => t.id.replace(/-/g, '') === want)) return undefined;
    const hit = this.details.get(want);
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail;
    const detail = this.readTask(id);
    this.details.set(want, { at: Date.now(), detail });
    detail.catch(() => this.details.delete(want));
    // Old ones go, so the map doesn't grow with every task anyone opened.
    for (const [k, v] of this.details) if (Date.now() - v.at > DETAIL_TTL_MS) this.details.delete(k);
    return detail;
  }

  private async readTask(id: string): Promise<NotionTaskDetail> {
    const database = this.database;
    if (!database) throw new Error('Pick the Notion tasks database first');
    const schema = await this.schemaOf(database.id);
    // The project's names come from the list of projects, read once in a while for the dropdowns too.
    const [page, body, talk, projects] = await Promise.all([api(`v1/pages/${id}`), this.content(id), this.comments(id), schema.project ? this.projects().catch(() => []) : Promise.resolve([])]);
    const ticketIds = schema.tickets ? ((page.properties?.[schema.tickets]?.relation ?? []) as { id: string }[]).map((r) => String(r.id)) : [];
    const projectNames = (ids: string[]) => ids.map((i) => projects.find((p) => p.id.replace(/-/g, '') === i.replace(/-/g, ''))?.name).filter((n): n is string => !!n);
    const skip = new Set([schema.tickets, schema.ref].filter((k): k is string => !!k));
    const { title, props } = pageProps(page, skip, projectNames);
    // A relation that isn't the project is just a count; only the project's names are known here.
    for (const p of props) if (p.type === 'relation' && p.name !== schema.project?.name && p.items) delete p.items;
    const tickets = await Promise.all(ticketIds.slice(0, MAX_TICKETS).map((t) => this.page(t)));
    return { id: String(page.id), url: String(page.url ?? ''), title, props, ...body, ...talk, tickets, moreTickets: Math.max(0, ticketIds.length - MAX_TICKETS) };
  }

  /** A linked page (a ticket) with its properties and content; what went wrong, in place of it, if it can't be read. */
  private async page(id: string): Promise<NotionPageDetail> {
    try {
      const [page, body, talk] = await Promise.all([api(`v1/pages/${id}`), this.content(id), this.comments(id)]);
      const { title, props } = pageProps(page);
      return { id: String(page.id), url: String(page.url ?? ''), title, props, ...body, ...talk };
    } catch (err) {
      return { id, url: `https://www.notion.so/${id.replace(/-/g, '')}`, title: 'A linked ticket', props: [], markdown: '', markdownError: (err as Error).message, comments: [] };
    }
  }

  /**
   * A page's open comments: the ones on the page, and the ones left on the blocks at its top level
   * (where comments on its text are). Oldest first; why not, when they can't be read.
   */
  private async comments(id: string): Promise<Pick<NotionPageDetail, 'comments' | 'commentsError'>> {
    try {
      const [onPage, blocks] = await Promise.all([listComments(id), api<{ results?: any[] }>(`v1/blocks/${id}/children?page_size=100`).then((r) => r.results ?? [])]);
      // Only blocks that hold something to comment on; a few at a time, so a long page doesn't flood Notion.
      const commentable = blocks.filter((b) => !['divider', 'column_list', 'child_database', 'table_of_contents', 'breadcrumb'].includes(b?.type)).slice(0, MAX_COMMENTED_BLOCKS);
      const onBlocks = await inBatches(commentable, 8, async (b) => (await listComments(String(b.id))).map((c) => ({ c, on: blockSnippet(b) })));
      const raw = [...onPage.map((c) => ({ c, on: undefined as string | undefined })), ...onBlocks.flat()];
      const comments = await Promise.all(raw.map(({ c, on }) => this.toComment(c, on)));
      return { comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
    } catch (err) {
      return { comments: [], commentsError: (err as Error).message };
    }
  }

  private async toComment(c: any, on?: string): Promise<NotionComment> {
    const who = c?.created_by?.id ? await this.user(String(c.created_by.id)) : undefined;
    return {
      id: String(c.id),
      discussion: String(c.discussion_id ?? c.id),
      author: String(c?.display_name?.resolved_name ?? who?.name ?? 'Someone'),
      avatar: who?.avatar,
      createdAt: String(c.created_time ?? ''),
      text: richToMarkdown(c.rich_text),
      files: ((c.attachments ?? []) as any[])
        .map((a) => {
          const url = String(a?.file?.url ?? '');
          const name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'file';
          const kind: NotionFile['kind'] = a?.category === 'image' || a?.category === 'video' || a?.category === 'audio' || a?.category === 'pdf' ? a.category : fileKind(name, url);
          return { name, url, kind };
        })
        .filter((f) => /^https?:\/\//i.test(f.url)),
      ...(on ? { on } : {}),
    };
  }

  /** Who a user is, for their avatar next to their comments; asked of Notion once per person. */
  private user(id: string): Promise<NotionPerson | undefined> {
    let p = this.users.get(id);
    if (!p) {
      p = api<any>(`v1/users/${id}`).then(
        (u) => (u?.name ? { name: String(u.name), avatar: typeof u.avatar_url === 'string' ? u.avatar_url : undefined } : undefined),
        () => undefined,
      );
      this.users.set(id, p);
    }
    return p;
  }

  /** A page's content in Notion's markdown; why not, when it can't be read. */
  private async content(id: string): Promise<Pick<NotionPageDetail, 'markdown' | 'truncated' | 'markdownError'>> {
    try {
      const md = await api<{ markdown?: string; truncated?: boolean }>(`v1/pages/${id}/markdown`);
      return { markdown: String(md.markdown ?? ''), truncated: md.truncated === true || undefined };
    } catch (err) {
      return { markdown: '', markdownError: (err as Error).message };
    }
  }

  /** The projects the tasks database links to: open ones first. */
  async projects(refresh = false): Promise<NotionProjectChoice[]> {
    const database = this.database;
    if (!database) throw new Error('Pick the Notion tasks database first');
    const cached = this.projectCache;
    if (cached && cached.database === database.id && !refresh && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.projects;
    const projects = this.listProjects(database.id);
    this.projectCache = { database: database.id, at: Date.now(), projects };
    projects.catch(() => {
      if (this.projectCache?.projects === projects) this.projectCache = undefined;
    });
    return projects;
  }

  private async listProjects(database: string): Promise<NotionProjectChoice[]> {
    const schema = await this.schemaOf(database);
    if (!schema.project) throw new Error("The tasks database has no relation to a projects database (a relation property named like \"Projet\" or \"Project\")");
    const pages = await all(`v1/data_sources/${schema.project.dataSource}/query`, {}, 10);
    const projects = pages
      .filter((p) => !p.in_trash && !p.archived)
      .map((p): NotionProjectChoice => {
        const props = Object.values(p.properties ?? {}) as any[];
        const st = props.find((v) => v?.type === 'status') ?? props.find((v) => v?.type === 'select');
        const status = (st?.status ?? st?.select)?.name as string | undefined;
        return { id: String(p.id), name: plain(props.find((v) => v?.type === 'title')?.title).trim() || 'Untitled', status, closed: !!status && stageOfName(status) === 'done' };
      });
    return projects.sort((a, b) => Number(a.closed) - Number(b.closed) || a.name.localeCompare(b.name));
  }

  private async schemaOf(database: string): Promise<TaskSchema> {
    if (this.schema?.database === database) return this.schema.schema;
    const ds = await api(`v1/data_sources/${database}`);
    const schema = readSchema(ds.properties ?? {});
    if (typeof schema === 'string') throw new Error(schema);
    this.schema = { database, schema };
    return schema;
  }

  /** The person `ntn` acts for: the tasks are the ones assigned to them. */
  private async whoami(): Promise<{ id: string; name: string }> {
    if (this.me) return this.me;
    const me = await api<any>('v1/users/me');
    const person = me?.type === 'person' ? me : me?.bot?.owner?.type === 'user' ? me.bot.owner.user : undefined;
    if (!person?.id) throw new Error("ntn is logged in as an integration, not a person, so nobody's tasks can be picked out — run `ntn login`");
    this.me = { id: String(person.id), name: String(person.name ?? 'you') };
    return this.me;
  }
}
