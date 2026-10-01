import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, inProject, notionRef, pageProps, readSchema, richToMarkdown, toTask, type TaskSchema } from '../src/server/notion.js';

// Shaped like the properties of a Notion tasks database, as /v1/data_sources/:id returns them.
const PROPERTIES = {
  'Nom de la tâche': { type: 'title' },
  'En attente de': { type: 'people' },
  'Personne assignée': { type: 'people' },
  État: {
    type: 'status',
    status: {
      options: [
        { id: 'a', name: 'Pas commencé' },
        { id: 'b', name: 'En cours' },
        { id: 'c', name: 'À valider' },
        { id: 'd', name: 'Terminé' },
        { id: 'e', name: 'Archivé' },
      ],
      groups: [
        { name: 'To-do', option_ids: ['a'] },
        { name: 'In progress', option_ids: ['b', 'c'] },
        { name: 'Complete', option_ids: ['d', 'e'] },
      ],
    },
  },
  Priorité: { type: 'select', select: { options: [{ name: 'Urgent' }, { name: 'Prioritaire' }, { name: 'Tâche de fond' }] } },
  Projet: { type: 'relation', relation: { data_source_id: 'projects-ds' } },
  'Tickets liés': { type: 'relation', relation: { data_source_id: 'tickets-ds' } },
  'Identifiant de la tâche': { type: 'unique_id' },
  'ℹ️ Sévérité': { type: 'rollup' },
  'ℹ️ Type': { type: 'rollup' },
};

const schema = () => readSchema(PROPERTIES) as TaskSchema;

test('the schema is read from the properties: the assignee over another people property, the status groups, the project', () => {
  const s = schema();
  assert.equal(s.title, 'Nom de la tâche');
  assert.equal(s.assignee, 'Personne assignée');
  assert.equal(s.status?.name, 'État');
  assert.deepEqual(Object.fromEntries(s.status!.stages), { 'Pas commencé': 'todo', 'En cours': 'doing', 'À valider': 'doing', Terminé: 'done', Archivé: 'done' });
  assert.deepEqual(s.priority?.options, ['Urgent', 'Prioritaire', 'Tâche de fond']);
  assert.deepEqual(s.project, { name: 'Projet', dataSource: 'projects-ds' });
  assert.equal(s.tickets, 'Tickets liés');
  assert.equal(s.ref, 'Identifiant de la tâche');
  assert.equal(s.severity, 'ℹ️ Sévérité');
  assert.equal(s.kind, 'ℹ️ Type');
});

test('a database with nobody to assign tasks to is not a tasks database', () => {
  assert.equal(typeof readSchema({ Name: { type: 'title' }, Status: { type: 'select', select: { options: [] } } }), 'string');
});

test('a page becomes a task: its id, status stage, priority rank, projects and tickets', () => {
  const t = toTask(
    {
      id: 'page-1',
      url: 'https://www.notion.so/page-1',
      last_edited_time: '2026-09-30T10:00:00.000Z',
      properties: {
        'Nom de la tâche': { title: [{ plain_text: 'Fix the ' }, { plain_text: 'onboarding' }] },
        État: { status: { name: 'À valider' } },
        Priorité: { type: 'select', select: { name: 'Prioritaire', color: 'orange' } },
        'Personne assignée': { type: 'people', people: [{ name: 'Enzo Conty', avatar_url: 'https://x/e.png' }, { name: 'Jocelyn Girard' }] },
        'ℹ️ Sévérité': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'select', select: { name: 'Majeur', color: 'orange_background' } }] } },
        'ℹ️ Type': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'select', select: { name: 'Bug', color: 'red' } }] } },
        Projet: { relation: [{ id: '3e1c0b44-6df2-8057-8d46-d2117f58a26a' }] },
        'Tickets liés': { relation: [{ id: 't1' }, { id: 't2' }] },
        'Identifiant de la tâche': { unique_id: { prefix: 'TASK', number: 42 } },
      },
    },
    schema(),
  );
  assert.deepEqual(t, {
    id: 'page-1',
    ref: 'TASK-42',
    title: 'Fix the onboarding',
    url: 'https://www.notion.so/page-1',
    status: 'À valider',
    stage: 'doing',
    priority: 'Prioritaire',
    priorityColor: 'orange',
    assignees: [{ name: 'Enzo Conty', avatar: 'https://x/e.png' }, { name: 'Jocelyn Girard', avatar: undefined }],
    severity: { name: 'Majeur', color: 'orange' },
    kind: { name: 'Bug', color: 'red' },
    priorityRank: 1,
    projects: ['3e1c0b44-6df2-8057-8d46-d2117f58a26a'],
    tickets: 2,
    updatedAt: '2026-09-30T10:00:00.000Z',
  });
  assert.ok(inProject(t, '3e1c0b446df280578d46d2117f58a26a'), 'ids match with or without dashes');
  assert.ok(!inProject(t, '31ac0b44-6df2-800f-9a66-fdacbae72ae2'));
});

test('a task with no priority goes after every priority, and an empty one is still a task', () => {
  const t = toTask({ id: 'p', properties: {} }, schema());
  assert.equal(t.priorityRank, 3);
  assert.deepEqual(t.assignees, []);
  assert.equal(t.severity, undefined);
  assert.equal(t.title, 'Untitled');
  assert.equal(t.stage, 'todo');
  assert.equal(t.ref, '');
});

test('a project from a client must carry a Notion id', () => {
  assert.deepEqual(notionRef({ id: '3E1C0B44-6DF2-8057-8D46-D2117F58A26A', name: ' [Maintenance] Application Ezymob ' }), { id: '3e1c0b44-6df2-8057-8d46-d2117f58a26a', name: '[Maintenance] Application Ezymob' });
  assert.equal(notionRef({ id: '../../etc', name: 'x' }), undefined);
  assert.equal(notionRef(null), undefined);
});

test('properties are shown the way Notion means them: rollups flattened, empty ones and the 1970 placeholder left out', () => {
  const page = {
    properties: {
      Sujet: { type: 'title', title: [{ plain_text: 'Les arrêts ne s’affichent pas' }] },
      Description: { type: 'rich_text', rich_text: [{ plain_text: 'Il faut cliquer sur rechercher un arrêt puis revenir sur la carte pour faire apparaitre les arrêts' }] },
      '🧑‍💻 Sévérité': { type: 'select', select: { name: 'Majeur' } },
      'ℹ️ Sévérité': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'select', select: { name: 'Majeur' } }] } },
      'Personne assignée': { type: 'people', people: [{ name: 'Enzo Conty', avatar_url: 'https://x/a.png' }, { id: 'no-name' }] },
      '📬 Pièce(s) jointe(s)': {
        type: 'files',
        files: [
          { name: 'Screenshot.jpg', type: 'external', external: { url: 'https://s3.example/Screenshot.jpg' } },
          { name: 'Screen_Recording.mp4', type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/x/Screen_Recording.mp4?X-Amz-Expires=3600' } },
        ],
      },
      '⚙️ Échéance SLA': { type: 'formula', formula: { type: 'date', date: { start: '1970-01-01T00:00:00.000+00:00' } } },
      '⚙️ Alerte SLA': { type: 'formula', formula: { type: 'string', string: '—' } },
      '📬 Contact': { type: 'email', email: null },
      '🧑‍💻 Périmètre SLA': { type: 'checkbox', checkbox: false },
      '⚙️ Date de réception': { type: 'created_time', created_time: '2026-09-25T14:30:00.000Z' },
      Projet: { type: 'relation', relation: [{ id: 'p1' }] },
      'Tâches liées': { type: 'relation', relation: [{ id: 't1' }, { id: 't2' }] },
    },
  };
  const { title, props } = pageProps(page, new Set(), (ids) => (ids[0] === 'p1' ? ['[Maintenance] Application Ezymob'] : []));
  assert.equal(title, 'Les arrêts ne s’affichent pas');
  const by = Object.fromEntries(props.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by), ['Description', '🧑‍💻 Sévérité', 'ℹ️ Sévérité', 'Personne assignée', '📬 Pièce(s) jointe(s)', '⚙️ Date de réception', 'Projet', 'Tâches liées']);
  assert.equal(by.Description.long, true);
  assert.deepEqual(by['ℹ️ Sévérité'].items, ['Majeur']);
  assert.deepEqual(by['Personne assignée'].people, [{ name: 'Enzo Conty', avatar: 'https://x/a.png' }]);
  assert.deepEqual(by['📬 Pièce(s) jointe(s)'].files?.map((f) => f.kind), ['image', 'video']);
  assert.equal(by['⚙️ Date de réception'].text, '2026-09-25 14:30');
  assert.deepEqual(by.Projet.items, ['[Maintenance] Application Ezymob']);
  assert.equal(by['Tâches liées'].text, '2 linked');
});

test('a file is known by its name, or else by its link', () => {
  assert.equal(fileKind('IMG_3106.PNG', ''), 'image');
  assert.equal(fileKind('recording', 'https://s3.example/a/b/clip.mov?sig=1'), 'video');
  assert.equal(fileKind('report.pdf', ''), 'pdf');
  assert.equal(fileKind('photo.heic', ''), 'file', 'browsers can’t show HEIC, so it’s a link');
});

test('comment text keeps its bold, links and code, with the markers around the words', () => {
  const b = { bold: true, italic: false, strikethrough: false, code: false };
  const plainA = { bold: false, italic: false, strikethrough: false, code: false };
  assert.equal(
    richToMarkdown([
      { plain_text: 'Et bien on inverse alors je pense \n\n', annotations: b },
      { plain_text: 'voir ', annotations: plainA },
      { plain_text: 'la maquette', annotations: plainA, href: 'https://figma.com/x' },
      { plain_text: ' et ', annotations: plainA },
      { plain_text: 'site_id', annotations: { ...plainA, code: true } },
    ]),
    '**Et bien on inverse alors je pense** \n\nvoir [la maquette](https://figma.com/x) et `site_id`',
  );
  assert.equal(richToMarkdown(undefined), '');
});
