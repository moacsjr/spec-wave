import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canStartTask } from '../src/commands/task.mjs';
import { PROGRESS_IN_PROGRESS, PROGRESS_TODO, PROGRESS_DONE } from '../src/config.mjs';

test('canStartTask libera quando nenhuma irmã está In Progress', () => {
  const { ok, blocker } = canStartTask({
    siblings: [
      { number: 4, status: PROGRESS_TODO },
      { number: 5, status: PROGRESS_DONE },
    ],
  });
  assert.equal(ok, true);
  assert.equal(blocker, null);
});

test('canStartTask bloqueia com o number da irmã In Progress', () => {
  const { ok, blocker } = canStartTask({
    siblings: [
      { number: 4, status: PROGRESS_DONE },
      { number: 7, status: PROGRESS_IN_PROGRESS },
      { number: 9, status: PROGRESS_TODO },
    ],
  });
  assert.equal(ok, false);
  assert.equal(blocker, 7);
});

test('canStartTask não bloqueia por irmãs com status desconhecido/null', () => {
  const { ok, blocker } = canStartTask({
    siblings: [
      { number: 4, status: null },
      { number: 5, status: undefined },
      { number: 6 }, // sem campo status
    ],
  });
  assert.equal(ok, true);
  assert.equal(blocker, null);
});

test('canStartTask libera com lista vazia de irmãs', () => {
  assert.deepEqual(canStartTask({ siblings: [] }), { ok: true, blocker: null });
});

test('canStartTask tolera siblings ausente (null/undefined)', () => {
  assert.deepEqual(canStartTask({ siblings: null }), { ok: true, blocker: null });
  assert.deepEqual(canStartTask({}), { ok: true, blocker: null });
  assert.deepEqual(canStartTask(), { ok: true, blocker: null });
});
