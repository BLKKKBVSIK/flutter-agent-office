import * as THREE from 'three';
import { NOTION_BOARD, WALL_HEIGHT } from '../../../shared/layout';
import { wallFacing } from '../../../shared/decor';
import { NOTION_INKS, type NotionState } from '../../../shared/protocol';
import { textPlane } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { PALETTE } from '../../world/office/materials';
import { wallBoard } from '../../world/office/props';
import { NOTE_COLORS, PINS, clip, wrap } from '../boards/world';

// The 🗂️ Notion board: a cork board in the north-west corner with a sticky note for each Notion task
// assigned to you that isn't done yet, the ones under way first.

declare module '../../world/types' {
  interface OfficeHandles {
    /** The Notion board's face, for its texture (see NotionBoardTexture). */
    notionBoard: THREE.Mesh;
  }
}

/** The board on the wall, its label over it, and E to open it. */
export const notionBoard: Fixture<'notionBoard'> = (site) => {
  const b = NOTION_BOARD;
  // Out from the wall, the way the board faces.
  const nx = Math.sin(b.rotY);
  const nz = Math.cos(b.rotY);
  const { group, face } = wallBoard(b.width, b.height, PALETTE.wood);
  group.position.set(b.x + nx * 0.08, b.y, b.z + nz * 0.08);
  group.rotation.y = b.rotY;
  site.group.add(group);
  const label = textPlane('🗂️ Notion', { bg: '#fffaf3', size: 64 });
  label.scale.multiplyScalar(1.3);
  label.position.set(b.x + nx * 0.04, b.y + b.height / 2 + 0.5, b.z + nz * 0.04);
  label.rotation.y = b.rotY;
  site.group.add(label);
  const it: Interactable = { kind: 'notion', x: b.x + nx * 1.6, z: b.z + nz * 1.6, radius: 2.4 };
  site.interactables.push(it);
  group.userData.interact = it;
  // The board and its label above it, up to the ceiling.
  const bottom = b.y - (b.height + 0.3) / 2;
  site.wall(wallFacing(b.rotY), b.z, (bottom + WALL_HEIGHT) / 2, b.width + 0.3, WALL_HEIGHT - bottom);
  return { handle: { notionBoard: face } };
};

/** A number from a string, to seed a note's color and tilt with, so a note keeps them between redraws. */
function hash(s: string): number {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(x);
}

/** The Notion board's cork and notes, drawn onto a canvas in the board's proportions. */
export class NotionBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas.width = Math.round((600 * NOTION_BOARD.width) / NOTION_BOARD.height);
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(state: NotionState) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#d8a86a';
    g.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 800; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(120,70,30,.18)' : 'rgba(255,240,210,.18)';
      g.fillRect(rnd() * W, rnd() * H, 3, 3);
    }
    const open = state.items.filter((t) => t.stage !== 'done').sort((a, b) => Number(b.stage === 'doing') - Number(a.stage === 'doing'));
    if (!open.length) {
      const empty = !state.database
        ? 'Press E to pick your Notion tasks database'
        : state.error
          ? `⚠️ ${state.error}`
          : state.loading && !state.fetchedAt
            ? 'Loading…'
            : state.project
              ? `No open tasks for you in ${state.project.name} 🎉`
              : 'No open tasks for you 🎉';
      g.font = '800 40px Nunito, ui-rounded, system-ui, sans-serif';
      const boxW = W - 60;
      const lines = wrap(g, empty.replace(/`/g, ''), boxW - 80, 5);
      const boxH = 60 + lines.length * 50;
      g.fillStyle = '#fffaf3';
      g.fillRect(W / 2 - boxW / 2, H / 2 - boxH / 2, boxW, boxH);
      g.fillStyle = '#2b2d42';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      lines.forEach((line, i) => g.fillText(line, W / 2, H / 2 - ((lines.length - 1) * 50) / 2 + i * 50));
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      this.texture.needsUpdate = true;
      return;
    }
    // Fewer notes -> bigger notes, so a quiet board is still readable from across the room.
    const n = Math.min(open.length, 6);
    const cols = n <= 2 ? 1 : 2;
    const rows = Math.ceil(n / cols);
    const nw = (W - 40) / cols - 30;
    const nh = Math.min(260, (H - 40) / rows - 30);
    const gx = (W - cols * nw) / (cols + 1);
    const gy = (H - rows * nh) / (rows + 1);
    open.slice(0, cols * rows).forEach((t, i) => {
      const x = gx + (i % cols) * (nw + gx);
      const y = gy + Math.floor(i / cols) * (nh + gy);
      const s = hash(t.id);
      const ink = t.severity ? NOTION_INKS[t.severity.color ?? 'default'] : undefined;
      g.save();
      g.translate(x + nw / 2, y + nh / 2);
      g.rotate(((s * 37) % 7 - 3) * 0.012);
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.fillRect(-nw / 2 + 5, -nh / 2 + 7, nw, nh);
      g.fillStyle = NOTE_COLORS[s % NOTE_COLORS.length];
      g.fillRect(-nw / 2, -nh / 2, nw, nh);
      // A band down the left edge in the severity's color.
      if (ink) {
        g.fillStyle = ink;
        g.fillRect(-nw / 2, -nh / 2, Math.max(8, nw * 0.045), nh);
      }
      g.fillStyle = '#2b2d42';
      const fs = Math.round(Math.min(30, nh / 6.5));
      const who = t.assignees.map((p) => p.name.split(/\s+/)[0]).join(', ');
      const foot = [t.severity?.name, who].filter(Boolean).join(' · ');
      const footer = foot ? fs * 1.3 : 0;
      g.font = `900 ${Math.round(fs * 1.2)}px Nunito, ui-rounded, system-ui, sans-serif`;
      g.fillText(clip(g, `${t.stage === 'doing' ? '🚧 ' : ''}${t.ref || t.status || 'Task'}`, nw - 28), -nw / 2 + 16, -nh / 2 + fs * 1.9);
      g.font = `700 ${fs}px Nunito, ui-rounded, system-ui, sans-serif`;
      wrap(g, t.title, nw - 32, Math.max(1, Math.floor((nh - fs * 3 - footer) / (fs * 1.1)))).forEach((line, li) => g.fillText(line, -nw / 2 + 16, -nh / 2 + fs * 3.2 + li * fs * 1.1));
      if (foot) {
        // A dot in the severity's color, then the severity and who's on it.
        const r = fs * 0.3;
        const fy = nh / 2 - fs * 0.75;
        g.beginPath();
        g.arc(-nw / 2 + 16 + r, fy, r, 0, Math.PI * 2);
        g.fillStyle = ink ?? '#8d99ae';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = '#2b2d42';
        g.stroke();
        g.fillStyle = '#5c5f73';
        g.font = `800 ${Math.round(fs * 0.78)}px Nunito, ui-rounded, system-ui, sans-serif`;
        g.fillText(clip(g, foot, nw - 32 - r * 2 - 8), -nw / 2 + 16 + r * 2 + 8, fy + fs * 0.28);
      }
      g.beginPath();
      g.arc(0, -nh / 2 + 10, 11, 0, Math.PI * 2);
      g.fillStyle = PINS[i % PINS.length];
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = '#2b2d42';
      g.stroke();
      g.restore();
    });
    if (open.length > cols * rows) {
      g.fillStyle = '#2b2d42';
      g.font = '800 26px Nunito, ui-rounded, system-ui, sans-serif';
      g.textAlign = 'right';
      g.fillText(`+${open.length - cols * rows} more`, W - 20, H - 12);
      g.textAlign = 'left';
    }
    this.texture.needsUpdate = true;
  }
}
