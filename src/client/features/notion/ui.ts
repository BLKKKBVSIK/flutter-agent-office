import './ui.css';
import { NOTION_COLORS, NOTION_INKS } from '../../../shared/protocol';
import type { NotionChip, NotionComment, NotionFile, NotionPageDetail, NotionProjectChoice, NotionProp, NotionRef, NotionTask, NotionTaskDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, timeAgo } from '../../ui/dom';
import type { BoardActions } from '../../ui/github/prompts';
import { markdown } from '../../ui/markdown';
import { providerPicker } from '../../ui/provider';
import { fromNotion } from './markdown';
import { boardColumns, draggableNote, dropColumn, statusPicker } from './status';

// The 🗂️ Notion board: the tasks assigned to the office's `ntn` login, in the tasks database the
// building reads (picked here the first time), narrowed to the floor's Notion project if it has one.

/** Ask Notion for the projects again after this long. */
const PROJECTS_STALE_MS = 5 * 60_000;

/** The task a worker gets for a Notion task, from the board or the queue; with its details, it names the tickets and attachments too. */
export function notionPrompt(t: NotionTask, detail?: NotionTaskDetail | null): string {
  const name = t.ref ? `${t.ref} "${t.title}"` : `"${t.title}"`;
  const lines = [`Work on Notion task ${name} (${t.url}).`, '', `Read it first with \`ntn pages get ${t.id}\`.`];
  const tickets = detail?.tickets ?? [];
  if (tickets.length) {
    lines.push('', `It comes from ${tickets.length === 1 ? 'this Notion ticket' : 'these Notion tickets'}; read ${tickets.length === 1 ? 'it' : 'each one'} with \`ntn pages get <id>\`:`);
    for (const k of tickets) lines.push(`- ${k.title} (${k.id})`);
  } else if (!detail && t.tickets) lines.push(`Then read the ${t.tickets === 1 ? 'Notion ticket' : `${t.tickets} Notion tickets`} it links to (their ids are in its properties).`);
  const attached = [detail, ...tickets].filter((p): p is NotionPageDetail => !!p).flatMap((p) => p.props.flatMap((x) => x.files ?? []).concat(contentFiles(p.markdown)));
  if (attached.length || !detail) {
    lines.push(
      '',
      `${attached.length ? `Screenshots and recordings are attached (${attached.map((f) => f.name).slice(0, 6).join(', ')}${attached.length > 6 ? '…' : ''}).` : 'There may be screenshots or recordings attached.'} Their links are in \`ntn api v1/pages/<id>\` (files properties) and in \`ntn api v1/pages/<id>/markdown\`; links Notion hosts expire after an hour, so read them fresh, download what you need with curl to a temporary folder and look at the pictures.`,
    );
  }
  const talked = [detail, ...tickets].filter((p): p is NotionPageDetail => !!p && p.comments.length > 0);
  if (talked.length || !detail) {
    lines.push('', `${talked.length ? `There are comments on ${talked.map((p) => (p === detail ? 'the task' : `ticket ${p.id}`)).join(', ')}; they` : 'Comments on the task and its tickets'} often say what was decided — read them with \`ntn api 'v1/comments?block_id=<id>'\`.`);
  }
  lines.push('', 'Create a new branch, implement the change, verify it, then open a pull request that links to the Notion task.');
  return lines.join('\n');
}

function notionContext(t: NotionTask): string {
  return `This is about Notion task ${t.ref ? `${t.ref} ` : ''}"${t.title}" (${t.url}). Read it with \`ntn pages get ${t.id}\`.`;
}

function taskTitle(t: NotionTask): string {
  return `${t.ref ? `${t.ref} ` : ''}${t.title}`;
}

/** A number from a string, for a card's tilt and color. */
function seedOf(s: string): number {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(x);
}

const TILTS = ['-1.2deg', '0.8deg', '-0.4deg', '1.4deg', '0deg', '-0.9deg'];
const NOTE_COLORS = ['#fff7b0', '#ffd6e0', '#caffbf', '#bde0fe', '#ffe5b4'];
const PINS = ['#ef476f', '#118ab2', '#06d6a0', '#ffd166'];

/** A sticky note in one of the board's columns, like the issue board's; `seed` picks its tilt and color. */
function noteCard(seed: number, head: string, title: string, meta: (Node | string)[], i: number, onclick: () => void) {
  return h(
    'li.card',
    {
      style: `--tilt:${TILTS[seed % TILTS.length]};background:${NOTE_COLORS[seed % NOTE_COLORS.length]};--pin:${PINS[i % PINS.length]}`,
      tabindex: 0,
      onclick,
      onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && onclick()) as EventListener,
    },
    h('div.num', {}, head),
    h('div.ttl', {}, title),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
  );
}

function needProjects(net: Net, refresh = false) {
  const p = store.notionProjects;
  if (!store.notion.database || p.loading || (!refresh && p.at && Date.now() - p.at < PROJECTS_STALE_MS && !p.error)) return;
  store.notionProjects = { ...p, loading: true };
  net.send({ t: 'notion.projects', refresh });
}

export interface ProjectPicker {
  el: HTMLSelectElement;
  value(): NotionRef | undefined;
  destroy(): void;
}

/**
 * A dropdown of the Notion projects the tasks link to, open ones first, with "every task" on top.
 * `onChange` hears about picks made in it.
 */
export function notionProjectPicker(net: Net, initial: NotionRef | undefined, onChange?: (project: NotionRef | undefined) => void, none = 'Every task assigned to me'): ProjectPicker {
  let current = initial;
  const el = h('select.provider-select.notion-project', { 'aria-label': 'Notion project', title: 'Only the tasks linked to this Notion project' }) as HTMLSelectElement;
  const option = (p: NotionRef | NotionProjectChoice) => h('option', { value: p.id }, 'status' in p && p.status ? `${p.name} · ${p.status}` : p.name);
  const render = () => {
    const { list, loading, error } = store.notionProjects;
    const open = list.filter((p) => !p.closed);
    const closed = list.filter((p) => p.closed);
    const children: HTMLElement[] = [h('option', { value: '' }, none)];
    // Picked before, and not in the list (renamed, or the list isn't here yet): still shown.
    if (current && !list.some((p) => p.id === current!.id)) children.push(option(current));
    if (open.length) children.push(h('optgroup', { label: 'Projects' }, ...open.map(option)));
    if (closed.length) children.push(h('optgroup', { label: 'Finished' }, ...closed.map(option)));
    if (loading && !list.length) children.push(h('option', { disabled: true }, 'Loading projects…'));
    if (error) children.push(h('option', { disabled: true }, `⚠️ ${error}`));
    el.replaceChildren(...children);
    el.value = current?.id ?? '';
  };
  el.addEventListener('change', () => {
    const id = el.value;
    const p = store.notionProjects.list.find((x) => x.id === id);
    current = id ? (p ? { id: p.id, name: p.name } : current?.id === id ? current : undefined) : undefined;
    onChange?.(current);
  });
  // Every refresh of the board would put the list back to what's picked; a list that's open stays as it is.
  el.addEventListener('focus', () => needProjects(net));
  const off = store.on('notionProjects', render);
  needProjects(net);
  render();
  return { el, value: () => current, destroy: off };
}

/** Whether a task is already on the 📋 queue (it's there by its title, having no issue number). */
function queued(t: NotionTask) {
  return store.queue.tasks.find((q) => q.status !== 'done' && q.title === taskTitle(t));
}

function projectNames(t: NotionTask): string {
  const names = t.projects.map((id) => store.notionProjects.list.find((p) => p.id.replace(/-/g, '') === id.replace(/-/g, ''))?.name).filter(Boolean);
  return names.length ? `📁 ${names.join(', ')}` : '';
}

export function openNotionBoard(net: Net, actions: BoardActions) {
  const body = h('div.body');
  const status = h('span.board-status');
  const pickerSlot = h('span.notion-picker');
  const refresh = h('button.btn', { title: 'Refresh from Notion', onclick: () => net.send({ t: 'notion.refresh' }) }, '🔄 Refresh');
  const setup = h('button.btn', { title: 'Change the Notion database the tasks are read from' }, '⚙️');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h('div.modal.board.notion-board', { role: 'dialog', 'aria-label': 'Notion board' }, h('header', {}, h('h2', {}, '🗂️ Notion'), pickerSlot, status, refresh, setup, close), body);
  /** Picking the database: the first time, or from ⚙️. */
  let choosing = false;
  let picker: ProjectPicker | null = null;
  let pickerFor: string | undefined;
  /** A note is being dragged: the board waits to redraw until it's dropped, so it isn't pulled from under the pointer. */
  let dragging = false;
  let stale = false;

  const statusText = () => {
    const st = store.notion;
    const who = st.me ? ` · assigned to ${st.me}` : '';
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt && st.database ? `${st.database.name}${who} · updated ${timeAgo(st.fetchedAt)}` : '';
  };

  /** The project dropdown, rebuilt only when the database or the floor's project changes, so it keeps focus. */
  const renderPicker = () => {
    const st = store.notion;
    const key = st.database ? `${st.database.id}|${st.project?.id ?? ''}` : undefined;
    if (key === pickerFor) return;
    pickerFor = key;
    picker?.destroy();
    picker = st.database ? notionProjectPicker(net, st.project, (project) => net.send({ t: 'notion.project', project: project ?? null }), 'Every task assigned to me') : null;
    pickerSlot.replaceChildren(...(picker ? [picker.el] : []));
  };

  const renderSetup = () => {
    const d = store.notionDatabases;
    const rows = d.list.map((db) =>
      h(
        'button.notion-db',
        {
          type: 'button',
          class: store.notion.database?.id === db.id ? 'sel' : '',
          onclick: () => {
            choosing = false;
            net.send({ t: 'notion.database', id: db.id });
            store.notion = { ...store.notion, loading: true };
            render();
          },
        },
        h('b', {}, db.name),
        h('small', {}, `assigned in “${db.assignee}”`),
      ),
    );
    body.append(
      h(
        'div.board-error.notion-setup',
        {},
        h('div', {}, 'Which Notion database are your tasks in?'),
        h('small', {}, 'The board shows the ones assigned to you there. It reads Notion with the server’s `ntn` login, the same for every floor.'),
        h('div.notion-dbs', {}, ...(rows.length ? rows : [h('p.empty', {}, d.loading || !d.at ? 'Asking Notion for your databases…' : 'No database with a people property to assign tasks in.')])),
        d.error ? h('p.err', {}, d.error) : '',
        store.notion.database ? h('button.btn', { type: 'button', onclick: () => ((choosing = false), render()) }, 'Keep ' + store.notion.database.name) : '',
      ),
    );
    if (!d.loading && !d.at) {
      store.notionDatabases = { ...d, loading: true };
      net.send({ t: 'notion.databases' });
    }
  };

  const render = () => {
    if (dragging) return void (stale = true);
    stale = false;
    const st = store.notion;
    statusText();
    renderPicker();
    setup.classList.toggle('hidden', !st.database);
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    body.replaceChildren();
    if (choosing || (!st.database && !st.loading)) return renderSetup();
    if (st.error && !st.items.length) {
      body.append(h('div.board-error', {}, `Couldn't load from Notion: ${st.error}`, h('br'), h('small', {}, 'The server runs `ntn` (the Notion CLI) — make sure it is installed and logged in (ntn login).')));
      return;
    }
    for (const col of boardColumns(st.items)) {
      const ul = h('ul');
      col.items.forEach((t, i) => {
        const q = queued(t);
        const note = noteCard(
            seedOf(t.id),
            [t.ref, t.priority].filter(Boolean).join(' · ') || t.status,
            t.title,
            [
              t.severity ? chip(t.severity, '🔥') : '',
              t.kind ? chip(t.kind) : '',
              t.status ? h('span.qchip', {}, t.status) : '',
              q ? h('span.qchip.running', {}, q.status === 'running' ? `🤖 ${q.workerName ?? 'a worker'}` : '📋 queued') : '',
              st.project ? '' : projectNames(t),
              t.tickets ? `🎫 ${t.tickets}` : '',
              t.updatedAt ? timeAgo(t.updatedAt) : '',
              t.assignees.length
                ? h('span.nt-card-people', { title: `Assigned to ${t.assignees.map((p) => p.name).join(', ')}` }, h('span.nt-faces', {}, ...t.assignees.map(person)), t.assignees.map((p) => p.name.split(/\s+/)[0]).join(', '))
                : '',
            ],
            i,
            () => openNotionTask(t, net, actions),
          );
        draggableNote(note, t, (on) => {
          dragging = on;
          // Let the drop land first: it sends the move, and the board redraws with it.
          if (!on && stale) setTimeout(render);
        });
        ul.append(note);
      });
      if (!col.items.length) ul.append(h('li.empty', {}, 'Nothing here'));
      const section = h('section.column', {}, h('h4', {}, col.title, h('span', {}, String(col.items.length))), ul);
      dropColumn(net, section, col);
      body.append(section);
    }
    body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
  };

  setup.addEventListener('click', () => {
    choosing = true;
    store.notionDatabases = { list: store.notionDatabases.list, loading: false, at: 0 };
    render();
  });
  const unsubs = [store.on('notion', render), store.on('notionDatabases', render), store.on('queue', render), store.on('notionProjects', () => !store.notion.project && render())];
  const timer = setInterval(statusText, 15000);
  const modal = openModal(el, {
    doing: '🗂️ at the Notion board',
    onClose: () => {
      unsubs.forEach((u) => u());
      picker?.destroy();
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}

/** Images and other files in a page's content (its markdown), by their links. */
function contentFiles(md: string): NotionFile[] {
  const out: NotionFile[] = [];
  for (const m of md.matchAll(/!\[([^\]]*)\]\((https?:[^)\s]+)\)|<(video|audio|file|pdf)\s+src="(https?:[^"]+)"/g)) {
    const url = m[2] ?? m[4];
    const name = m[1] || decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'file';
    out.push({ name, url, kind: m[2] ? 'image' : (m[3] as NotionFile['kind']) });
  }
  return out;
}

async function getDetail(id: string): Promise<NotionTaskDetail> {
  const r = await fetch(`/api/notion/task?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<NotionTaskDetail>;
}

const KEY_RE = /statu|état|etat|priorit|s[ée]v[ée]rit|severity|\btype\b/i;
const SEVERITY_RE = /s[ée]v[ée]rit|severity/i;
const ASSIGNEE_RE = /assign|attribu|responsable|owner|propriétaire/i;

/** A select's option in its Notion color. */
function chip(c: NotionChip, icon = '') {
  return h('span.nt-chip', { style: `background:${NOTION_COLORS[c.color ?? 'default']};border-color:${NOTION_INKS[c.color ?? 'default']}` }, `${icon ? `${icon} ` : ''}${c.name}`);
}

function person(p: { name: string; avatar?: string }) {
  return h('span.nt-person', {}, p.avatar ? h('img', { src: p.avatar, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }) : h('span.nt-initial', {}, p.name.slice(0, 1)), p.name);
}

/** A property's value: people, chips, a link, or text. */
function value(p: NotionProp): HTMLElement {
  if (p.people) return h('span.nt-people', {}, ...p.people.map(person));
  if (p.files) return h('span.nt-files', {}, ...p.files.map((f) => h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, `📎 ${f.name}`)));
  if (p.items) return h('span.nt-chips', {}, ...p.items.map((i) => h('span.nt-chip', {}, i)));
  if (p.href) return h('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.text ?? '');
  return h('span', {}, p.text ?? '');
}

/** The short properties, as a two-column list of names and values. */
function fields(props: NotionProp[]): HTMLElement {
  return h('dl.nt-fields', {}, ...props.flatMap((p) => [h('dt', {}, p.name), h('dd', {}, value(p))]));
}

/** Pictures as thumbnails that open full size, videos and sound as players, anything else as a link. */
function gallery(list: NotionFile[]): HTMLElement {
  return h(
    'div.nt-gallery',
    {},
    ...list.map((f) => {
      if (f.kind === 'image') return h('a.nt-thumb', { href: f.url, target: '_blank', rel: 'noopener noreferrer', title: f.name }, h('img', { src: f.url, alt: f.name, loading: 'lazy', referrerpolicy: 'no-referrer' }));
      if (f.kind === 'video') return h('figure.nt-video', {}, h('video', { src: f.url, controls: true, preload: 'metadata' }), h('figcaption', {}, f.name));
      if (f.kind === 'audio') return h('figure.nt-audio', {}, h('audio', { src: f.url, controls: true, preload: 'metadata' }), h('figcaption', {}, f.name));
      return h('a.nt-file', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, `${f.kind === 'pdf' ? '📄' : '📎'} ${f.name}`);
    }),
  );
}

/** A page's content, or nothing when it's empty (Notion's templates leave "## Description" and a lone bullet). */
function content(p: NotionPageDetail): HTMLElement | null {
  if (p.markdownError) return h('p.nt-quiet', {}, `Couldn't read the page's content: ${p.markdownError}`);
  // A "Description" heading on top says again what the section's title says.
  const src = fromNotion(p.markdown).replace(/^\s*#{1,3}\s*description\s*(\n|$)/i, '');
  // Empty bullets are what's left of Notion's template; any other text counts, headings too.
  if (!src.replace(/^\s*([-*]|#+)\s*$/gm, '').trim()) return null;
  const el = markdown(src, undefined, { refs: false });
  // Pictures are shown small enough to read the page around them; a click opens one full size.
  for (const img of el.querySelectorAll('img')) {
    if (img.closest('a')) continue;
    const a = h('a.nt-pic', { href: img.getAttribute('src') ?? '', target: '_blank', rel: 'noopener noreferrer' });
    img.replaceWith(a);
    a.append(img);
  }
  if (p.truncated) el.append(h('p.nt-quiet', {}, 'Notion cut this page short — open it in Notion to read the rest.'));
  return el;
}

/** The parts of a page: its long texts, its content, its attachments, then its other fields. */
function pageParts(p: NotionPageDetail, skip: (p: NotionProp) => boolean = () => false): HTMLElement[] {
  const props = p.props.filter((x) => !skip(x));
  const parts: HTMLElement[] = [];
  for (const t of props.filter((x) => x.long && x.text)) parts.push(h('div.nt-text', {}, h('h5', {}, t.name), h('p', {}, t.text!)));
  const body = content(p);
  if (body) parts.push(body);
  const attached = props.flatMap((x) => x.files ?? []);
  if (attached.length) parts.push(h('div.nt-attached', {}, h('h5', {}, `📎 Attachments (${attached.length})`), gallery(attached)));
  const rest = props.filter((x) => !x.long && !x.files);
  if (rest.length) parts.push(h('div.nt-more', {}, h('h5', {}, 'Details'), fields(rest)));
  return parts;
}

/** One comment: who, when, what it's about, its text and attachments. */
function commentEl(c: NotionComment, reply: boolean): HTMLElement {
  return h(
    `div.nt-comment${reply ? '.reply' : ''}`,
    {},
    h('div.nt-comment-head', {}, person({ name: c.author, avatar: c.avatar }), h('span.nt-quiet', { title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt))),
    c.on && !reply ? h('div.nt-on', {}, '↳ on “', c.on, '”') : '',
    c.text.trim() ? markdown(c.text, undefined, { refs: false }) : '',
    c.files.length ? gallery(c.files) : '',
  );
}

/** A page's open comments, as threads: each discussion's first comment and its replies under it. */
function commentsSection(p: NotionPageDetail, heading: 'h3' | 'h5'): HTMLElement | null {
  if (p.commentsError) return h('p.nt-quiet', {}, `Couldn't read the comments: ${p.commentsError}`);
  if (!p.comments.length) return null;
  const threads = new Map<string, NotionComment[]>();
  for (const c of p.comments) threads.set(c.discussion, [...(threads.get(c.discussion) ?? []), c]);
  return h(
    'div.nt-comments',
    {},
    h(heading, {}, `💬 Comments (${p.comments.length})`),
    ...[...threads.values()].map((t) => h('div.nt-thread', {}, ...t.map((c, i) => commentEl(c, i > 0)))),
  );
}

function ticketCard(k: NotionPageDetail): HTMLElement {
  const chips = k.props.filter((x) => KEY_RE.test(x.name) && (x.text || x.items) && !x.long);
  return h(
    'article.nt-ticket',
    {},
    h(
      'header',
      {},
      h('h4', {}, '🎫 ', k.title),
      h('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗'),
    ),
    chips.length ? h('div.nt-chips', {}, ...chips.map((c) => h('span.nt-chip', { title: c.name }, `${c.name.replace(/^[^\p{L}]+/u, '')}: ${c.text ?? c.items!.join(', ')}`))) : '',
    ...(k.markdownError && !k.props.length ? [h('p.nt-quiet', {}, `Couldn't read this ticket: ${k.markdownError}`)] : pageParts(k, (x) => chips.includes(x))),
    commentsSection(k, 'h5') ?? '',
  );
}

function openNotionTask(t: NotionTask, net: Net, actions: BoardActions) {
  let detail: NotionTaskDetail | null = null;
  let error = '';
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = taskTitle(t);
  const meta = h('div.gh-meta');
  const main = h('div.nt-main');
  const side = h('aside.nt-side');
  const onQueue = queued(t);
  const provider = providerPicker(store.project, `notion-provider-${t.id}`, 'Queue provider');
  const queue = h(
    'button.btn',
    {
      type: 'button',
      disabled: !!onQueue,
      title: onQueue ? '' : 'A worker picks it up by itself when a desk is free and there is room under the worker limit',
      onclick: () => {
        if (!provider.valid()) return;
        modal.close();
        net.send({ t: 'queue.add', prompt: notionPrompt(t, detail), title, provider: provider.value(), model: provider.model(), effort: provider.effort() });
      },
    },
    onQueue ? (onQueue.status === 'running' ? `🤖 ${onQueue.workerName ?? 'A worker'} is on it` : '📋 On the queue') : '📋 Add to queue',
  );
  const done = t.stage === 'done';
  const pill = h('span', { class: `pill ${done ? 'offline' : t.stage === 'doing' ? 'working' : 'done'}` }, t.status || t.stage);
  const status = t.status && store.notion.statuses?.length ? statusPicker(net, t, (stage) => (pill.className = `pill nt-status-pill ${stage === 'done' ? 'offline' : stage === 'doing' ? 'working' : 'done'}`)) : null;
  if (status) {
    pill.className += ' nt-status-pill';
    pill.replaceChildren(status.el);
  }
  const el = h(
    'div.modal.gh-window.notion-task',
    { role: 'dialog', 'aria-label': `Notion task ${title}` },
    h('header', {}, pill, h('h2', { title: t.title }, title), close),
    meta,
    h('div.nt-body', {}, main, side),
    h(
      'footer',
      {},
      h('a.grow', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Notion ↗'),
      h('button.btn', { type: 'button', title: 'Send a worker your own prompt about this task', onclick: () => (modal.close(), actions.ask(notionContext(t), `Ask about ${title}`)) }, '✍️ Ask a worker…'),
      done ? null : provider.element,
      done ? null : queue,
      done ? null : h('button.btn.primary', { type: 'button', onclick: () => (modal.close(), actions.assign(notionPrompt(t, detail), `Hand ${title} to a worker`)) }, '🤖 Hand to a worker'),
    ),
  );

  const render = () => {
    const props = detail?.props ?? [];
    const assignees = props.find((p) => p.people && ASSIGNEE_RE.test(p.name)) ?? props.find((p) => p.people) ?? (t.assignees.length ? { name: 'Assigned', type: 'people', people: t.assignees } : undefined);
    const severity = props.find((p) => SEVERITY_RE.test(p.name));
    meta.replaceChildren(
      ...[
        assignees ? h('span.nt-people', { title: assignees.name }, '👤 ', ...assignees.people!.map(person)) : null,
        t.priority ? chip({ name: t.priority, color: t.priorityColor }, '⚡') : null,
        t.severity ? chip(t.severity, '🔥') : severity ? h('span.nt-chip.sev', { title: severity.name }, `🔥 ${severity.text ?? severity.items?.join(', ')}`) : null,
        t.kind ? chip(t.kind) : null,
        projectNames(t) ? h('span', {}, projectNames(t)) : null,
        t.updatedAt ? h('span', {}, `· edited ${timeAgo(t.updatedAt)}`) : null,
      ].filter(Boolean) as HTMLElement[],
    );
    if (error) {
      main.replaceChildren(h('div.gh-error', {}, `Couldn't load from Notion: ${error}`, h('button.btn', { type: 'button', onclick: load }, 'Try again')));
      side.replaceChildren();
      return;
    }
    if (!detail) {
      main.replaceChildren(h('div.gh-loading', {}, h('span.spinner'), 'Reading the task and its tickets from Notion…'));
      side.replaceChildren();
      return;
    }
    const d = detail;
    // The task's long texts, content and attachments; its other fields are in the sidebar.
    const description = pageParts(d, (p) => !p.long && !p.files);
    main.replaceChildren(
      h('section', {}, h('h3', {}, '📝 Description'), ...(description.length ? description : [h('p.nt-quiet', {}, 'Nothing written on the task itself.')])),
      ...(commentsSection(d, 'h3') ? [h('section', {}, commentsSection(d, 'h3')!)] : []),
      h(
        'section',
        {},
        h('h3', {}, `🎫 Linked tickets (${d.tickets.length + d.moreTickets})`),
        ...(d.tickets.length ? d.tickets.map(ticketCard) : [h('p.nt-quiet', {}, 'No Notion ticket is linked to this task.')]),
        d.moreTickets ? h('p.nt-quiet', {}, `…and ${d.moreTickets} more, in Notion.`) : '',
      ),
    );
    side.replaceChildren(h('h3', {}, 'Properties'), fields(d.props.filter((p) => !p.long && !p.files)));
  };

  let generation = 0;
  function load() {
    const g = ++generation;
    error = '';
    render();
    getDetail(t.id).then(
      (d) => {
        if (g !== generation) return;
        detail = d;
        render();
      },
      (err: Error) => {
        if (g !== generation) return;
        error = err.message;
        render();
      },
    );
  }

  const modal = openModal(el, {
    onClose: () => {
      generation++;
      status?.destroy();
    },
  });
  close.addEventListener('click', () => modal.close());
  load();
}
