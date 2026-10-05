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

/** The status a task dropped in a column gets: the first of that column's options in Notion. */
function statusFor(stage: Stage): string | undefined {
  return store.notion.statuses?.find((s) => s.stage === stage)?.name;
}

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
export function dropColumn(net: Net, col: HTMLElement, stage: Stage) {
  if (!canMove()) return;
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
    const status = statusFor(stage);
    if (!t || !status || t.stage === stage) return;
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
