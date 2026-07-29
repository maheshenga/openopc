import { expect, test } from 'bun:test';

import { groupOpenOpcSearchResults, type OpenOpcSearchResult } from './openopc-search';

test('groups matching tasks, agents, modules, projects, and files in a stable order', () => {
  const results: OpenOpcSearchResult[] = [
    { kind: 'file', id: 'f1', title: 'README.md', href: '/files/README.md' },
    { kind: 'task', id: 't1', title: 'Deploy agent', href: '/tasks/t1' },
    { kind: 'module', id: 'm1', title: 'Image pipeline', href: '/developer/modules/m1' },
    { kind: 'agent', id: 'a1', title: 'Research agent', href: '/agents/a1' },
    { kind: 'project', id: 'p1', title: 'OpenOPC', href: '/projects/p1' },
  ];

  const grouped = groupOpenOpcSearchResults(results, 'research');

  expect(grouped.map((group) => group.kind)).toEqual(['agent']);
  expect(grouped[0]?.items).toEqual([
    { kind: 'agent', id: 'a1', title: 'Research agent', href: '/agents/a1' },
  ]);
});

test('keeps all five result groups available when the query is empty', () => {
  const results: OpenOpcSearchResult[] = [
    { kind: 'task', id: 't1', title: 'Task', href: '/tasks/t1' },
    { kind: 'agent', id: 'a1', title: 'Agent', href: '/agents/a1' },
    { kind: 'module', id: 'm1', title: 'Module', href: '/developer/modules/m1' },
    { kind: 'project', id: 'p1', title: 'Project', href: '/projects/p1' },
    { kind: 'file', id: 'f1', title: 'File', href: '/files/f1' },
  ];

  expect(groupOpenOpcSearchResults(results).map((group) => group.kind)).toEqual([
    'task',
    'agent',
    'module',
    'project',
    'file',
  ]);
});
