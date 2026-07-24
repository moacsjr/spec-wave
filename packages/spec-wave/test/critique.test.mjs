import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCritiqueResponse } from '../src/lib/critique.mjs';

test('parseCritiqueResponse parseia JSON limpo com graves e menores', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'grave', text: 'Story 2 persiste dados antes do consentimento exigido pela spec' },
      { severity: 'menor', text: 'Critério de aceite sem cenário de erro' },
    ],
  });
  const result = parseCritiqueResponse(raw);
  assert.equal(result.grave, true);
  assert.deepEqual(result.findings, [
    { severity: 'grave', text: 'Story 2 persiste dados antes do consentimento exigido pela spec' },
    { severity: 'menor', text: 'Critério de aceite sem cenário de erro' },
  ]);
});

test('parseCritiqueResponse aceita JSON dentro de fence de código', () => {
  const raw = '```json\n{"findings": [{"severity": "menor", "text": "Omissão de rollback"}]}\n```';
  const result = parseCritiqueResponse(raw);
  assert.equal(result.grave, false);
  assert.deepEqual(result.findings, [{ severity: 'menor', text: 'Omissão de rollback' }]);
});

test('parseCritiqueResponse aceita texto ao redor do JSON', () => {
  const raw = 'Segue minha análise:\n{"findings": [{"severity": "grave", "text": "Plan contradiz a regra de minimização LGPD"}]}\nEspero ter ajudado.';
  const result = parseCritiqueResponse(raw);
  assert.equal(result.grave, true);
  assert.equal(result.findings[0].text, 'Plan contradiz a regra de minimização LGPD');
});

test('parseCritiqueResponse normaliza severities em maiúsculas/variantes', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'GRAVE', text: 'a' },
      { severity: 'Grave', text: 'b' },
      { severity: 'MENOR', text: 'c' },
      { severity: 'desconhecida', text: 'd' },
    ],
  });
  const result = parseCritiqueResponse(raw);
  assert.equal(result.grave, true);
  assert.deepEqual(result.findings.map(f => f.severity), ['grave', 'grave', 'menor', 'menor']);
});

test('parseCritiqueResponse nunca explode com resposta não-JSON (fallback menor)', () => {
  const raw = 'Não consegui analisar os documentos no formato pedido.';
  const result = parseCritiqueResponse(raw);
  assert.equal(result.grave, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'menor');
  assert.ok(result.findings[0].text.includes('Não consegui analisar'));
});

test('parseCritiqueResponse trunca resposta bruta longa no fallback', () => {
  const raw = 'x'.repeat(2000);
  const result = parseCritiqueResponse(raw);
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].text.length < 500);
  assert.ok(result.findings[0].text.endsWith('…'));
});

test('parseCritiqueResponse retorna vazio para findings vazios', () => {
  assert.deepEqual(parseCritiqueResponse('{"findings": []}'), { grave: false, findings: [] });
  assert.deepEqual(parseCritiqueResponse(''), { grave: false, findings: [] });
  assert.deepEqual(parseCritiqueResponse(null), { grave: false, findings: [] });
});
