import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDependencyLine, parseDependencies, orderStories } from '../src/lib/dependencies.mjs';

test('formatDependencyLine formata a linha padrão', () => {
  assert.equal(formatDependencyLine([4, 5]), 'Depende de: #4, #5');
  assert.equal(formatDependencyLine([12]), 'Depende de: #12');
});

test('formatDependencyLine retorna vazio para lista vazia', () => {
  assert.equal(formatDependencyLine([]), '');
  assert.equal(formatDependencyLine(null), '');
});

test('parseDependencies aceita variações de formatação', () => {
  assert.deepEqual(parseDependencies('Depende de: #4, #5'), [4, 5]);
  assert.deepEqual(parseDependencies('depende de #7'), [7]);
  assert.deepEqual(parseDependencies('**Depende de**: #4 e #5'), [4, 5]);
  assert.deepEqual(parseDependencies('_Depende de_ #9'), [9]);
  assert.deepEqual(parseDependencies('- Depende de: #3'), [3]);
  assert.deepEqual(parseDependencies('Corpo da story.\n\nDepende de: #4, #5\n\nMais texto.'), [4, 5]);
});

test('parseDependencies ignora #N fora da linha de dependência e deduplica', () => {
  assert.deepEqual(parseDependencies('Relacionado a #99.\nDepende de: #4, #4, #5'), [4, 5]);
});

test('parseDependencies retorna [] para body nulo ou sem match', () => {
  assert.deepEqual(parseDependencies(null), []);
  assert.deepEqual(parseDependencies(undefined), []);
  assert.deepEqual(parseDependencies('Sem dependências aqui, só #12 solto.'), []);
});

test('orderStories ordena topologicamente com empate por number crescente', () => {
  const { order, cycle } = orderStories([
    { number: 7, dependsOn: [5] },
    { number: 5, dependsOn: [] },
    { number: 3, dependsOn: [5] },
    { number: 9, dependsOn: [3, 7] },
  ]);
  assert.deepEqual(order, [5, 3, 7, 9]);
  assert.deepEqual(cycle, []);
});

test('orderStories é estável sem dependências (ordem por number)', () => {
  const { order } = orderStories([
    { number: 8, dependsOn: [] },
    { number: 2, dependsOn: [] },
    { number: 5, dependsOn: [] },
  ]);
  assert.deepEqual(order, [2, 5, 8]);
});

test('orderStories ignora dependências externas ao conjunto', () => {
  const { order, cycle } = orderStories([
    { number: 4, dependsOn: [999] },
    { number: 6, dependsOn: [4] },
  ]);
  assert.deepEqual(order, [4, 6]);
  assert.deepEqual(cycle, []);
});

test('orderStories reporta ciclo sem lançar', () => {
  const { order, cycle } = orderStories([
    { number: 1, dependsOn: [] },
    { number: 2, dependsOn: [3] },
    { number: 3, dependsOn: [2] },
    { number: 4, dependsOn: [3] }, // bloqueada pelo ciclo
  ]);
  assert.deepEqual(order, [1]);
  assert.deepEqual(cycle, [2, 3, 4]);
});
