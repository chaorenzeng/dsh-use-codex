/**
 * dsh-use-codex — 让 DeepSeek Harness 通过工具调用本机 Codex CLI。
 *
 * 安全边界：
 *   1. 工作目录必须是白名单内的真实绝对路径；软链逃逸会被拒绝。
 *   2. 沙箱默认 workspace-write；宿主配置 allowDangerFullAccess 后可用 codex_danger 运行时开关切到 danger-full-access。
 *   3. 不经过 shell，任务作为单个 argv 传给 Codex。
 *   4. 超时或取消时终止 Codex 进程组，并限制输出大小。
 *   5. 不持久化任务正文、工作目录或输出；状态文件只记录即时开关。
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const name = 'use-codex';
export const inject = ['tools'];

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_TASK_CHARS = 100_000;
const STATE_FILE = process.env.USE_CODEX_STATE
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'use-codex.json');

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function expandHome(input) {
  const value = String(input ?? '').trim();
  if (value === '~') return homedir();
  if (value.startsWith(`~${sep}`)) return join(homedir(), value.slice(2));
  return value;
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(join(STATE_FILE, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, STATE_FILE);
    return true;
  } catch {
    try { writeFileSync(temp, '', 'utf8'); } catch { /* ignore */ }
    return false;
  }
}

function resolveExistingDirectory(input) {
  const expanded = expandHome(input);
  if (!expanded) throw new Error('工作目录不能为空');
  if (!isAbsolute(expanded)) throw new Error(`工作目录必须是绝对路径：${expanded}`);

  const absolute = resolve(expanded);
  if (!existsSync(absolute)) throw new Error(`工作目录不存在：${absolute}`);

  let real;
  try {
    real = realpathSync.native(absolute);
  } catch {
    throw new Error(`无法解析工作目录：${absolute}`);
  }

  if (!statSync(real).isDirectory()) throw new Error(`工作目录不是文件夹：${absolute}`);
  return real;
}

function isInside(target, root) {
  return target === root || target.startsWith(`${root}${sep}`);
}

function createLimitedBuffer(limit) {
  let text = '';
  let totalChars = 0;

  return {
    append(value) {
      const chunk = String(value ?? '');
      totalChars += chunk.length;
      if (text.length < limit) text += chunk.slice(0, limit - text.length);
    },
    finish() {
      const trimmed = text.trim();
      if (totalChars <= limit) return trimmed;
      return `${trimmed}\n…（已截断：原始 ${totalChars} 字符，上限 ${limit} 字符）`;
    },
  };
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* 已退出 */ }
  }
}

function getAbortSignal(context) {
  if (context?.signal && typeof context.signal.addEventListener === 'function') return context.signal;
  if (context?.abortSignal && typeof context.abortSignal.addEventListener === 'function') {
    return context.abortSignal;
  }
  return null;
}

function runCodex(bin, argv, { cwd, timeoutMs, maxChars, signal }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const stdout = createLimitedBuffer(maxChars);
    const stderr = createLimitedBuffer(maxChars);
    let child;
    let timeoutTimer;
    let hardKillTimer;
    let finished = false;
    let timedOut = false;
    let aborted = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };

    const finish = (code, spawnError = '') => {
      if (finished) return;
      finished = true;
      cleanup();
      const ok = code === 0 && !timedOut && !aborted && !spawnError;
      resolvePromise({
        ok,
        code: timedOut ? 'timeout' : aborted ? 'aborted' : spawnError ? 'spawn-error' : code,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        error: spawnError,
        ms: Date.now() - started,
      });
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child, 'SIGTERM');
      clearTimeout(hardKillTimer);
      hardKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 1_500);
    };

    if (signal?.aborted) {
      aborted = true;
      finish('aborted');
      return;
    }

    try {
      child = spawn(bin, argv, {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish('spawn-error', String(error?.message || error));
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdout.append(chunk));
    child.stderr?.on('data', (chunk) => stderr.append(chunk));

    child.on('error', (error) => finish('spawn-error', String(error?.message || error)));
    child.on('close', (code, closeSignal) => {
      finish(code ?? (closeSignal ? `signal:${closeSignal}` : 'unknown'));
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 1_500);
    }, timeoutMs);

    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function textTool({ name: toolName, description, parameters, timeoutMs, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    ...(timeoutMs ? { timeoutMs } : {}),
    execute,
  };
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('[use-codex] disabled by configuration');
    return;
  }

  const bin = expandHome(config.bin || process.env.CODEX_BIN || 'codex');
  const defaultCwd = expandHome(config.defaultCwd || process.cwd());
  const rawRoots = Array.isArray(config.allowedRoots) && config.allowedRoots.length
    ? config.allowedRoots
    : [defaultCwd];
  const allowDanger = config.allowDangerFullAccess === true;
  const maxTimeoutSec = clamp(
    finiteNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC),
    1,
    3_600,
  );
  const maxOutputChars = Math.round(clamp(
    finiteNumber(config.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS),
    1_000,
    200_000,
  ));

  const allowedRoots = [];
  const rootWarnings = [];
  for (const rawRoot of rawRoots) {
    try {
      const real = resolveExistingDirectory(rawRoot);
      if (!allowedRoots.includes(real)) allowedRoots.push(real);
    } catch (error) {
      rootWarnings.push(String(error?.message || error));
    }
  }

  const warnings = [...rootWarnings];
  if (allowedRoots.length === 0) warnings.push('没有可用的白名单目录，codex_run 将拒绝执行');
  try {
    const realDefault = resolveExistingDirectory(defaultCwd);
    if (!allowedRoots.some((root) => isInside(realDefault, root))) {
      warnings.push('defaultCwd 不在白名单内，未显式提供 cwd 时 codex_run 将拒绝执行');
    }
  } catch (error) {
    warnings.push(`defaultCwd 不可用：${String(error?.message || error)}`);
  }

  const enabledNow = () => readState().enabled !== false;
  // Runtime danger-mode switch: defaults to the host config; codex_danger toggles it per session.
  const dangerNow = () => {
    const state = readState();
    if (typeof state.dangerFullAccess === 'boolean') return state.dangerFullAccess;
    return allowDanger;
  };
  const defaultSandbox = () => (dangerNow() ? 'danger-full-access' : 'workspace-write');
  let lastRun = null;

  const resolveRunCwd = (input) => {
    const requested = String(input ?? '').trim() || defaultCwd;
    const real = resolveExistingDirectory(requested);
    if (!allowedRoots.some((root) => isInside(real, root))) {
      throw new Error(`工作目录不在白名单内：${real}`);
    }
    return real;
  };

  const safeStatusCwd = () => {
    try { return resolveRunCwd(defaultCwd); } catch { return tmpdir(); }
  };

  const tools = [
    textTool({
      name: 'codex_run',
      description:
        '让本机 OpenAI Codex CLI 执行一段独立任务并返回结果。'
        + '当用户说“让 Codex 做……”“交给 Codex 执行……”，或希望把编码、排障、批量文件处理任务委派出去时调用。'
        + '工作目录必须在 DSH 配置的白名单内；默认沙箱由宿主配置与运行时开关共同决定；失败时如实返回失败原因。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TASK_CHARS,
            description: '完整、明确的任务说明，包含目标、约束和验收标准。',
          },
          cwd: {
            type: 'string',
            description: '可选的绝对工作目录，必须真实存在且位于白名单内；省略时使用 defaultCwd。',
          },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Codex 沙箱模式；省略时用 defaultSandbox()（宿主 allowDangerFullAccess 与 codex_danger 运行时开关共同决定）。',
          },
          timeoutSec: {
            type: 'number',
            minimum: 1,
            description: '本次超时秒数，不超过插件配置的 timeoutSec。',
          },
        },
        required: ['task'],
      },
      async execute(args, context) {
        if (!enabledNow()) {
          return '⛔ Codex 委派已关闭。请先用 codex_switch 打开。';
        }

        const task = String(args?.task ?? '').trim();
        if (!task) return '❌ 任务不能为空。';
        if (task.length > MAX_TASK_CHARS) return `❌ 任务过长，最多 ${MAX_TASK_CHARS} 字符。`;

        const sandbox = String(args?.sandbox || defaultSandbox());
        if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
          return `❌ 不支持的沙箱模式：${sandbox}`;
        }
        if (sandbox === 'danger-full-access' && !allowDanger) {
          return '❌ danger-full-access 未获宿主配置许可，拒绝执行。';
        }
        if (sandbox === 'danger-full-access' && !dangerNow()) {
          return '🛡 danger-full-access 已被 codex_danger 关闭；请先用 codex_danger 打开，或显式传 workspace-write。';
        }

        let cwd;
        try {
          cwd = resolveRunCwd(args?.cwd);
        } catch (error) {
          return `❌ ${String(error?.message || error)}`;
        }

        if (!existsSync(bin) && bin.includes(sep)) {
          return `❌ 找不到 Codex 可执行文件：${bin}`;
        }

        const timeoutSec = clamp(
          finiteNumber(args?.timeoutSec, maxTimeoutSec),
          1,
          maxTimeoutSec,
        );
        const argv = [
          'exec',
          '-C', cwd,
          '-s', sandbox,
          '--skip-git-repo-check',
          '--ephemeral',
          '--color', 'never',
          '--',
          task,
        ];
        const result = await runCodex(bin, argv, {
          cwd,
          timeoutMs: Math.round(timeoutSec * 1_000),
          maxChars: maxOutputChars,
          signal: getAbortSignal(context),
        });

        lastRun = {
          at: new Date().toISOString(),
          ok: result.ok,
          code: result.code,
          ms: result.ms,
          sandbox,
        };

        const status = result.ok
          ? `✅ Codex 执行完成（${(result.ms / 1_000).toFixed(1)}s，${sandbox}）`
          : `❌ Codex 执行失败（${result.code}，${(result.ms / 1_000).toFixed(1)}s，${sandbox}）`;
        const sections = [status];
        if (result.stdout) sections.push(`--- stdout ---\n${result.stdout}`);
        if (result.stderr) sections.push(`--- stderr ---\n${result.stderr}`);
        if (result.error) sections.push(`--- error ---\n${result.error}`);
        if (sections.length === 1) sections.push('(无输出)');
        return sections.join('\n\n');
      },
    }),

    textTool({
      name: 'codex_status',
      description: '检查 Codex 委派插件的开关、Codex CLI 版本、认证状态、目录白名单和安全配置。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      timeoutMs: 35_000,
      async execute() {
        const statusCwd = safeStatusCwd();
        const version = await runCodex(bin, ['--version'], {
          cwd: statusCwd,
          timeoutMs: 15_000,
          maxChars: 2_000,
        });
        const login = await runCodex(bin, ['login', 'status'], {
          cwd: statusCwd,
          timeoutMs: 15_000,
          maxChars: 2_000,
        });

        const lines = [
          `🔌 开关：${enabledNow() ? '打开' : '关闭'}`,
          `📦 Codex：${version.ok ? version.stdout : `不可用（${version.error || version.stderr || version.code}）`}`,
          `🔑 认证：${login.stdout || login.stderr || (login.ok ? '未知' : login.code)}`,
          `📁 白名单：${allowedRoots.length ? allowedRoots.join('、') : '（空）'}`,
          `🛡 危险模式：${allowDanger ? (dangerNow() ? '允许且当前打开' : '允许但当前关闭') : '禁止'}`,
          `⏱ 超时上限：${maxTimeoutSec}s`,
          `📏 输出上限：${maxOutputChars} 字符`,
        ];
        if (warnings.length) lines.push(`⚠️ 配置提示：${warnings.join('；')}`);
        if (lastRun) {
          lines.push(`🕘 本进程最近调用：${lastRun.at}｜${lastRun.ok ? '成功' : '失败'}｜${lastRun.ms}ms｜${lastRun.sandbox}`);
        }
        return lines.join('\n');
      },
    }),

    textTool({
      name: 'codex_danger',
      description: '切换 danger-full-access 运行时开关。'
        + '仅在宿主配置 allowDangerFullAccess: true 时有效；'
        + '打开后 codex_run 默认使用 danger-full-access（无沙箱），关闭则回到 workspace-write。'
        + '此开关影响下一次 codex_run 的默认沙箱，不影响显式传入的 sandbox 参数。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true 为打开危险模式（默认沙箱变 danger-full-access），false 为关闭（回到 workspace-write）。',
          },
        },
        required: ['enabled'],
      },
      timeoutMs: 10_000,
      async execute(args) {
        if (!allowDanger) {
          return '❌ 宿主配置未开启 allowDangerFullAccess，此开关无效。';
        }
        const danger = args?.enabled === true;
        if (!writeState({ dangerFullAccess: danger })) {
          return '❌ 无法写入 Codex 危险模式状态，请检查 DSH 状态目录权限。';
        }
        return danger
          ? '🔓 危险模式已打开：codex_run 默认沙箱为 danger-full-access。'
          : '🛡 危险模式已关闭：codex_run 默认沙箱为 workspace-write。';
      },
    }),

    textTool({
      name: 'codex_switch',
      description: '即时打开或关闭 Codex 委派，不需要重启 DSH；关闭后 codex_run 会拒绝执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true 为打开，false 为关闭。',
          },
        },
        required: ['enabled'],
      },
      timeoutMs: 10_000,
      async execute(args) {
        const enabled = args?.enabled === true;
        if (!writeState({ enabled })) {
          return '❌ 无法写入 Codex 委派状态，请检查 DSH 状态目录权限。';
        }
        return enabled
          ? '🔓 Codex 委派已打开。'
          : '🔒 Codex 委派已关闭；codex_run 从现在起拒绝执行。';
      },
    }),
  ];

  for (const tool of tools) {
    const dispose = ctx.tools.register(tool);
    if (typeof dispose === 'function') {
      ctx.effect?.(() => dispose);
    }
  }

  ctx.logger?.info?.(`[use-codex] registered ${tools.length} tools; allowed roots=${allowedRoots.length}; enabled=${enabledNow()}; danger=${dangerNow()}`);
}

export default { name, inject, apply };
