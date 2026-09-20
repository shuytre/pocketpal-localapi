import {runInAction} from 'mobx';

import {localApiStore} from '../../store/LocalApiStore';
import {modelStore} from '../../store/ModelStore';
import {setModelResident} from '../localApi/residencyGuard';
import {localApiBridge} from '../localApi/localApiBridge';

import {
  detectDeviceProfile,
  recommendParams,
  type DeviceProfile,
  type RecommendedParams,
} from './deviceProfile';

export interface BootResult {
  profile: DeviceProfile;
  recommended: RecommendedParams;
  tuningApplied: boolean;
  serviceStarted: boolean;
  errors: string[];
}

/**
 * 打开 App 后自动进入最佳性能模式（需求 8）。
 *
 * 幂等：模块级标记保证热重载 / 组件重复挂载时只跑一次 —— 不重复绑核、
 * 不重复启服务。
 *
 * 执行顺序不可换：
 *   识别机型 → 参数写进配置 → 同步进原生配置 → 原子应用 → 最后才启服务
 * 每一条顺序的理由：
 *   1. 最后才启服务 —— 先启服务再调优的话，第一个到来的请求会跑在未调优的
 *      线程上，用户看到的**首个响应就是慢的**。
 *   2. 先把参数写进配置再调原生 —— 反过来的话原生已按新参数绑好核，而配置里
 *      还是旧值，界面与实况不一致，且下次改任何别的开关都会用旧参数覆盖回去。
 *   3. 必须原子应用 —— 中间态「已绑 2 个大核但 n_threads 还是 8」比完全不调优
 *      更慢。
 */
let booted = false;

export const hasBootstrapped = (): boolean => booted;

export async function bootstrapPerformanceMode(): Promise<BootResult | null> {
  if (booted) {
    return null;
  }
  booted = true;

  const errors: string[] = [];

  // 模型生命周期联动（503 判定 + 内存锁定）先挂上，
  // 这样服务启动的那一刻 native 侧就知道模型状态。
  localApiStore.startModelLifecycleWatch();
  localApiBridge.startListening();

  // ① 识别机型
  let profile: DeviceProfile;
  try {
    profile = await detectDeviceProfile();
  } catch (error) {
    profile = {
      label: '未识别机型',
      topology: null,
      totalCores: 0,
      bigCoreCount: 0,
      memTotalMb: 0,
      socLabel: '',
      recognized: false,
      confidence: 'low',
      presetId: 'unknown',
      reasons: ['拓扑探测抛出异常'],
    };
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const recommended = recommendParams(profile);

  runInAction(() => {
    localApiStore.profileLabel = profile.label;
    localApiStore.profileConfidence = profile.confidence;
    localApiStore.profileReasons = recommended.reasons;
    localApiStore.topology = profile.topology;
  });

  // ② 参数写进配置
  runInAction(() => {
    localApiStore.forceCoreCount = recommended.forceCoreCount;
    localApiStore.bindBigCores = recommended.bindBigCores;
    localApiStore.enablePriority = recommended.enablePriority;
    localApiStore.niceTarget = recommended.niceTarget;
    localApiStore.sseMinChars = recommended.sseMinChars;
    localApiStore.sseMaxLatencyMs = recommended.sseMaxLatencyMs;
    localApiStore.sseHeartbeatMs = recommended.sseHeartbeatMs;
    localApiStore.drainWindowMs = recommended.drainWindowMs;
    localApiStore.keepModelResident = recommended.keepModelResident;
    localApiStore.mlockEnabled = recommended.mlockEnabled;
  });

  // n_threads 与实际目标核数对齐：避免出现「绑了 2 个核但起了 8 个线程」。
  try {
    localApiStore.alignThreadCount(recommended.nThreadsTarget);
    // use_mlock 是 llama.cpp 侧唯一的编译期开关；运行时那一半由我们自己补。
    if (recommended.mlockEnabled && !modelStore.contextInitParams.use_mlock) {
      modelStore.setUseMlock(true);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  setModelResident(
    localApiStore.keepModelResident && localApiStore.serviceEnabled,
  );

  // ③ 同步进原生配置并原子应用
  let tuningApplied = false;
  try {
    const report = await localApiStore.applyTuning();
    tuningApplied = Boolean(report?.applied);
    if (report && report.errors.length > 0) {
      errors.push(...report.errors);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // ④ 最后才启服务
  let serviceStarted = false;
  if (localApiStore.serviceEnabled) {
    try {
      serviceStarted = await localApiStore.startService();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  runInAction(() => {
    localApiStore.bootstrapped = true;
    if (errors.length > 0) {
      localApiStore.lastError = errors.join(' | ');
    }
  });

  // 失败只记录不抛出：调优是旁路增强，它失败绝不能让 App 起不来。
  return {profile, recommended, tuningApplied, serviceStarted, errors};
}

/** 把推荐参数写进 store 并重新原子应用的便利入口（界面上的「重新套用」按钮）。 */
export async function applyRecommendedToStore(
  recommended: RecommendedParams,
): Promise<void> {
  runInAction(() => {
    localApiStore.forceCoreCount = recommended.forceCoreCount;
    localApiStore.bindBigCores = recommended.bindBigCores;
    localApiStore.enablePriority = recommended.enablePriority;
    localApiStore.niceTarget = recommended.niceTarget;
    localApiStore.sseMinChars = recommended.sseMinChars;
    localApiStore.sseMaxLatencyMs = recommended.sseMaxLatencyMs;
    localApiStore.sseHeartbeatMs = recommended.sseHeartbeatMs;
    localApiStore.drainWindowMs = recommended.drainWindowMs;
    localApiStore.keepModelResident = recommended.keepModelResident;
    localApiStore.mlockEnabled = recommended.mlockEnabled;
  });
  localApiStore.alignThreadCount(recommended.nThreadsTarget);
  await localApiStore.applyTuning();
}
