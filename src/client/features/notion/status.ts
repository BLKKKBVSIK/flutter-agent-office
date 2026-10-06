import type { NotionTask } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h } from '../../ui/dom';

// Moving a Notion task between the board's columns, by dragging its note or from the status
// dropdown in its window. Either way it's the task's status property that changes, in Notion.

type Stage = NotionTask['stage'];

/** What a dragged note carries, so a drop from anywhere else is ignored. */
const DRAG_TYPE = 'application/x-notion-task';

const STAGE_NAMES: Record<Stage, string> = { todo: 'Not started', doing: 'In progress', done: 'Completed' };

/** A status that means waiting on someone (En attente / bloquer): it shares the column of the status before it. */
const WAITING_RE = /attente|bloqu|blocked|waiting|on hold|pause/i;
const STAGE_ICONS: Record<Stage, string> = { todo: '📥', doing: '🚧', done: '✅' };

/** One of the board's columns: the task statuses it holds, and the one a task dropped on it gets. */
export interface Column {
  title: string;
  /** What a task dropped here is set to; none for the columns of a database without a status. */
  status?: string;
  /** The statuses whose tasks are in it. */
  holds: Set<string>;
  items: NotionTask[];
}

/**
 * The board's columns, from the status property's options in Notion's order: one per open status
 * (a waiting or blocked one joins the column before it), and one for every finished status, named
 * after the first. A task whose status isn't among them goes by its stage. Without a status
 * property, the columns are the three stages.
 */
export function boardColumns(items: NotionTask[]): Column[] {
  const statuses = store.notion.statuses ?? [];
  const cols: (Column & { stage: Stage })[] = [];
  for (const s of statuses.filter((x) => x.stage !== 'done')) {
    const last = cols[cols.length - 1];
    if (last && WAITING_RE.test(s.name) && !WAITING_RE.test(last.title)) last.holds.add(s.name);
    else cols.push({ title: `${/valid|review|relect|test/i.test(s.name) ? '🔍' : STAGE_ICONS[s.stage]} ${s.name}`, status: s.name, stage: s.stage, holds: new Set([s.name]), items: [] });
  }
  const done = statuses.filter((x) => x.stage === 'done');
  if (done.length) cols.push({ title: `${STAGE_ICONS.done} ${done[0].name}`, status: done[0].name, stage: 'done', holds: new Set(done.map((x) => x.name)), items: [] });
  for (const stage of ['todo', 'doing', 'done'] as const) {
    if (!cols.some((c) => c.stage === stage)) cols.push({ title: `${STAGE_ICONS[stage]} ${STAGE_TITLES[stage]}`, stage, holds: new Set(), items: [] });
  }
  cols.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]);
  for (const t of items) (cols.find((c) => c.holds.has(t.status)) ?? cols.find((c) => c.stage === t.stage)!).items.push(t);
  // Finished tasks: the latest first. The others stay in the board's order, the worst severity first.
  for (const c of cols) if (c.stage === 'done') c.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // A stage column nothing is in and nothing can be dropped on is left out.
  return cols.filter((c) => c.status || c.items.length || !statuses.length);
}

const STAGE_TITLES: Record<Stage, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };
const STAGE_ORDER: Record<Stage, number> = { todo: 0, doing: 1, done: 2 };

/** Whether tasks can be moved at all: the database has a status property. */
export function canMove(): boolean {
  return !!store.notion.statuses?.length;
}

function send(net: Net, t: NotionTask, status: string) {
  if (status && status !== t.status) net.send({ t: 'notion.status', id: t.id, status });
}

/** Makes a note draggable to another column; `dragging` hears when a drag starts and ends. */
export function draggableNote(li: HTMLElement, t: NotionTask, dragging: (on: boolean) => void) {
  if (!canMove()) return;
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_TYPE, t.id);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
    dragging(true);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragging(false);
  });
}

/** Makes a column take the notes dropped on it, setting each to the column's status. */
export function dropColumn(net: Net, col: HTMLElement, column: Column) {
  const status = column.status;
  if (!canMove() || !status) return;
  const ours = (e: DragEvent) => !!e.dataTransfer?.types.includes(DRAG_TYPE);
  col.addEventListener('dragover', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    col.classList.add('drop');
  });
  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget as Node | null)) col.classList.remove('drop');
  });
  col.addEventListener('drop', (e) => {
    col.classList.remove('drop');
    if (!ours(e)) return;
    e.preventDefault();
    const t = store.notion.items.find((x) => x.id === e.dataTransfer!.getData(DRAG_TYPE));
    if (!t || column.holds.has(t.status)) return;
    send(net, t, status);
  });
}

/**
 * The task window's status: a dropdown of the status property's options, by column, that sets it
 * in Notion. It follows the board, so it shows a change made elsewhere, or one Notion refused.
 */
export function statusPicker(net: Net, t: NotionTask, onStage: (stage: Stage) => void): { el: HTMLSelectElement; destroy(): void } {
  const statuses = store.notion.statuses ?? [];
  const el = h('select.provider-select.nt-status', { 'aria-label': 'Status', title: 'Change the task’s status in Notion' }) as HTMLSelectElement;
  const groups = (['todo', 'doing', 'done'] as const).map((stage) => [stage, statuses.filter((s) => s.stage === stage)] as const).filter(([, list]) => list.length);
  el.append(...groups.map(([stage, list]) => h('optgroup', { label: STAGE_NAMES[stage] }, ...list.map((s) => h('option', { value: s.name }, s.name)))));
  if (t.status && !statuses.some((s) => s.name === t.status)) el.prepend(h('option', { value: t.status }, t.status));
  let current = t;
  el.value = t.status;
  el.addEventListener('change', () => {
    const picked = statuses.find((s) => s.name === el.value);
    if (!picked) return;
    send(net, current, picked.name);
    onStage(picked.stage);
  });
  const off = store.on('notion', () => {
    const now = store.notion.items.find((x) => x.id === t.id);
    if (!now) return;
    current = now;
    if (el.value !== now.status) {
      el.value = now.status;
      onStage(now.stage);
    }
  });
  return { el, destroy: off };
}
