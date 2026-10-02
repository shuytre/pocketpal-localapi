/**
 * TwinCore 启动期错误记录器。
 *
 * 为什么需要它：用户报「除对话页外全部整屏红屏」，但红屏的具体堆栈我一直
 * 无法从代码静态推断出来（tsc / eslint / Metro 打包全部通过 —— 它们只保证
 * 模块能解析、类型能对上，不保证运行期组件能渲染）。
 *
 * 这个模块挂上 RN 的全局错误处理器，把**完整堆栈**写到设备上的
 * files/crash-log.txt，同时打印到 logcat。这样复现一次之后就能拿到真因，
 * 而不是继续猜。
 *
 * 只做记录，不吞异常 —— 记录完仍把它交给原始处理器，红屏照旧显示。
 */
import {Platform} from 'react-native';

const LOG_FILE = 'crash-log.txt';

let installed = false;

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

const writeLog = async (text: string) => {
  // 延迟 require，避免在早期启动阶段拉起 fs 原生模块拖慢冷启动。
  try {
    const RNFS = require('@dr.pogodin/react-native-fs');
    const path = `${RNFS.DocumentDirectoryPath}/${LOG_FILE}`;
    // 覆盖写：只关心最近一次崩溃。
    await RNFS.writeFile(path, text, 'utf8');

    console.log(`[TwinCore] crash log written to ${path}`);
  } catch (e) {
    // 记录失败不能再抛，否则递归。

    console.log('[TwinCore] failed to persist crash log', String(e));
  }
};

const format = (error: unknown, isFatal?: boolean) => {
  const ts = new Date().toISOString();
  const err = error as any;
  const lines = [
    `time: ${ts}`,
    `platform: ${Platform.OS} ${String(Platform.Version)}`,
    `fatal: ${String(isFatal)}`,
    `name: ${String(err?.name)}`,
    `message: ${String(err?.message ?? err)}`,
    '',
    'stack:',
    String(err?.stack ?? '(no stack)'),
    '',
    'componentStack:',
    String(err?.componentStack ?? '(none)'),
  ];
  return lines.join('\n');
};

export const installCrashLogger = () => {
  if (installed) {
    return;
  }
  installed = true;

  // RN 把 ErrorUtils 挂在 global 上；这里不直接用 global 标识符，避免
  // 在缺少 @types/node 的类型环境里报 "Cannot find name 'global'"。
  const ErrorUtils = (globalThis as any)?.ErrorUtils;
  if (!ErrorUtils?.getGlobalHandler) {
    return;
  }

  const original: ErrorHandler = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const text = format(error, isFatal);
    // logcat 里也能直接看到（adb logcat | grep TwinCore）。

    console.log('[TwinCore][CRASH]\n' + text);
    void writeLog(text);
    // 仍然交给原始处理器：不能静默吞掉崩溃。
    original?.(error, isFatal);
  });
};
