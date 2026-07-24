import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintLanguage } from '../src/lib/output-lint.mjs';

test('detecta CJK vazado no meio do texto (caso real)', () => {
  const { ok, findings } = lintLanguage('A taxa de Registration成功率 deve ser ≥ 99%.');
  assert.equal(ok, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].char, '成功率');
  assert.equal(findings[0].script, 'Han');
  assert.ok(findings[0].excerpt.includes('Registration成功率'));
  assert.equal(typeof findings[0].index, 'number');
});

test('detecta cirílico', () => {
  const { ok, findings } = lintLanguage('O login был feito com sucesso.');
  assert.equal(ok, false);
  assert.equal(findings[0].script, 'Cyrillic');
});

test('texto pt-BR limpo passa (acentos, emoji, code fences)', () => {
  const texto = [
    '# Visão Geral',
    'Órgão, ação, coração — çãõáéíóú à è. 🎉🚀',
    '```typescript',
    'const situação = { válido: true };',
    '```',
    '> Critérios de Aceite: 100% de cobertura.',
  ].join('\n');
  const { ok, findings } = lintLanguage(texto);
  assert.equal(ok, true);
  assert.deepEqual(findings, []);
});

test('allowlist ignora termos permitidos', () => {
  const texto = 'O produto se chama 東京Widget e é vendido no Japão.';
  assert.equal(lintLanguage(texto).ok, false);
  const { ok, findings } = lintLanguage(texto, { allowlist: ['東京Widget'] });
  assert.equal(ok, true);
  assert.deepEqual(findings, []);
});

test('agrupa caracteres contíguos num único finding', () => {
  // Frase inteira em CJK: um finding só, não um por caractere.
  const { findings } = lintLanguage('Prefácio: 登録の成功率は高い必要があります fim.');
  assert.equal(findings.length, 1);
});

test('runs distantes geram findings separados', () => {
  const gap = 'x'.repeat(100);
  const { findings } = lintLanguage(`início 成功 ${gap} было fim`);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].script, 'Han');
  assert.equal(findings[1].script, 'Cyrillic');
});

test('texto vazio/nulo passa', () => {
  assert.equal(lintLanguage('').ok, true);
  assert.equal(lintLanguage(null).ok, true);
});
