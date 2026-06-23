import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Subsistema de Tech Context (RFC-002 §4).
//
// Monta o contexto técnico que o `generate-plan` injeta na chamada de IA, no
// formato do payload RFC §5.2: { static, dynamic, overrides }. Roda no checkout
// do GitHub Action, então lê tudo do filesystem local (cwd = raiz do repo-alvo).

const TECH_CONTEXT_PATH = '.github/config/tech_context.yml';

// Diretórios onde migrations costumam viver (várias stacks).
const MIGRATION_DIRS = [
  'migrations',
  'db/migrations',
  'src/migrations',
  'prisma/migrations',
  'database/migrations',
];

const MAX_MIGRATIONS = 10;

// §4.1 — Fonte de verdade estática. Ausência não é erro: segue com {} e avisa.
function readStaticContext(cwd) {
  const filePath = path.join(cwd, TECH_CONTEXT_PATH);
  if (!existsSync(filePath)) {
    console.warn(
      `⚠️ ${TECH_CONTEXT_PATH} não encontrado. ` +
      `O plano será gerado sem contexto técnico estático. ` +
      `Rode \`spec-wave init\` para gerar o scaffold.`
    );
    return {};
  }
  try {
    return yaml.load(readFileSync(filePath, 'utf-8')) || {};
  } catch (err) {
    console.warn(`⚠️ Falha ao parsear ${TECH_CONTEXT_PATH}: ${err.message}. Ignorando.`);
    return {};
  }
}

// §4.2 — Augmentação dinâmica: migrations recentes + versões exatas de pacotes.
function readDynamicContext(cwd) {
  return {
    recent_migrations: listRecentMigrations(cwd),
    current_packages: readPackageVersions(cwd),
  };
}

function listRecentMigrations(cwd) {
  for (const dir of MIGRATION_DIRS) {
    const abs = path.join(cwd, dir);
    if (!existsSync(abs)) continue;
    try {
      const entries = readdirSync(abs)
        .map((name) => {
          const full = path.join(abs, name);
          return { name, mtime: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_MIGRATIONS)
        .map((e) => `${dir}/${e.name}`);
      if (entries.length) return entries;
    } catch {
      // diretório ilegível → tenta o próximo
    }
  }
  return [];
}

function readPackageVersions(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return {};
  }
}

// §4.3 — Override do corpo da issue. Extrai a seção markdown exatamente titulada
// `## Tech Override` e parseia o bloco como YAML. Retorna {} se ausente.
export function parseTechOverride(issueBody) {
  if (!issueBody) return {};
  const lines = issueBody.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## Tech Override');
  if (start === -1) return {};

  // Captura até o próximo heading de mesmo nível (ou superior) ou fim do corpo.
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }

  // Tolera o YAML vir dentro de uma fence ```yaml ... ```.
  let raw = body.join('\n').trim();
  const fence = raw.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/);
  if (fence) raw = fence[1];
  if (!raw.trim()) return {};

  try {
    return yaml.load(raw) || {};
  } catch (err) {
    console.warn(`⚠️ Falha ao parsear a seção '## Tech Override': ${err.message}. Ignorando.`);
    return {};
  }
}

// Deep-merge: override vence; objetos são mesclados recursivamente, escalares e
// arrays são substituídos.
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Monta o tech context completo. `cwd` default = process.cwd() (checkout do Action).
export function buildTechContext({ issueBody = '', cwd = process.cwd() } = {}) {
  const staticContext = readStaticContext(cwd);
  const dynamic = readDynamicContext(cwd);
  const overrides = parseTechOverride(issueBody);
  const merged = deepMerge(staticContext, overrides);

  return {
    static: staticContext,
    dynamic,
    overrides,
    merged,
    // String pronta para injetar no prompt: contexto efetivo + efêmeros.
    yaml: yaml.dump({ ...merged, _dynamic: dynamic }, { lineWidth: 120 }),
  };
}
