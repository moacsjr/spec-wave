import * as p from '@clack/prompts';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
// Fonte única da skill, publicada via "files": ["src"] no package.json.
const SKILL_SOURCE = path.join(__dir, '..', 'templates', 'skill', 'SKILL.md');
// Versão da CLI que gerou a skill instalada — carimbada no arquivo para detecção
// de desatualização (a skill é uma cópia estática; não acompanha o `npx` sozinha).
const pkg = JSON.parse(readFileSync(path.join(__dir, '..', '..', 'package.json'), 'utf-8'));
// Reexportados para o comando `update` (detecção de skill desatualizada).
export { SKILL_SOURCE };
export const CLI_VERSION = pkg.version;

// Marcadores usados para gravar/atualizar a skill de forma idempotente em
// arquivos compartilhados (AGENTS.md) — permite reinstalar sem duplicar.
export const BLOCK_START = '<!-- spec-wave:start -->';
export const BLOCK_END = '<!-- spec-wave:end -->';

// Registro de agentes suportados. Cada alvo descreve como detectá-lo no
// diretório-base, onde gravar (projeto vs. global) e em que formato converter
// o SKILL.md. Caminhos conferidos na doc oficial de cada ferramenta.
export const TARGETS = [
  {
    key: 'claude',
    name: 'Claude Code',
    format: 'skill',
    detect: ['.claude'],
    project: '.claude/skills/spec-wave/SKILL.md',
    global: '.claude/skills/spec-wave/SKILL.md',
  },
  {
    key: 'opencode',
    name: 'opencode',
    format: 'skill',
    detect: ['.opencode'],
    project: '.opencode/skills/spec-wave/SKILL.md',
    global: '.config/opencode/skills/spec-wave/SKILL.md',
  },
  {
    key: 'cursor',
    name: 'Cursor',
    format: 'mdc',
    detect: ['.cursor'],
    project: '.cursor/rules/spec-wave.mdc',
    global: null, // Cursor user rules não são baseadas em arquivo.
  },
  {
    key: 'cline',
    name: 'Cline',
    format: 'rules',
    detect: ['.clinerules'],
    project: '.clinerules/spec-wave.md',
    global: null,
  },
  {
    key: 'kilo',
    name: 'Kilo Code',
    format: 'rules',
    detect: ['.kilocode'],
    project: '.kilocode/rules/spec-wave.md',
    global: '.kilocode/rules/spec-wave.md',
  },
  {
    key: 'antigravity',
    name: 'Antigravity',
    format: 'rules',
    detect: ['.agent', 'GEMINI.md'],
    project: '.agent/rules/spec-wave.md',
    global: '.gemini/AGENTS.md',
    globalFormat: 'agents', // ~/.gemini/AGENTS.md é compartilhado → append.
  },
  {
    key: 'agents',
    name: 'AGENTS.md (genérico)',
    format: 'agents',
    detect: ['AGENTS.md'],
    project: 'AGENTS.md',
    global: '.config/opencode/AGENTS.md',
  },
];

const TARGET_BY_KEY = new Map(TARGETS.map((t) => [t.key, t]));

// Separa o frontmatter YAML do corpo do SKILL.md. Retorna { meta, body }.
export function parseSkill(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, frontmatter: '', body: raw.trim() };
  let meta = {};
  try {
    meta = yaml.load(match[1]) || {};
  } catch {
    meta = {};
  }
  return { meta, frontmatter: match[1], body: match[2].trim() };
}

// Banner de versão inserido no topo do corpo da skill instalada. O agente lê
// esta linha e, se `npx @spec-wave/cli --version` for maior, orienta reinstalar.
function versionBanner(version) {
  return (
    `> ⚙️ **spec-wave skill v${version}** — esta skill é uma cópia estática. ` +
    'Se `npx @spec-wave/cli --version` indicar uma versão maior, ela está ' +
    'desatualizada: rode `npx @spec-wave/cli update` (atualiza só o que mudou) ' +
    'ou `npx @spec-wave/cli install-skill --force` (só a skill).'
  );
}

// Converte o SKILL.md para o formato exigido por cada agente, carimbando a versão.
export function renderContent(format, parsed, version) {
  const { meta, frontmatter, body } = parsed;
  const description = meta.description ?? 'Skill spec-wave.';
  const banner = versionBanner(version);
  switch (format) {
    case 'skill':
      // Claude Code / opencode consomem o SKILL.md nativo. Preserva o frontmatter
      // original (allowed-tools etc.) e insere o banner no topo do corpo.
      return `---\n${frontmatter}\n---\n\n${banner}\n\n${body}\n`;
    case 'mdc':
      return (
        `---\n` +
        `description: ${JSON.stringify(description)}\n` +
        `alwaysApply: false\n` +
        `---\n\n` +
        `${banner}\n\n${body}\n`
      );
    case 'rules':
      return `# spec-wave\n\n${banner}\n\n${description}\n\n${body}\n`;
    case 'agents':
      return `${BLOCK_START}\n\n# spec-wave\n\n${banner}\n\n${description}\n\n${body}\n\n${BLOCK_END}\n`;
    default:
      return body;
  }
}

// Insere/atualiza o bloco spec-wave num arquivo compartilhado (AGENTS.md),
// preservando o restante do conteúdo. Idempotente via marcadores.
export function mergeAgentsFile(destPath, block) {
  const existing = existsSync(destPath) ? readFileSync(destPath, 'utf-8') : '';
  const blockRe = new RegExp(
    `${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`,
  );
  if (blockRe.test(existing)) {
    return existing.replace(blockRe, block);
  }
  if (existing.trim() === '') return block;
  return `${existing.trimEnd()}\n\n${block}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extrai o bloco spec-wave (entre marcadores) de um arquivo compartilhado
// (AGENTS.md). Retorna o texto do bloco incluindo os marcadores, ou null.
export function extractAgentsBlock(fileContent) {
  const m = fileContent.match(
    new RegExp(`${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}`),
  );
  return m ? m[0] : null;
}

// Resolve o alvo do agente para um destino concreto no escopo escolhido.
// Retorna null quando o agente não suporta o escopo global.
export function resolveDest(target, baseDir, isGlobal) {
  const rel = isGlobal ? target.global : target.project;
  if (!rel) return null;
  const format = isGlobal && target.globalFormat ? target.globalFormat : target.format;
  return { path: path.join(baseDir, rel), format };
}

// Retorna true se algum dos sinais de detecção existir em baseDir.
export function isDetected(target, baseDir) {
  return target.detect.some((sig) => existsSync(path.join(baseDir, sig)));
}

export async function installSkill(options = {}) {
  p.intro(chalk.bold('spec-wave install-skill'));

  if (!existsSync(SKILL_SOURCE)) {
    p.log.error(`SKILL.md não encontrado no pacote (${SKILL_SOURCE}).`);
    process.exitCode = 1;
    return;
  }
  const raw = readFileSync(SKILL_SOURCE, 'utf-8');
  const parsed = parseSkill(raw);

  const isGlobal = !!options.global;
  const baseDir = isGlobal ? homedir() : process.cwd();
  const scopeLabel = isGlobal ? 'global (usuário)' : 'projeto (local)';

  // 1) Determinar quais agentes receberão a skill.
  let selectedKeys;
  if (options.agent) {
    const requested = String(options.agent)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const invalid = requested.filter((k) => !TARGET_BY_KEY.has(k));
    if (invalid.length) {
      p.log.error(
        `Agente(s) inválido(s): ${invalid.join(', ')}.\n` +
          `Válidos: ${TARGETS.map((t) => t.key).join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    selectedKeys = requested;
  } else {
    const detected = TARGETS.filter((t) => isDetected(t, baseDir)).map((t) => t.key);

    if (options.all) {
      if (!detected.length) {
        p.log.error(
          `Nenhum agente detectado em ${scopeLabel}. Use --agent <nome> para escolher manualmente.`,
        );
        process.exitCode = 1;
        return;
      }
      selectedKeys = detected;
    } else if (options.yes) {
      if (!detected.length) {
        p.log.error(
          `Nenhum agente detectado em ${scopeLabel}. Use --agent <nome> em modo não-interativo.`,
        );
        process.exitCode = 1;
        return;
      }
      selectedKeys = detected;
    } else {
      const answer = await p.multiselect({
        message: `Onde instalar a skill? (escopo: ${scopeLabel})`,
        options: TARGETS.map((t) => ({
          value: t.key,
          label: t.name,
          hint: isDetected(t, baseDir) ? 'detectado' : undefined,
        })),
        initialValues: detected,
        required: true,
      });
      if (p.isCancel(answer)) {
        p.cancel('Instalação cancelada.');
        return;
      }
      selectedKeys = answer;
    }
  }

  // 2) Resolver destinos, avisando sobre escopos não suportados.
  const jobs = [];
  for (const key of selectedKeys) {
    const target = TARGET_BY_KEY.get(key);
    const dest = resolveDest(target, baseDir, isGlobal);
    if (!dest) {
      p.log.warn(`${target.name}: escopo global não suportado — pulado.`);
      continue;
    }
    jobs.push({ target, dest });
  }

  if (!jobs.length) {
    p.log.warn('Nenhum destino a instalar.');
    p.outro('Nada foi feito.');
    return;
  }

  // 3) Dry-run: apenas listar.
  if (options.dryRun) {
    p.note(
      jobs
        .map((j) => `${chalk.dim(j.target.name.padEnd(20))} ${j.dest.path}  ${chalk.dim(`(${j.dest.format})`)}`)
        .join('\n'),
      `Dry-run — nada será gravado (escopo: ${scopeLabel})`,
    );
    p.outro('Dry-run concluído.');
    return;
  }

  // 4) Gravar cada destino.
  const written = [];
  for (const { target, dest } of jobs) {
    const content =
      dest.format === 'agents'
        ? mergeAgentsFile(dest.path, renderContent('agents', parsed, pkg.version))
        : renderContent(dest.format, parsed, pkg.version);

    // Confirmar sobrescrita de arquivos "próprios" (skill/rules/mdc). Para
    // 'agents' o merge por marcadores já é seguro (não apaga conteúdo alheio).
    if (existsSync(dest.path) && dest.format !== 'agents' && !options.force && !options.yes) {
      const ok = await p.confirm({
        message: `${target.name}: ${dest.path} já existe. Sobrescrever?`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.log.info(`${target.name}: mantido (não sobrescrito).`);
        continue;
      }
    }

    mkdirSync(path.dirname(dest.path), { recursive: true });
    writeFileSync(dest.path, content, 'utf-8');
    written.push({ target, dest });
  }

  if (!written.length) {
    p.outro('Nada foi gravado.');
    return;
  }

  p.note(
    written.map((w) => `${chalk.green('✓')} ${chalk.bold(w.target.name)}\n  ${chalk.dim(w.dest.path)}`).join('\n'),
    `Skill v${pkg.version} instalada (escopo: ${scopeLabel})`,
  );
  p.outro(
    'Reinicie/recarregue o agente para que ele detecte a skill. ' +
    'Ao atualizar a CLI, rode `install-skill --force` para atualizar a skill também.',
  );
}
