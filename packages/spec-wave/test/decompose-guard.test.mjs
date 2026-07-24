import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipDecompose } from '../src/commands/decompose.mjs';
import { LABEL_DECOMPOSED } from '../src/config.mjs';

test('shouldSkipDecompose skipa quando a label decomposed está presente', () => {
  const result = shouldSkipDecompose({
    labels: [{ name: LABEL_DECOMPOSED }, { name: '[FEATURE]' }],
    subIssues: [],
    type: 'Feature',
  });
  assert.equal(result.skip, true);
  assert.ok(result.reason.includes(LABEL_DECOMPOSED));
});

test('shouldSkipDecompose aceita labels como strings', () => {
  const result = shouldSkipDecompose({
    labels: [LABEL_DECOMPOSED],
    subIssues: [],
    type: 'RFC',
  });
  assert.equal(result.skip, true);
});

test('shouldSkipDecompose skipa Feature com sub-issue [STORY]', () => {
  const result = shouldSkipDecompose({
    labels: [],
    subIssues: [{ number: 12, title: '[STORY] visualizar pedidos' }],
    type: 'Feature',
  });
  assert.equal(result.skip, true);
  assert.ok(result.reason.includes('[STORY]'));
});

test('shouldSkipDecompose skipa RFC com sub-issue [TASK]', () => {
  const result = shouldSkipDecompose({
    labels: [],
    subIssues: [{ number: 30, title: '[TASK] criar workflow de CI' }],
    type: 'RFC',
  });
  assert.equal(result.skip, true);
  assert.ok(result.reason.includes('[TASK]'));
});

test('shouldSkipDecompose não skipa Feature limpa', () => {
  const result = shouldSkipDecompose({
    labels: [{ name: '[FEATURE]' }, { name: 'spec-wave:decompose' }],
    subIssues: [],
    type: 'Feature',
  });
  assert.deepEqual(result, { skip: false, reason: '' });
});

test('shouldSkipDecompose ignora sub-issues de outro tipo', () => {
  // Feature com sub-issue [TASK] (não [STORY]) → não skipa.
  assert.equal(shouldSkipDecompose({
    labels: [],
    subIssues: [{ number: 5, title: '[TASK] tarefa avulsa' }],
    type: 'Feature',
  }).skip, false);
  // RFC com sub-issue [STORY] → não skipa.
  assert.equal(shouldSkipDecompose({
    labels: [],
    subIssues: [{ number: 6, title: '[STORY] story avulsa' }],
    type: 'RFC',
  }).skip, false);
});

test('shouldSkipDecompose tolera entradas ausentes', () => {
  assert.equal(shouldSkipDecompose({ type: 'Feature' }).skip, false);
  assert.equal(shouldSkipDecompose({ labels: [], subIssues: [{}], type: 'Feature' }).skip, false);
});
