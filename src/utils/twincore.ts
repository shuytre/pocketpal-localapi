/**
 * TwinCore —— 端侧推理运行时策略（红米 K20 / 骁龙 730）
 *
 * 为什么需要这一层：
 *
 * 1) CPU 亲和性在 Android 上曾经是「静默失效」的。llama.cpp 的实现被
 *    `#elif defined(__gnu_linux__)` 守卫，而 Android NDK 的 Clang 在
 *    aarch64-linux-android 下并不定义该宏（只定义 `__linux__` 与
 *    `__ANDROID__`），于是 Android 落进 `#else // unsupported platforms`
 *    的 stub 分支 —— 直接丢弃 cpu_mask 并返回成功。上游 PR #26838 把守卫
 *    改成 `__linux__`。本仓库锁定的 llama.rn 0.13.0-rc.3（llama.cpp
 *    b10588+）已包含该修复，所以这里不再动 ggml-cpu.c，只负责把参数真正
 *    传到 native 侧。
 *
 * 2) 骁龙 730 是 2×Cortex-A75 @2.2GHz（CPU 6/7）+ 6×Cortex-A55 @1.8GHz
 *    （CPU 0-5）。ggml 的 matmul 有同步屏障，一轮的耗时由最慢的那个线程
 *    决定；把 A55 拉进来只会拖慢 A75。因此强制：
 *      n_threads = 2 / cpu_mask = "0xC0" / cpu_strict = true
 *
 * 3) Hexagon 在 llama.rn 里是 opt-in，而且骁龙 730 的 Hexagon 688
 *    (HTP v3) 不在官方验证范围内（官方测的是 SM8450+ / HTP v4+）。
 *    所以不能「设了就信」：必须按 HTP → OpenCL → CPU 逐档尝试，
 *    失败就换下一档，绝不让后端初始化失败把应用带崩。
 */

import {Platform} from 'react-native';

import {
  ContextParams,
  LlamaContext,
  NativeBackendDeviceInfo,
  initLlama,
} from 'llama.rn';

import {getAvailableDevices} from './deviceSelection';
import NativePerfTune from '../specs/NativePerfTune';

/** CPU 6 + CPU 7 → 0b11000000。仅 Android 生效。 */
export const TWINCORE_CPU_MASK = '0xC0';

/** 只喂给两个 A75 大核。 */
export const TWINCORE_N_THREADS = 2;

/** TWINCORE_CPU_MASK 对应的 CPU 编号。只用于日志核对，不参与绑定。 */
export const TWINCORE_BIG_CPUS: number[] = [6, 7];

/**
 * 初始化完成后是否顺带跑一次 llama.cpp bench。
 * 默认 false —— bench 会把模型加载再拖慢若干秒。验证时改成 true，
 * 日志里就会出现 prompt / generation 的 tokens/s。
 */
export const TWINCORE_BENCH_ON_INIT = false;
export const TWINCORE_BENCH_PP = 64;
export const TWINCORE_BENCH_TG = 16;

/**
 * llama.rn 0.13.0-rc.3 的 `NativeContextParams` 并没有 `n_threads_batch`
 * 字段（它只出现在 bench 结果里）。这里补一个可选字段：
 *  - 现在：native 侧读不到，是 no-op；llama.cpp 的 cpuparams_batch 未显式
 *    设置时会继承 cpuparams，所以 n_threads=2 已经等价于 n_threads_batch=2。
 *  - 以后 llama.rn 补上该字段时，调用点无需改动。
 */
export type TwinCoreContextParams = Omit<ContextParams, 'model'> & {
  n_threads_batch?: number;
};

/** 后端回退链里的一档。 */
export interface TwinCoreBackendAttempt {
  label: string;
  devices: string[];
  n_gpu_layers: number;
}

type BenchResult = {
  prompt_per_second?: number;
  predicted_per_second?: number;
  timings?: {
    prompt_per_second?: number;
    predicted_per_second?: number;
  };
};

/** CPU 编号数组 → 十六进制掩码字符串，用于和 TWINCORE_CPU_MASK 对账。 */
export function cpusToMask(cpus: number[]): string {
  let mask = 0;
  for (const cpu of cpus) {
    if (cpu >= 0 && cpu < 32) {
      mask |= 1 << cpu;
    }
  }
  return `0x${mask.toString(16).toUpperCase()}`;
}

/**
 * 强制 TwinCore 的 CPU 策略。放在调用 initLlama 之前的最后一环，
 * 因此能盖掉所有上游来源（persisted 设置、UI setter、device rules）。
 */
export function applyTwinCoreCpuPolicy(
  params: Omit<ContextParams, 'model'>,
): TwinCoreContextParams {
  const out: TwinCoreContextParams = {
    ...params,
    n_threads_batch: TWINCORE_N_THREADS,
  };

  if (Platform.OS !== 'android') {
    // iOS 由 Metal + llama.rn 自己的线程策略负责，不做干预。
    return out;
  }

  out.n_threads = TWINCORE_N_THREADS;
  out.cpu_mask = TWINCORE_CPU_MASK;
  out.cpu_strict = true;
  return out;
}

function pickHexagon(devices: NativeBackendDeviceInfo[]): string | undefined {
  const hit = devices.find(
    device =>
      typeof device.deviceName === 'string' &&
      device.deviceName.startsWith('HTP') &&
      !/[*?]/.test(device.deviceName),
  );
  return hit?.deviceName;
}

function pickOpenCL(devices: NativeBackendDeviceInfo[]): string | undefined {
  const hit = devices.find(device => device.type === 'gpu');
  return hit?.deviceName;
}

/**
 * 后端优先级链：Hexagon HTP → Adreno OpenCL → CPU。
 * 用运行时探测到的真实设备名（而不是硬编码 'HTP0'），避免设备上报的是
 * HTP1 / 其它命名时绑空。返回空数组表示「不干预」（非 Android）。
 */
export async function resolveTwinCoreBackendChain(): Promise<
  TwinCoreBackendAttempt[]
> {
  if (Platform.OS !== 'android') {
    return [];
  }

  const devices = await getAvailableDevices();
  const chain: TwinCoreBackendAttempt[] = [];

  const htp = pickHexagon(devices);
  if (htp) {
    chain.push({label: 'Hexagon HTP', devices: [htp], n_gpu_layers: 99});
  }

  const gpu = pickOpenCL(devices);
  if (gpu) {
    chain.push({label: 'OpenCL GPU', devices: [gpu], n_gpu_layers: 99});
  }

  // CPU 永远在最后，且必须把 n_gpu_layers 归零，否则 llama.cpp 会继续
  // 尝试把层搬到不存在的后端上。
  chain.push({label: 'CPU', devices: ['CPU'], n_gpu_layers: 0});

  return chain;
}

/**
 * 回读 CPU 拓扑，核对「0xC0 到底是不是这台机器的大核」。
 * 用 NativePerfTune 的实测值，不硬编码 —— 同代 SoC 的簇布局在 6 核 / 8 核 /
 * 热插拔机型上并不一致。
 */
async function logTwinCoreTopology(): Promise<void> {
  if (Platform.OS !== 'android' || !NativePerfTune) {
    return;
  }
  try {
    const topo = await NativePerfTune.detectTopology();
    console.log(
      `[TwinCore] topology: cores=${topo.totalCores} clusters=${topo.clusterCount} ` +
        `big=${JSON.stringify(topo.bigClusterCpus)}@${topo.bigClusterFreqKhz}kHz ` +
        `singleCluster=${String(topo.singleCluster)} reliable=${String(topo.reliable)}`,
    );

    if (topo.reliable && topo.bigClusterCpus.length > 0) {
      const measured = topo.bigClusterCpus.join(',');
      const assumed = TWINCORE_BIG_CPUS.join(',');
      if (measured !== assumed) {
        console.warn(
          `[TwinCore] 实测大核是 CPU ${measured}` +
            `（掩码 ${cpusToMask(topo.bigClusterCpus)}），` +
            `与硬编码的 ${TWINCORE_CPU_MASK}（CPU ${assumed}）不一致 —— ` +
            `请修改 TWINCORE_CPU_MASK / TWINCORE_BIG_CPUS。`,
        );
      }
    }
  } catch (error) {
    console.warn('[TwinCore] detectTopology 失败：', error);
  }
}

/** 可选的吞吐量探针。TWINCORE_BENCH_ON_INIT 打开时才跑。 */
async function logTwinCoreThroughput(ctx: LlamaContext): Promise<void> {
  if (!TWINCORE_BENCH_ON_INIT) {
    return;
  }
  try {
    const bench = (
      ctx as unknown as {
        bench?: (pp: number, tg: number, pl: number) => Promise<BenchResult>;
      }
    ).bench;
    if (!bench) {
      return;
    }
    const started = Date.now();
    const result = await bench.call(
      ctx,
      TWINCORE_BENCH_PP,
      TWINCORE_BENCH_TG,
      1,
    );
    const pp = result?.timings?.prompt_per_second ?? result?.prompt_per_second;
    const tg =
      result?.timings?.predicted_per_second ?? result?.predicted_per_second;
    console.log(
      `[TwinCore] bench: pp=${String(pp)} t/s tg=${String(tg)} t/s ` +
        `(wall ${Date.now() - started}ms)`,
    );
  } catch (error) {
    console.warn('[TwinCore] bench 失败：', error);
  }
}

/**
 * 把实际生效的后端打进日志。initLlama 的返回值里 androidLib 会告诉我们
 * 加载的是哪个 .so 变体（是否带 hexagon_opencl），gpu / reasonNoGPU / devices
 * 则是 llama.cpp 侧的最终结论 —— 这是判断「NPU 到底用上没有」的唯一可信来源。
 */
async function logTwinCoreContext(
  ctx: LlamaContext,
  attempt: TwinCoreBackendAttempt | undefined,
  elapsedMs: number,
): Promise<void> {
  const raw = ctx as unknown as {
    androidLib?: string;
    devices?: string[];
    gpu?: boolean;
    reasonNoGPU?: string;
    systemInfo?: string;
  };

  console.log(
    `[TwinCore] init ok: backend=${attempt?.label ?? 'platform-default'} ` +
      `requestedDevices=${JSON.stringify(attempt?.devices ?? null)} ` +
      `actualDevices=${JSON.stringify(raw.devices ?? null)} ` +
      `androidLib=${raw.androidLib ?? 'n/a'} ` +
      `gpu=${String(raw.gpu ?? false)} ` +
      `reasonNoGPU=${raw.reasonNoGPU ?? 'n/a'} ` +
      `n_threads=${String(TWINCORE_N_THREADS)} cpu_mask=${TWINCORE_CPU_MASK} ` +
      `cpu_strict=true initMs=${elapsedMs}`,
  );

  if (raw.systemInfo) {
    console.log(`[TwinCore] systemInfo: ${raw.systemInfo}`);
  }

  await logTwinCoreTopology();
  await logTwinCoreThroughput(ctx);
}

/**
 * 替代直接调用 initLlama：
 *   1. 强制 CPU 亲和性参数（Android）
 *   2. 按 HTP → OpenCL → CPU 依次尝试，失败自动回退
 *   3. 记录实际生效的后端 / .so 变体 / 拓扑 / 耗时
 *
 * 全部档位都失败时抛最后一个错误，交给 ModelStore 原有的错误处理路径。
 */
export async function initLlamaWithTwinCore(
  params: Omit<ContextParams, 'model'> & {model: string},
  onProgress?: (progress: number) => void,
): Promise<LlamaContext> {
  const base = applyTwinCoreCpuPolicy(params);
  const chain = await resolveTwinCoreBackendChain();

  // 非 Android：不干预后端选择，走 llama.rn 默认。
  if (chain.length === 0) {
    const started = Date.now();
    const ctx = await initLlama(base as ContextParams, onProgress);
    await logTwinCoreContext(ctx, undefined, Date.now() - started);
    return ctx;
  }

  let lastError: unknown;
  for (const attempt of chain) {
    const started = Date.now();
    try {
      const ctx = await initLlama(
        {
          ...base,
          devices: attempt.devices,
          n_gpu_layers: attempt.n_gpu_layers,
        } as ContextParams,
        onProgress,
      );
      await logTwinCoreContext(ctx, attempt, Date.now() - started);
      return ctx;
    } catch (error) {
      lastError = error;
      console.warn(
        `[TwinCore] 后端 "${attempt.label}" 初始化失败 ` +
          `(${Date.now() - started}ms)，回退到下一档：`,
        error,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`[TwinCore] 所有后端均初始化失败: ${String(lastError)}`);
}
