import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiConfig } from '../src/lib/claude.mjs';
import { getProvider, DEFAULT_PROVIDER } from '../src/config.mjs';

const DEFAULT_MODEL = getProvider(DEFAULT_PROVIDER).defaultModel;

test('env.SPEC_WAVE_MODEL vence tudo', () => {
  const { model } = resolveAiConfig({
    env: { SPEC_WAVE_MODEL: 'env-model' },
    fileAi: { model: 'file-model', models: { spec: 'spec-model' } },
    action: 'spec',
  });
  assert.equal(model, 'env-model');
});

test('models[action] vence model genérico', () => {
  const { model } = resolveAiConfig({
    env: {},
    fileAi: { model: 'file-model', models: { critique: 'critique-model' } },
    action: 'critique',
  });
  assert.equal(model, 'critique-model');
});

test('action sem entrada em models cai no model genérico', () => {
  const { model } = resolveAiConfig({
    env: {},
    fileAi: { model: 'file-model', models: { critique: 'critique-model' } },
    action: 'plan',
  });
  assert.equal(model, 'file-model');
});

test('action ausente cai no model genérico', () => {
  const { model } = resolveAiConfig({
    env: {},
    fileAi: { model: 'file-model', models: { spec: 'spec-model' } },
  });
  assert.equal(model, 'file-model');
});

test('sem env nem fileAi cai no default do provider', () => {
  const cfg = resolveAiConfig({ env: {}, fileAi: {} });
  assert.equal(cfg.provider, DEFAULT_PROVIDER);
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(cfg.secret, getProvider(DEFAULT_PROVIDER).secret);
});

test('provider: env vence fileAi; desconhecido cai no default', () => {
  const or = resolveAiConfig({
    env: { SPEC_WAVE_PROVIDER: 'openrouter' },
    fileAi: { provider: 'anthropic' },
  });
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.model, getProvider('openrouter').defaultModel);
  assert.equal(or.secret, 'OPENROUTER_API_KEY');

  const unknown = resolveAiConfig({ env: { SPEC_WAVE_PROVIDER: 'inexistente' }, fileAi: {} });
  assert.equal(unknown.provider, DEFAULT_PROVIDER);
});

test('chamada sem argumentos usa todos os defaults', () => {
  const cfg = resolveAiConfig();
  assert.equal(cfg.provider, DEFAULT_PROVIDER);
  assert.equal(cfg.model, DEFAULT_MODEL);
});
