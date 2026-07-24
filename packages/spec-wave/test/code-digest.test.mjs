import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPathsFromPlan, buildCodeDigest } from '../src/lib/code-digest.mjs';

// ---------------------------------------------------------------------------
// extractPathsFromPlan
// ---------------------------------------------------------------------------

test('extractPathsFromPlan extrai caminhos de backticks', () => {
  const plan = 'Editar `src/lib/board.mjs` e criar `docs/features/x/spec.md`. Ver `config.mjs`.';
  assert.deepEqual(extractPathsFromPlan(plan), [
    'src/lib/board.mjs',
    'docs/features/x/spec.md',
    'config.mjs',
  ]);
});

test('extractPathsFromPlan extrai padrões soltos (src/, server/, client/, packages/)', () => {
  const plan =
    'Crie o módulo em src/modules/waves/index.ts, ajuste server/routes.mjs e ' +
    'client/pages/home.vue; o pacote fica em packages/core/lib.';
  assert.deepEqual(extractPathsFromPlan(plan), [
    'src/modules/waves/index.ts',
    'server/routes.mjs',
    'client/pages/home.vue',
    'packages/core/lib',
  ]);
});

test('extractPathsFromPlan deduplica e normaliza (./ inicial, / final)', () => {
  const plan = 'Use `./src/lib/board.mjs`, `src/lib/board.mjs` e `src/modules/` — e de novo src/modules/waves em src/modules/waves.';
  const paths = extractPathsFromPlan(plan);
  assert.deepEqual(paths, ['src/lib/board.mjs', 'src/modules', 'src/modules/waves']);
});

test('extractPathsFromPlan ignora código inline que não é caminho', () => {
  const plan =
    'Chame `parseDependencies(body)` e rode `npm test`; a flag `--dry-run` e ' +
    'o literal `const x = 1` não são caminhos, nem `https://example.com/x`.';
  assert.deepEqual(extractPathsFromPlan(plan), []);
});

test('extractPathsFromPlan limita a 30 caminhos', () => {
  const plan = Array.from({ length: 45 }, (_, i) => `- criar \`src/mod-${i}/index.mjs\``).join('\n');
  const paths = extractPathsFromPlan(plan);
  assert.equal(paths.length, 30);
  assert.equal(paths[0], 'src/mod-0/index.mjs');
});

test('extractPathsFromPlan retorna [] para plan nulo ou vazio', () => {
  assert.deepEqual(extractPathsFromPlan(null), []);
  assert.deepEqual(extractPathsFromPlan(undefined), []);
  assert.deepEqual(extractPathsFromPlan(''), []);
});

// ---------------------------------------------------------------------------
// buildCodeDigest (exec mockado; árvore em diretório temporário)
// ---------------------------------------------------------------------------

const SINCE = '2026-07-01T00:00:00Z';

test('buildCodeDigest inclui commits do git log (limitado a 50 linhas)', async () => {
  const calls = [];
  const manyCommits = Array.from({ length: 60 }, (_, i) => `abc${i} commit ${i}`).join('\n');
  const digest = await buildCodeDigest({
    sinceIso: SINCE,
    exec: (cmd) => { calls.push(cmd); return manyCommits; },
  });
  assert.ok(digest.includes('### Commits desde a criação da feature'));
  assert.ok(digest.includes('abc0 commit 0'));
  assert.ok(digest.includes('abc49 commit 49'));
  assert.ok(!digest.includes('abc50 commit 50')); // truncado em 50
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('git log --oneline --no-merges'));
  assert.ok(calls[0].includes('--since'));
});

test('buildCodeDigest diz "nenhum commit no período" quando o git log vem vazio', async () => {
  const digest = await buildCodeDigest({ sinceIso: SINCE, exec: () => '' });
  assert.ok(digest.includes('nenhum commit no período'));
});

test('buildCodeDigest omite a seção de commits se o exec lançar (sem crash)', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'digest-'));
  try {
    writeFileSync(path.join(cwd, 'app.mjs'), 'a\nb\nc\n');
    const digest = await buildCodeDigest({
      sinceIso: SINCE,
      paths: ['app.mjs'],
      cwd,
      exec: () => { throw new Error('git não instalado'); },
    });
    assert.ok(!digest.includes('Commits desde a criação'));
    assert.ok(digest.includes('### Árvore dos módulos citados no plan'));
    assert.ok(digest.includes('`app.mjs` — arquivo existente'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildCodeDigest lista diretórios/arquivos existentes e agrupa os inexistentes', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'digest-'));
  try {
    mkdirSync(path.join(cwd, 'src', 'lib'), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'index.mjs'), 'linha1\nlinha2\n');
    writeFileSync(path.join(cwd, 'src', 'lib', 'board.mjs'), 'x\n');
    const digest = await buildCodeDigest({
      sinceIso: SINCE,
      paths: ['src', 'src/index.mjs', 'src/novo-modulo', 'server/api.mjs'],
      cwd,
      exec: () => 'aaa111 primeiro commit',
    });
    // diretório: listagem rasa indentada
    assert.ok(digest.includes('`src/` (diretório)'));
    assert.ok(digest.includes('index.mjs'));
    assert.ok(digest.includes('lib/'));
    assert.ok(digest.includes('board.mjs'));
    // arquivo: existência + tamanho em linhas
    assert.ok(/`src\/index\.mjs` — arquivo existente \(\d+ linhas\)/.test(digest));
    // inexistentes agrupados numa linha só
    assert.ok(digest.includes('não existem ainda (a criar): `src/novo-modulo`, `server/api.mjs`'));
    // seção de commits também presente
    assert.ok(digest.includes('aaa111 primeiro commit'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildCodeDigest retorna null quando nenhuma seção pode ser gerada', async () => {
  const digest = await buildCodeDigest({
    sinceIso: SINCE,
    paths: [],
    exec: () => { throw new Error('boom'); },
  });
  assert.equal(digest, null);
});

test('buildCodeDigest sem sinceIso omite commits mas mantém a árvore', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'digest-'));
  try {
    writeFileSync(path.join(cwd, 'a.mjs'), 'x\n');
    const digest = await buildCodeDigest({
      sinceIso: null,
      paths: ['a.mjs'],
      cwd,
      exec: () => { throw new Error('não deveria ser chamado'); },
    });
    assert.ok(!digest.includes('Commits desde a criação'));
    assert.ok(digest.includes('`a.mjs` — arquivo existente'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
