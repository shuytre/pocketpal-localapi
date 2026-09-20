import NativeHardwareInfo from '../../specs/NativeHardwareInfo';
import NativePerfTune from '../../specs/NativePerfTune';
import type {TopologyInfo} from '../../specs/NativePerfTune';

/**
 * 机型识别与推荐参数（需求 9）。
 *
 * 判定顺序是「先看簇结构，再看 SoC 名」：簇结构决定了能不能绑、绑几个，这是
 * 性能的直接决定因素；SoC 名只用于生成更友好的标签。反过来做会在不认识的 SoC
 * 上给不出任何建议。
 *
 * 这条文件只产出建议，不直接改状态 —— 上层决定要不要套用，用户也才能看到
 * 「为什么给出这些值」。
 */

export type PresetId = 'k20' | 'big-little' | 'uniform' | 'unknown';

export interface DeviceProfile {
  label: string;
  topology: TopologyInfo | null;
  totalCores: number;
  bigCoreCount: number;
  memTotalMb: number;
  socLabel: string;
  recognized: boolean;
  confidence: 'high' | 'medium' | 'low';
  presetId: PresetId;
  reasons: string[];
}

export interface RecommendedParams {
  forceCoreCount: number;
  bindBigCores: boolean;
  enablePriority: boolean;
  niceTarget: number;
  nThreadsTarget: number;
  keepModelResident: boolean;
  mlockEnabled: boolean;
  sseMinChars: number;
  sseMaxLatencyMs: number;
  sseHeartbeatMs: number;
  drainWindowMs: number;
  reasons: string[];
}

const K20_SOC_PATTERNS = [/sdm730/i, /sm7150/i, /davinci/i, /raphael/i];

const MEM_RESIDENT_THRESHOLD_MB = 6 * 1024;

async function readSocLabel(fallback: string): Promise<string> {
  try {
    const cpuInfo = await NativeHardwareInfo?.getCPUInfo();
    const candidate =
      cpuInfo?.socModel || cpuInfo?.hardware || fallback || '';
    return candidate.trim();
  } catch {
    return fallback;
  }
}

export async function detectDeviceProfile(): Promise<DeviceProfile> {
  let topology: TopologyInfo | null = null;
  try {
    topology = (await NativePerfTune?.detectTopology()) ?? null;
  } catch {
    topology = null;
  }

  const reasons: string[] = [];

  if (!topology || !topology.reliable) {
    reasons.push('未能读取 CPU 拓扑（/sys/devices/system/cpu 不可用）');
    return {
      label: '未识别机型',
      topology,
      totalCores: topology?.totalCores ?? 0,
      bigCoreCount: 0,
      memTotalMb: topology?.memTotalMb ?? 0,
      socLabel: await readSocLabel(topology?.hardware ?? ''),
      recognized: false,
      confidence: 'low',
      presetId: 'unknown',
      // 识别失败明确降级，绝不静默：绑定未知核比不绑更糟。
      reasons: [
        ...reasons,
        '未能识别机型，按通用配置应用（不做大核绑定）',
      ],
    };
  }

  const totalCores = topology.totalCores;
  const bigCoreCount = topology.bigClusterCpus.length;
  const memTotalMb = topology.memTotalMb;
  const socLabel = await readSocLabel(topology.hardware ?? '');

  const isUniform = topology.singleCluster;
  const isTwoPlusSix =
    !isUniform && totalCores === 8 && bigCoreCount === 2 && topology.smallCoreCount === 6;
  const socMatchesK20 = K20_SOC_PATTERNS.some(pattern => pattern.test(socLabel));

  if (isUniform) {
    reasons.push(
      `所有核心同频（${Math.round(topology.bigClusterFreqKhz / 1000)}MHz），不存在大小核结构`,
    );
    reasons.push('绑定任何核心都是无用功 → 保持全核可用');
    return {
      label: socLabel || `${totalCores} 核设备`,
      topology,
      totalCores,
      bigCoreCount: 0,
      memTotalMb,
      socLabel,
      recognized: true,
      confidence: 'medium',
      presetId: 'uniform',
      reasons,
    };
  }

  if (socMatchesK20 || isTwoPlusSix) {
    reasons.push(
      `簇结构 ${bigCoreCount} 大 + ${topology.smallCoreCount} 小 = ${totalCores} 核` +
        (socMatchesK20 ? `，SoC 名 ${socLabel} 命中 K20 预设` : ''),
    );
    reasons.push('强制使用 2 个大核，线程数与之对齐');
    return {
      label: socMatchesK20 ? `红米 K20 系列（${socLabel}）` : `${bigCoreCount} 大 + ${topology.smallCoreCount} 小`,
      topology,
      totalCores,
      bigCoreCount,
      memTotalMb,
      socLabel,
      recognized: true,
      confidence: 'high',
      presetId: 'k20',
      reasons,
    };
  }

  reasons.push(
    `大小核机型：${bigCoreCount} 大 + ${topology.smallCoreCount} 小 = ${totalCores} 核`,
  );
  reasons.push('跟随高频簇（不强制核数），线程数对齐到高频簇大小');
  return {
    label: socLabel || `${bigCoreCount} 大 + ${topology.smallCoreCount} 小`,
    topology,
    totalCores,
    bigCoreCount,
    memTotalMb,
    socLabel,
    recognized: true,
    confidence: 'medium',
    presetId: 'big-little',
    reasons,
  };
}

/**
 * 「强制 N 核」的语义必须是「最高频的前 N 个核」，而不是整个高频簇 —— 具体由
 * 原生侧按频点降序取前 N 实现。这里只给出 N 与目标核数。
 */
export function recommendParams(profile: DeviceProfile): RecommendedParams {
  const base = {
    sseMinChars: 12,
    sseMaxLatencyMs: 60,
    sseHeartbeatMs: 15_000,
    drainWindowMs: 40,
    niceTarget: -20,
  };

  const memOk = profile.memTotalMb === 0 || profile.memTotalMb >= MEM_RESIDENT_THRESHOLD_MB;
  const residencyReason = memOk
    ? `内存 ${profile.memTotalMb}MB ≥ 6GB → 开启模型常驻`
    : `内存 ${profile.memTotalMb}MB < 6GB → 保守起见不开启模型常驻`;

  switch (profile.presetId) {
    case 'k20':
      return {
        ...base,
        forceCoreCount: 2,
        bindBigCores: true,
        enablePriority: true,
        nThreadsTarget: 2,
        keepModelResident: memOk,
        mlockEnabled: true,
        reasons: [
          ...profile.reasons,
          '线程数不得超过物理大核数：ggml 的 matmul 有同步屏障，一次计算的耗时由最慢的那个线程决定',
          residencyReason,
          'mlock 的编译期参数（use_mlock）由运行时这一半补足：RLIMIT_MEMLOCK 默认仅 64KB',
        ],
      };
    case 'big-little':
      return {
        ...base,
        forceCoreCount: 0, // 0 = 跟随最高频簇
        bindBigCores: true,
        enablePriority: true,
        nThreadsTarget: profile.bigCoreCount,
        keepModelResident: memOk,
        mlockEnabled: true,
        reasons: [
          ...profile.reasons,
          `n_threads 对齐到高频簇大小 ${profile.bigCoreCount}`,
          residencyReason,
        ],
      };
    case 'uniform':
      return {
        ...base,
        forceCoreCount: 0,
        bindBigCores: false,
        enablePriority: true,
        nThreadsTarget: profile.totalCores,
        keepModelResident: memOk,
        mlockEnabled: true,
        reasons: [...profile.reasons, residencyReason],
      };
    default:
      // 识别失败 → 通用配置 + 可信度低 + 不做大核绑定。
      return {
        ...base,
        forceCoreCount: 0,
        bindBigCores: false,
        enablePriority: true,
        nThreadsTarget: 0, // 0 = 不动用户设置
        keepModelResident: false,
        mlockEnabled: true,
        reasons: [
          ...profile.reasons,
          '不对未知拓扑做核心绑定：绑错比不绑更糟',
          residencyReason,
        ],
      };
  }
}
