import AsyncStorage from '@react-native-async-storage/async-storage';
import {Platform} from 'react-native';

import NativeTwinCorePerf from '../specs/NativeTwinCorePerf';
import type {
  TwinCoreKillReport,
  TwinCorePerfMode,
  TwinCorePerfReport,
  TwinCoreShizukuStatus,
} from '../specs/NativeTwinCorePerf';

/**
 * TwinCore 性能模式的 RN 侧门面。
 *
 * 设计约束（很重要）：
 *  1. **应用启动绝不自动改系统设置**。这里只提供显式的 apply / restore，
 *     持久化只负责「记住上一次选了哪一档」，是否写内核由用户点按钮决定。
 *  2. 原生把每个写入项单独判定：成功项进 report.applied、失败项进 report.failures，
 *     fullyApplied=false 但 applied 非空 = 部分生效（MIUI perfd 常干这种事），
 *     UI 必须如实展示，不能粉饰。
 *  3. Shizuku 未授权/不可用是「性能模式的正常降级状态」，不是错误。
 */

const STORAGE_KEY_MODE = '@twincore/performanceMode';
const STORAGE_KEY_AUTO_REAPPLY = '@twincore/autoReapply';

export const DEFAULT_PERFORMANCE_MODE: TwinCorePerfMode = 'balanced';

export const PERFORMANCE_MODES: TwinCorePerfMode[] = [
  'powersave',
  'balanced',
  'performance',
];

/** 定期重新应用的间隔（毫秒）。只在前台生效。 */
export const AUTO_REAPPLY_INTERVAL_MS = 60_000;

/**
 * 只有 Android 上有原生实现；iOS / 还没注册 TurboModule 时 `get()` 返回 null。
 * 用 get 而不是 getEnforcing 就是为了这里能优雅退化而不是崩设置页。
 */
export function isPerformanceModeSupported(): boolean {
  return Platform.OS === 'android' && NativeTwinCorePerf != null;
}

export type TwinCorePerfOutcome<T> =
  | {kind: 'ok'; value: T}
  | {kind: 'unsupported'; reason: string}
  | {kind: 'error'; reason: string};

const unsupported = <T,>(reason: string): TwinCorePerfOutcome<T> => ({
  kind: 'unsupported',
  reason,
});

// ---------------------------------------------------------------------------
// 持久化：只记住「上次选了哪一档」和「是否定期重应用」，不记住「是否正在生效」
// ---------------------------------------------------------------------------

export async function loadPerformanceMode(): Promise<TwinCorePerfMode> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_MODE);
    if (raw && (PERFORMANCE_MODES as string[]).includes(raw)) {
      return raw as TwinCorePerfMode;
    }
  } catch (e) {
    console.warn('[TwinCore] 读取性能模式失败，回退到 balanced', e);
  }
  return DEFAULT_PERFORMANCE_MODE;
}

export async function savePerformanceMode(mode: TwinCorePerfMode): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_MODE, mode);
  } catch (e) {
    console.warn('[TwinCore] 持久化性能模式失败', e);
  }
}

export async function loadAutoReapply(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY_AUTO_REAPPLY)) === '1';
  } catch (e) {
    console.warn('[TwinCore] 读取定期重应用开关失败', e);
    return false;
  }
}

export async function saveAutoReapply(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_AUTO_REAPPLY, enabled ? '1' : '0');
  } catch (e) {
    console.warn('[TwinCore] 持久化定期重应用开关失败', e);
  }
}

// ---------------------------------------------------------------------------
// Shizuku 状态
// ---------------------------------------------------------------------------

/** 只读检测，不弹任何窗。面板的「重新检测」按钮用它。 */
export async function readShizukuStatus(): Promise<
  TwinCorePerfOutcome<TwinCoreShizukuStatus>
> {
  if (!isPerformanceModeSupported()) {
    return unsupported('Shizuku 状态检测仅在 Android 上可用。');
  }
  try {
    return {kind: 'ok', value: await NativeTwinCorePerf!.getShizukuStatus()};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

/** 完整授权流程（内部最多等 120 秒，绝不永久挂起）。 */
export async function requestShizukuPermission(): Promise<
  TwinCorePerfOutcome<TwinCoreShizukuStatus>
> {
  if (!isPerformanceModeSupported()) {
    return unsupported('CPU 调频仅在 Android 上可用。');
  }
  try {
    return {kind: 'ok', value: await NativeTwinCorePerf!.requestShizukuPermission()};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

/** 拉起 Shizuku Manager。返回实际拉起的包名，空串=没找到。 */
export async function openShizukuManager(): Promise<TwinCorePerfOutcome<string>> {
  if (!isPerformanceModeSupported()) {
    return unsupported('仅在 Android 上可用。');
  }
  try {
    return {kind: 'ok', value: await NativeTwinCorePerf!.openShizukuManager()};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

// ---------------------------------------------------------------------------
// 调频
// ---------------------------------------------------------------------------

/** 显式应用某一档。这是唯一会写 /sys 的入口（定期重应用也走它）。 */
export async function applyPerformanceMode(
  mode: TwinCorePerfMode,
): Promise<TwinCorePerfOutcome<TwinCorePerfReport>> {
  if (!isPerformanceModeSupported()) {
    return unsupported('CPU 调频仅在 Android 上可用。');
  }
  try {
    const report = await NativeTwinCorePerf!.setPerformanceMode(mode);
    // 与 handleSelect 的持久化保持同值（选择 ≠ 生效，这里只是确保两者不漂移）。
    await savePerformanceMode(mode);
    return {kind: 'ok', value: report};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

/** 只读回当前 CPU 状态，不修改任何东西。 */
export async function readPerformanceMode(): Promise<
  TwinCorePerfOutcome<TwinCorePerfReport>
> {
  if (!isPerformanceModeSupported()) {
    return unsupported('CPU 调频仅在 Android 上可用。');
  }
  try {
    return {kind: 'ok', value: await NativeTwinCorePerf!.getPerformanceMode()};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

/** 恢复首次调频前备份的 governor / 频率上下限。 */
export async function restorePerformanceMode(): Promise<
  TwinCorePerfOutcome<TwinCorePerfReport>
> {
  if (!isPerformanceModeSupported()) {
    return unsupported('CPU 调频仅在 Android 上可用。');
  }
  try {
    const report = await NativeTwinCorePerf!.restorePerformanceMode();
    return {kind: 'ok', value: report};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

// ---------------------------------------------------------------------------
// 智能模式：杀非系统后台进程（需求 7）
// ---------------------------------------------------------------------------

/**
 * 杀掉非系统后台进程，只保留 Shizuku 与本应用。
 *
 * 高风险操作：会终止其它后台应用。调用方必须在 UI 上给出明确警告。
 * 原生侧已 try/catch 且未授权时只回报告，但这里仍再包一层 —— 桥接层
 * 抛异常不能让它冒泡到 UI 把页面带崩。
 */
export async function killBackgroundProcesses(): Promise<
  TwinCorePerfOutcome<TwinCoreKillReport>
> {
  if (!isPerformanceModeSupported()) {
    return unsupported('智能模式仅在 Android 上可用。');
  }
  try {
    return {kind: 'ok', value: await NativeTwinCorePerf!.killBackgroundProcesses()};
  } catch (e: any) {
    return {kind: 'error', reason: e?.message ?? String(e)};
  }
}

// ---------------------------------------------------------------------------
// 展示用小工具
// ---------------------------------------------------------------------------

/** 把 kHz 显示成人能读的 GHz。 */
export function formatFreqKhz(khz: number): string {
  if (!khz || khz <= 0) {
    return '—';
  }
  return `${(khz / 1_000_000).toFixed(2)} GHz`;
}

/** [6, 7] -> "6, 7"；空数组 -> "—" */
export function formatCpuList(cpus: number[]): string {
  if (!cpus || cpus.length === 0) {
    return '—';
  }
  return cpus.join(', ');
}
