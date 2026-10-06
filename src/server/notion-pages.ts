// Reading Notion's pages for the 🗂️ Notion board (see notion.ts): a tasks database's schema, a page
// as a task card, its properties ready to show, and rich text as markdown. No calls to Notion here.
import type { NotionChip, NotionColor, NotionFile, NotionPerson, NotionProp, NotionTask } from '../shared/protocol.js';

export function plain(rich: unknown): string {
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

const STATUS_RE = /statu|état|etat|state|stage/i;
const PRIORITY_RE = /priorit/i;
const SEVERITY_RE = /s[ée]v[ée]rit|severity|gravit/i;
const KIND_RE = /(^|[^\p{L}])type$/iu;

export const ASSIGNEE_RE = /assign|attribu|responsable|owner|propriétaire/i;

/** Reads the tasks database's properties: which one is the assignee, the status, the project… */
export function readSchema(properties: Record<string, any>): TaskSchema | string {
  const entries = Object.entries(properties ?? {});
  const named = (type: string, re?: RegExp) => entries.find(([k, v]) => v?.type === type && (!re || re.test(k)));
  const title = named('title');
  const people = named('people', ASSIGNEE_RE) ?? named('people');
  if (!title) return "That database has no title property, so it can't be the tasks database";
  if (!people) return 'That database has no people property to assign tasks in';
  const schema: TaskSchema = { title: title[0], assignee: people[0] };
  // A priority can be a status property too, so the status is looked for by its name first.
  const status = named('status', STATUS_RE) ?? entries.find(([k, v]) => v?.type === 'status' && !PRIORITY_RE.test(k)) ?? named('select', STATUS_RE);
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
  const priority = named('select', PRIORITY_RE) ?? named('status', PRIORITY_RE);
  if (priority && priority[0] !== schema.status?.name) schema.priority = { name: priority[0], options: (((priority[1].select ?? priority[1].status)?.options ?? []) as { name: string }[]).map((o) => o.name) };
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

/** Severities by name, worst first: French and English, and S1…/P0… scales. */
const SEVERITY_TIERS = [/bloq|block|critiq|critical|urgen|fatal|^\W*[sp][01]\b/i, /majeur|major|grave|high|haut|[ée]lev|important|s[ée]v[èe]re|^\W*[sp]2\b/i, /moyen|medium|normal|mod[ée]r|^\W*[sp]3\b/i, /mineur|minor|low|bas|faible|cosm|trivial|^\W*[sp][4-9]\b/i];
/** For a name it can't place, Notion's color says it: red is the worst. */
const SEVERITY_COLORS: Partial<Record<NotionColor, number>> = { red: 0, orange: 1, yellow: 2, green: 3, blue: 3, gray: 3 };

/** How bad a severity is, 0 worst; 4 when neither its name nor its color says, 5 when there's none. */
export function severityRank(sev?: NotionChip): number {
  if (!sev) return 5;
  if (/non[\s-]?(bloq|block)/i.test(sev.name)) return 3;
  const tier = SEVERITY_TIERS.findIndex((re) => re.test(sev.name));
  return tier >= 0 ? tier : (sev.color && SEVERITY_COLORS[sev.color]) ?? 4;
}

/** A row of the tasks database as the board shows it. */
export function toTask(page: any, schema: TaskSchema): NotionTask {
  const props = page?.properties ?? {};
  const st = schema.status ? props[schema.status.name] : undefined;
  const status = String((st?.status ?? st?.select)?.name ?? '');
  const pr = schema.priority ? props[schema.priority.name] : undefined;
  const priority = (pr?.select ?? pr?.status)?.name as string | undefined;
  const uid = schema.ref ? props[schema.ref]?.unique_id : undefined;
  const rank = priority && schema.priority ? schema.priority.options.indexOf(priority) : -1;
  const severity = schema.severity ? chipOf(props[schema.severity]) : undefined;
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
    severity,
    severityRank: severityRank(severity),
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

export function files(raw: unknown): NotionFile[] {
  return (Array.isArray(raw) ? raw : [])
    .map((f: any) => {
      const url = String(f?.file?.url ?? f?.external?.url ?? '');
      const name = String(f?.name ?? '') || decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'file';
      return { name, url, kind: fileKind(name, url) };
    })
    .filter((f) => /^https?:\/\//i.test(f.url));
}

export function people(raw: unknown): NotionPerson[] {
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

/** The start of a block's text, to say which part of the page a comment is about. */
export function blockSnippet(b: any): string | undefined {
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
