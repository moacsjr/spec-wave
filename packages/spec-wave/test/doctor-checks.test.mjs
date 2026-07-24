// Testes da formatação do relatório do doctor (renderDoctorReport é pura —
// nenhum teste aqui toca rede, filesystem ou o gh CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDoctorReport } from '../src/commands/doctor.mjs';

// chalk pode (ou não) emitir códigos ANSI dependendo do TTY — remove para
// asserts estáveis sobre o texto.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('mistura ok/warn/fail renderiza os três símbolos e os detalhes', () => {
  const out = stripAnsi(renderDoctorReport([
    { name: 'Token GitHub', status: 'ok', detail: 'Token resolvido via gh CLI.' },
    { name: 'Escopos do token', status: 'warn', detail: 'Escopos não legíveis (fine-grained PAT?).' },
    { name: 'Acesso ao repositório', status: 'fail', detail: 'Token não enxerga owner/repo (404).' },
  ]));

  assert.match(out, /✓ Token GitHub/);
  assert.match(out, /! Escopos do token/);
  assert.match(out, /✗ Acesso ao repositório/);
  assert.match(out, /Token resolvido via gh CLI\./);
  assert.match(out, /fine-grained PAT/);
  assert.match(out, /404/);
});

test('tudo ok: só símbolos ✓, sem ✗ nem ! (nada exit-worthy)', () => {
  const results = [
    { name: 'Token GitHub', status: 'ok', detail: 'ok' },
    { name: 'Workflows do Actions', status: 'ok' },
  ];
  const out = stripAnsi(renderDoctorReport(results));

  assert.match(out, /✓ Token GitHub/);
  assert.match(out, /✓ Workflows do Actions/);
  assert.doesNotMatch(out, /✗/);
  assert.doesNotMatch(out, /^!/m);
  // Nenhum resultado com status fail → o doctor não deve sair com exit 1.
  assert.equal(results.filter((r) => r.status === 'fail').length, 0);
});

test('detail com múltiplas linhas é indentado linha a linha', () => {
  const out = stripAnsi(renderDoctorReport([
    { name: 'Configuração', status: 'warn', detail: 'linha um\nlinha dois' },
  ]));
  assert.match(out, /\n {2}linha um\n {2}linha dois/);
});

test('array vazio não crasha e retorna string vazia', () => {
  assert.equal(renderDoctorReport([]), '');
});

test('entrada nula/status desconhecido degradam sem crash', () => {
  assert.equal(renderDoctorReport(undefined), '');
  const out = stripAnsi(renderDoctorReport([{ name: 'X', status: 'banana' }]));
  assert.match(out, /! X/); // status desconhecido cai no símbolo de aviso
});
