/**
 * Offline self-test. Uses a fake Codex executable and temporary directories,
 * so it does not call a real model, network service, or private workspace.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = mkdtempSync(join(tmpdir(), 'dsh-use-codex-test-'));
const allowedRoot = join(testRoot, 'allowed');
const outsideRoot = join(testRoot, 'outside');
const stateFile = join(testRoot, 'state.json');
const argsFile = join(testRoot, 'fake-args.txt');
const fakeBin = join(testRoot, 'fake-codex');
mkdirSync(allowedRoot);
mkdirSync(outsideRoot);

writeFileSync(fakeBin, `#!/bin/sh
case "$1" in
  --version)
    echo "fake-codex 0.0.0"
    exit 0
    ;;
  login)
    echo "Logged in (fake)"
    exit 0
    ;;
  exec)
    if [ "\${CODEX_FAKE_SLEEP:-0}" = "1" ]; then
      sleep 5
    fi
    printf '%s\\n' "$@" > "$CODEX_FAKE_ARGS"
    echo "FAKE_CODEX_OK"
    exit 0
    ;;
esac
echo "unexpected fake-codex invocation" >&2
exit 2
`);
chmodSync(fakeBin, 0o755);

process.env.USE_CODEX_STATE = stateFile;
process.env.CODEX_FAKE_ARGS = argsFile;

const { apply, inject, name } = await import(`./lib/index.js?selftest=${Date.now()}`);

const registered = new Map();
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
};

apply(ctx, {
  enabled: true,
  bin: fakeBin,
  defaultCwd: allowedRoot,
  allowedRoots: [allowedRoot],
  allowDangerFullAccess: false,
  timeoutSec: 30,
  maxOutputChars: 4000,
});

let failed = 0;
const check = (label, condition, extra = '') => {
  console.log(`${condition ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failed += 1;
};

const run = registered.get('codex_run');
const status = registered.get('codex_status');
const toggle = registered.get('codex_switch');

check('插件名', name === 'use-codex');
check('声明 tools 注入', inject.includes('tools'));
check('注册 4 个工具', registered.size === 4, [...registered.keys()].join(', '));

check('空任务被拒绝', (await run.execute({ task: '   ' })).includes('任务不能为空'));
check('不存在目录被拒绝', (await run.execute({ task: 'x', cwd: join(testRoot, 'missing') })).includes('不存在'));
check('白名单外目录被拒绝', (await run.execute({ task: 'x', cwd: outsideRoot })).includes('不在白名单内'));

const escapeLink = join(allowedRoot, 'escape');
symlinkSync('/etc', escapeLink);
check('软链逃逸被拒绝', (await run.execute({ task: 'x', cwd: escapeLink })).includes('不在白名单内'));

check('危险模式默认被拒绝', (await run.execute({ task: 'x', sandbox: 'danger-full-access' })).includes('未获宿主配置许可'));

await toggle.execute({ enabled: false });
check('即时关闭后拒绝执行', (await run.execute({ task: 'x' })).includes('已关闭'));
await toggle.execute({ enabled: true });

const runResult = await run.execute({ task: '只输出测试结果' });
check('正常执行返回假 Codex 输出', runResult.includes('FAKE_CODEX_OK'), runResult.split('\n')[0]);
const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
check('默认使用 workspace-write（宿主未开启危险模式）', argv.includes('workspace-write'));
check('使用非持久会话参数', argv.includes('--ephemeral'));
check('任务作为最后一个参数传入', argv.at(-1) === '只输出测试结果');

const statusResult = await status.execute({});
check('状态查询可运行', statusResult.includes('fake-codex 0.0.0') && statusResult.includes('白名单'));
check('状态显示认证信息', statusResult.includes('Logged in (fake)'));

const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
check('状态文件只保存开关和时间', Object.keys(persisted).sort().join(',') === 'enabled,updatedAt');
check('状态文件不保存任务或目录', !JSON.stringify(persisted).includes('只输出测试结果') && !JSON.stringify(persisted).includes(allowedRoot));

process.env.CODEX_FAKE_SLEEP = '1';
const timeoutResult = await run.execute({ task: '触发超时', timeoutSec: 1 });
delete process.env.CODEX_FAKE_SLEEP;
check('超时能够终止子进程', timeoutResult.includes('timeout'), timeoutResult.split('\n')[0]);

const danger = registered.get('codex_danger');
check('codex_danger 已注册', typeof danger === 'function' || danger?.execute != null);

const dangerOff = await danger.execute({ enabled: false });
check('宿主未开启时 codex_danger 无效', dangerOff.includes('宿主配置未开启'));

// --- scenario 2: host config allows danger; codex_danger controls runtime default ---
const registered2 = new Map();
const ctx2 = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register(t) { registered2.set(t.name, t); return () => registered2.delete(t.name); } },
};
apply(ctx2, {
  enabled: true,
  bin: fakeBin,
  defaultCwd: allowedRoot,
  allowedRoots: [allowedRoot],
  allowDangerFullAccess: true,
  timeoutSec: 30,
  maxOutputChars: 4000,
});
const run2 = registered2.get('codex_run');
const danger2 = registered2.get('codex_danger');
const status2 = registered2.get('codex_status');

const onMsg = await danger2.execute({ enabled: true });
check('宿主开启后 codex_danger 可打开', onMsg.includes('危险模式已打开'), onMsg);
const dangerRun = await run2.execute({ task: '危险模式测试' });
const dangerArgv = readFileSync(argsFile, 'utf8').trim().split('\n');
check('危险模式打开后默认 danger-full-access', dangerArgv.includes('danger-full-access'), dangerArgv.join(' '));
const statusDanger = await status2.execute({});
check('状态显示危险模式当前打开', statusDanger.includes('允许且当前打开'));

await danger2.execute({ enabled: false });
const safeArgv0 = readFileSync(argsFile, 'utf8');
const safeRun = await run2.execute({ task: '回到安全模式' });
const safeArgv = readFileSync(argsFile, 'utf8').trim().split('\n');
check('codex_danger 关闭后默认回到 workspace-write', safeArgv.includes('workspace-write'), safeArgv.join(' '));
const statusSafe = await status2.execute({});
check('状态显示危险模式当前关闭', statusSafe.includes('允许但当前关闭'));

try {
  assert.equal(registered.size, 4);
} catch (error) {
  console.error(error);
  failed += 1;
}

rmSync(testRoot, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
