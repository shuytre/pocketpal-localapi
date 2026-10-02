import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {AppState, Platform, Pressable, View} from 'react-native';
import {Button, Card, Divider, Switch, Text} from 'react-native-paper';
import {BatteryCharging, Gauge, Zap} from 'lucide-react-native';

import {useTheme} from '../../hooks';
import {t} from '../../locales';
import {L10nContext} from '../../utils';
import {LiquidGlass, RADIUS} from '../../components/LiquidGlass';

import {createStyles} from './styles';
import {
  AUTO_REAPPLY_INTERVAL_MS,
  DEFAULT_PERFORMANCE_MODE,
  PERFORMANCE_MODES,
  applyPerformanceMode,
  formatCpuList,
  formatFreqKhz,
  isPerformanceModeSupported,
  loadAutoReapply,
  loadPerformanceMode,
  openShizukuManager,
  readPerformanceMode,
  readShizukuStatus,
  requestShizukuPermission,
  restorePerformanceMode,
  saveAutoReapply,
  savePerformanceMode,
} from '../../utils/performanceMode';
import type {
  TwinCorePerfMode,
  TwinCorePerfReport,
  TwinCoreShizukuAuthStatus,
  TwinCoreShizukuStatus,
} from '../../specs/NativeTwinCorePerf';

type L10n = React.ContextType<typeof L10nContext>;

/** TwinCore 状态彩点规范色：绿=正常生效 / 黄=注意·部分·等待 / 红=不可用·失败。 */
const BRAND_COLORS = {
  ok: '#00E5A0',
  warn: '#F59E0B',
  danger: '#EF4444',
} as const;

/**
 * 应用进度状态机（与原生 applied/failures 列表一一对应）：
 *  - idle        还没点过「应用」
 *  - applied     fullyApplied：全部写入读回校验通过
 *  - partial     applied 非空但 failures 非空：部分生效（MIUI perfd 场景）
 *  - failed      applied 为空：全部写入被拒
 *  - needsAuth   选了档位但 Shizuku 未授权 —— 降级路径：只记住选择，不写内核
 */
type ApplyState =
  | 'idle'
  | 'applied'
  | 'partial'
  | 'failed'
  | 'needsAuth'
  | 'notApplied';

/**
 * TwinCore 的 Shizuku 状态面板 + 三档性能模式（Android only）。
 *
 * 几条硬规则，别改：
 *  1. 挂载与「重新检测」都只做只读探测，绝不自动 apply。
 *     写内核只发生在：用户点「应用」，或用户开了「定期重新应用」开关。
 *  2. Shizuku 未授权/不可用是正常降级状态，不是错误 —— 选择器始终可用，
 *     未授权时切档只更新 UI + AsyncStorage，卡片上显示「未应用（需 Shizuku 授权）」。
 *  3. 调频是系统级的，对整机生效，不是「只对 TwinCore 生效」。本组件只调用
 *     Shizuku 客户端 API，不修改 Shizuku 本身，也不影响其他已授权应用。
 *  4. MIUI/HyperOS perfd 会周期性覆写调频结果，我们不承诺持续生效，
 *     只承诺「尝试应用」—— 不要在文案里写死「永远生效」。
 */
export const PerformanceModeSection: React.FC = () => {
  const l10n = useContext(L10nContext);
  const theme = useTheme();
  const styles = createStyles(theme);

  const supported = isPerformanceModeSupported();

  // ---- Shizuku 状态 ----
  const [shizuku, setShizuku] = useState<TwinCoreShizukuStatus | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const everGrantedRef = useRef(false); // 用于「授权失效」判断

  // ---- 性能模式 ----
  const [mode, setMode] = useState<TwinCorePerfMode>(DEFAULT_PERFORMANCE_MODE);
  const [detected, setDetected] = useState<TwinCorePerfMode | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [busy, setBusy] = useState(false);
  const [failureList, setFailureList] = useState<string[]>([]);
  const [rawErrorList, setRawErrorList] = useState<string[]>([]);
  const [appliedItems, setAppliedItems] = useState<string[]>([]);
  const [topology, setTopology] = useState<string | null>(null);

  // ---- 定期重新应用（对抗 perfd 覆写，尽力而为） ----
  const [autoReapply, setAutoReapply] = useState(false);

  const granted = shizuku?.granted ?? false;
  const binderAlive = shizuku?.binderAlive ?? false;
  const shizukuInstalled = Boolean(
    shizuku?.serviceInstalled || shizuku?.managerInstalled,
  );

  const labelFor = useCallback(
    (m: TwinCorePerfMode): string =>
      m === 'powersave'
        ? l10n.settings.performanceModeOptionPowersave
        : m === 'performance'
          ? l10n.settings.performanceModeOptionPerformance
          : l10n.settings.performanceModeOptionBalanced,
    [l10n],
  );

  const consumeTopology = useCallback(
    (report: TwinCorePerfReport) => {
      if (report.bigClusterCpus?.length) {
        setTopology(
          t(l10n.settings.performanceModeTopology, {
            cpus: formatCpuList(report.bigClusterCpus),
            freq: formatFreqKhz(report.maxFreqKhz),
          }),
        );
      }
    },
    [l10n],
  );

  /** 把一次 apply/restore 的结果写进 UI 状态。quiet=true 用于定期重应用，不打扰用户。 */
  const consumeReport = useCallback(
    (report: TwinCorePerfReport, quiet: boolean) => {
      setAppliedItems(report.applied ?? []);
      setFailureList(report.failures ?? []);
      // 底层错误（stderr / rc / errno）透出：只在有失败时展示，避免刷屏。
      const raws = report.rawErrors ?? [];
      setRawErrorList((report.failures?.length ?? 0) > 0 ? raws : []);
      setDetected(report.mode as TwinCorePerfMode);
      consumeTopology(report);

      const hasFailures = (report.failures?.length ?? 0) > 0;
      const hasApplied = (report.applied?.length ?? 0) > 0;
      setApplyState(
        hasFailures
          ? hasApplied
            ? 'partial'
            : 'failed'
          : hasApplied
            ? 'applied'
            : 'idle',
      );

      if (!quiet) {
        setStatusNote(report.message || null);
      }
    },
    [consumeTopology],
  );

  // ---- 挂载：只读取。恢复上次选择 + 只读检测 Shizuku + 回读 CPU 状态 ----
  useEffect(() => {
    if (!supported) {
      return;
    }
    let canceled = false;
    (async () => {
      const [saved, auto] = await Promise.all([
        loadPerformanceMode(),
        loadAutoReapply(),
      ]);
      if (canceled) {
        return;
      }
      setMode(saved);
      setAutoReapply(auto);

      const status = await readShizukuStatus();
      if (canceled || status.kind !== 'ok') {
        return;
      }
      setShizuku(status.value);
      if (status.value.granted) {
        everGrantedRef.current = true;
      }

      const current = await readPerformanceMode();
      if (canceled || current.kind !== 'ok') {
        return;
      }
      consumeTopology(current.value);
      setDetected(current.value.mode as TwinCorePerfMode);
    })();
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  // ---- 操作区 ----

  /** 请求授权。结果按 status 枚举展示对应文案，不把授权失败当异常。 */
  const handleAuthorize = useCallback(async () => {
    setAuthorizing(true);
    setStatusNote(null);
    try {
      const res = await requestShizukuPermission();
      if (res.kind !== 'ok') {
        setStatusNote(res.reason);
        return;
      }
      setShizuku(res.value);
      if (res.value.granted) {
        everGrantedRef.current = true;
      }
      setStatusNote(
        res.value.message ||
          authStatusText(res.value.status, l10n, everGrantedRef.current),
      );
    } finally {
      setAuthorizing(false);
    }
  }, [l10n]);

  const handleOpenManager = useCallback(async () => {
    const res = await openShizukuManager();
    if (res.kind !== 'ok') {
      setStatusNote(res.reason);
    } else if (!res.value) {
      setStatusNote(l10n.settings.performanceModeManagerMissing);
    }
    // 成功拉起就不打断用户 —— 他正要跳去 Shizuku Manager。
  }, [l10n]);

  /** 重新检测：pingBinder + checkSelfPermission + 顺带回读当前生效档位。 */
  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    setStatusNote(null);
    try {
      const status = await readShizukuStatus();
      if (status.kind === 'ok') {
        setShizuku(status.value);
        if (status.value.granted) {
          everGrantedRef.current = true;
        }
      } else {
        setStatusNote(status.reason);
      }
      const current = await readPerformanceMode();
      if (current.kind === 'ok') {
        consumeTopology(current.value);
        setDetected(current.value.mode as TwinCorePerfMode);
      }
    } finally {
      setRechecking(false);
    }
  }, [consumeTopology]);

  /** 切档：只更新 UI + AsyncStorage。未授权时绝不调原生调频接口。 */
  const handleSelect = useCallback((value: string) => {
    const next = value as TwinCorePerfMode;
    setMode(next);
    setFailureList([]);
    setRawErrorList([]);
    setAppliedItems([]);
    savePerformanceMode(next);
    setApplyState(prev => {
      if (prev === 'applied' || prev === 'partial' || prev === 'failed') {
        // 之前应用过别的档位，现在只是改了选择 —— 标记为「待应用」。
        return 'notApplied';
      }
      return prev;
    });
  }, []);

  const handleApply = useCallback(async () => {
    setBusy(true);
    setStatusNote(null);
    try {
      const res = await applyPerformanceMode(mode);
      if (res.kind !== 'ok') {
        setStatusNote(res.reason);
        setApplyState('failed');
        return;
      }
      consumeReport(res.value, false);
    } finally {
      setBusy(false);
    }
  }, [consumeReport, mode]);

  const handleRestore = useCallback(async () => {
    setBusy(true);
    setStatusNote(null);
    try {
      const res = await restorePerformanceMode();
      if (res.kind !== 'ok') {
        setStatusNote(res.reason);
        return;
      }
      consumeReport(res.value, false);
      setApplyState('idle'); // 恢复完成后回到「未应用」，别沿用 applied 状态
      setMode(DEFAULT_PERFORMANCE_MODE);
      savePerformanceMode(DEFAULT_PERFORMANCE_MODE);
      setAutoReapply(false);
      saveAutoReapply(false);
    } finally {
      setBusy(false);
    }
  }, [consumeReport]);

  const handleToggleAutoReapply = useCallback((value: boolean) => {
    setAutoReapply(value);
    saveAutoReapply(value);
  }, []);

  // ---- 定期重新应用（第 6 步，尽力而为） ----
  // 只在「前台 + 已授权 + 开关打开」时跑；应用后台/被杀自然停止。
  // 小米 perfd 会覆写调频，这里只是周期性重放当前档位命令，不承诺持续生效。
  useEffect(() => {
    if (!supported || !autoReapply || !granted) {
      return;
    }
    const tick = async () => {
      if (AppState.currentState !== 'active') {
        return;
      }
      try {
        const res = await applyPerformanceMode(mode);
        if (res.kind === 'ok') {
          consumeReport(res.value, true); // quiet：静默更新状态行，不打扰
        }
      } catch (e) {
        console.warn('[TwinCore] 定期重新应用失败（忽略，下一轮重试）', e);
      }
    };
    const timer = setInterval(tick, AUTO_REAPPLY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [consumeReport, granted, mode, autoReapply, supported]);

  if (Platform.OS !== 'android') {
    return null;
  }

  // ---- 状态行的文案映射（第 4 步的状态文案要求） ----
  const authLabel = !shizuku
    ? l10n.settings.performanceModeAuthUnknown
    : granted
      ? l10n.settings.performanceModeAuthorizedShort
      : everGrantedRef.current
        ? l10n.settings.performanceModeAuthInvalid
        : l10n.settings.performanceModeNotAuthorizedShort;

  const statusMessage =
    statusNote ??
    (granted
      ? ''
      : binderAlive
        ? l10n.settings.performanceModeNotAuthorized
        : l10n.settings.performanceModeServiceMissing);

  // 授权彩点：已授权=绿；未授权/失效/超时=黄；服务不可用=红。
  const authDotColor = granted
    ? BRAND_COLORS.ok
    : binderAlive
      ? BRAND_COLORS.warn
      : BRAND_COLORS.danger;
  // 生效彩点：全部生效=绿；部分生效/未应用=黄；全被拒=红。
  const applyDotColor =
    applyState === 'applied'
      ? BRAND_COLORS.ok
      : applyState === 'failed'
        ? BRAND_COLORS.danger
        : BRAND_COLORS.warn;

  const applyStateLabel: Record<ApplyState, string> = {
    idle: l10n.settings.performanceModeStateIdle,
    notApplied: l10n.settings.performanceModeStateNotApplied,
    applied: l10n.settings.performanceModeStateApplied,
    partial: l10n.settings.performanceModeStatePartial,
    failed: l10n.settings.performanceModeStateFailed,
    needsAuth: l10n.settings.performanceModeStateNeedsAuth,
  };
  const effectiveApplyState: ApplyState =
    applyState === 'idle' || applyState === 'notApplied'
      ? !granted
        ? 'needsAuth'
        : applyState
      : applyState;

  const showProfileWarning = applyState === 'partial';

  return (
    <LiquidGlass
      variant="surface"
      radius={RADIUS.md}
      style={styles.card}
      testID="performance-mode-card">
      <Card.Title title={l10n.settings.performanceModeTitle} />
      <Card.Content>
        <View style={styles.settingItemContainer}>
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.performanceModeDescription}
          </Text>

          {!supported && (
            <Text
              variant="labelSmall"
              style={[styles.textDescription, styles.errorText]}>
              {l10n.settings.performanceModeNativeMissing}
            </Text>
          )}

          {/* ---------- 状态显示区 ---------- */}
          <StatusRow
            styles={styles}
            dotColor={shizukuInstalled ? BRAND_COLORS.ok : BRAND_COLORS.danger}
            label={l10n.settings.performanceModeInstallStatus}
            value={
              shizukuInstalled
                ? l10n.settings.performanceModeInstalled
                : l10n.settings.performanceModeNotInstalled
            }
          />
          <StatusRow
            styles={styles}
            dotColor={binderAlive ? BRAND_COLORS.ok : BRAND_COLORS.danger}
            label={l10n.settings.performanceModeServiceStatus}
            value={
              binderAlive
                ? l10n.settings.performanceModeRunning
                : l10n.settings.performanceModeNotRunning
            }
          />
          <StatusRow
            styles={styles}
            dotColor={authDotColor}
            label={l10n.settings.performanceModeAuthStatusLabel}
            value={authLabel}
          />
          <StatusRow
            styles={styles}
            dotColor={applyDotColor}
            label={l10n.settings.performanceModeCurrentActive}
            value={
              detected
                ? labelFor(detected)
                : l10n.settings.performanceModeNoProfileApplied
            }
          />

          {topology && (
            <Text variant="labelSmall" style={styles.textDescription}>
              {topology}
            </Text>
          )}

          {statusMessage ? (
            <Text
              variant="labelSmall"
              style={[styles.textDescription, !granted && styles.errorText]}>
              {statusMessage}
            </Text>
          ) : null}

          <Divider style={styles.divider} />

          {/* ---------- 档位选择器：三横向卡片，始终可用（降级路径） ----------
              这里必须用普通 View + Pressable，不能用 Paper 的 <Card onPress>：
              Paper Card 把 onPress 挂在内层 Pressable 上，而外层 Surface 的
              阴影/圆角层会参与命中测试，点在两卡之间或卡片边缘时点击会被外层
              吞掉 —— 这正是用户反馈「要点 2-3 下才切换」的根因（截图 #2）。
              Pressable 直接铺满卡片、无内层包裹，一下即中。 */}
          <View style={styles.modeCards} testID="performance-mode-cards">
            {PERFORMANCE_MODES.map(m => {
              const Icon =
                m === 'powersave'
                  ? BatteryCharging
                  : m === 'balanced'
                    ? Gauge
                    : Zap;
              const selected = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => handleSelect(m)}
                  disabled={!supported}
                  accessibilityRole="radio"
                  accessibilityState={{selected, disabled: !supported}}
                  style={[styles.modeCard, selected && styles.modeCardSelected]}
                  testID={`performance-mode-${m}`}>
                  <Icon
                    size={22}
                    color={selected ? BRAND_COLORS.ok : theme.colors.onSurface}
                    style={styles.modeCardIcon}
                  />
                  <Text
                    style={[
                      styles.modeCardLabel,
                      selected && styles.modeCardLabelSelected,
                    ]}>
                    {labelFor(m)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text variant="labelSmall" style={styles.textDescription}>
            {t(l10n.settings.performanceModeSelectedMode, {
              mode: labelFor(mode),
            })}{' '}
            {applyStateLabel[effectiveApplyState]}
          </Text>

          {showProfileWarning && (
            <Text variant="labelSmall" style={styles.textDescription}>
              {l10n.settings.performanceModePerfdHint}
            </Text>
          )}

          {/* ---------- 操作区 ---------- */}
          <View style={styles.switchContainer}>
            <Button
              mode="outlined"
              compact
              testID="request-shizuku-auth-button"
              disabled={!supported || busy || granted || !binderAlive}
              loading={authorizing}
              onPress={handleAuthorize}>
              {l10n.settings.performanceModeAuthorize}
            </Button>
            <Button
              mode="outlined"
              compact
              testID="open-shizuku-manager-button"
              disabled={!supported || !shizukuInstalled}
              onPress={handleOpenManager}>
              {l10n.settings.performanceModeOpenManager}
            </Button>
          </View>

          <View style={styles.switchContainer}>
            <Button
              mode="contained"
              compact
              testID="apply-performance-mode-button"
              disabled={busy || !supported || !granted}
              loading={busy}
              onPress={handleApply}>
              {l10n.settings.performanceModeApply}
            </Button>
            <Button
              mode="text"
              compact
              testID="restore-performance-mode-button"
              disabled={busy || !supported || !granted}
              onPress={handleRestore}>
              {l10n.settings.performanceModeRestore}
            </Button>
            <Button
              mode="text"
              compact
              testID="recheck-shizuku-button"
              disabled={busy || rechecking}
              loading={rechecking}
              onPress={handleRecheck}>
              {l10n.settings.performanceModeRecheck}
            </Button>
          </View>

          {/* ---------- 定期重新应用（对抗 perfd 覆写，尽力而为） ---------- */}
          <View style={styles.switchContainer}>
            <View style={styles.textContainer}>
              <Text variant="titleMedium" style={styles.textLabel}>
                {l10n.settings.performanceModeAutoReapply}
              </Text>
              <Text variant="labelSmall" style={styles.textDescription}>
                {l10n.settings.performanceModeAutoReapplyDescription}
              </Text>
            </View>
            <Switch
              testID="auto-reapply-switch"
              value={autoReapply}
              disabled={!granted}
              onValueChange={handleToggleAutoReapply}
            />
          </View>

          {/* ---------- 失败明细（逐项，绝不粉饰） ---------- */}
          {failureList.length > 0 && (
            <View style={styles.advancedSettingsContent}>
              {failureList.map((f, i) => (
                <Text
                  key={`${i}-${f}`}
                  variant="labelSmall"
                  style={styles.textDescription}>
                  {`• ${f}`}
                </Text>
              ))}
              {/* 底层原因：stderr / rc / errno，帮用户判断是 SELinux 还是 perfd */}
              {rawErrorList.map((e, i) => (
                <Text
                  key={`raw-${i}-${e}`}
                  variant="labelSmall"
                  style={[styles.textDescription, styles.errorText]}>
                  {`  ↳ ${e}`}
                </Text>
              ))}
            </View>
          )}
          {appliedItems.length > 0 && (
            <Text variant="labelSmall" style={styles.textDescription}>
              {t(l10n.settings.performanceModeAppliedItems, {
                items: appliedItems.join(', '),
              })}
            </Text>
          )}

          <Divider style={styles.divider} />

          {/* ---------- 第 7 步：明确不承诺「只对应用内生效」 ---------- */}
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.performanceModeSystemScope}
          </Text>
        </View>
      </Card.Content>
    </LiquidGlass>
  );
};

/** 「彩点 + 标签：值」的状态行。 */
const StatusRow: React.FC<{
  styles: ReturnType<typeof createStyles>;
  label: string;
  value: string;
  dotColor?: string;
}> = ({styles, label, value, dotColor}) => (
  <View style={styles.switchContainer}>
    <View style={styles.textContainer}>
      <View style={{flexDirection: 'row', alignItems: 'center'}}>
        {dotColor ? (
          <View style={[styles.statusDot, {backgroundColor: dotColor}]} />
        ) : null}
        <Text variant="titleMedium" style={styles.textLabel}>
          {label}
        </Text>
      </View>
    </View>
    <Text variant="bodyMedium" style={styles.textDescription}>
      {value}
    </Text>
  </View>
);

/** 授权流程结束后的兜底文案（原生 message 为空时用）。 */
function authStatusText(
  status: TwinCoreShizukuAuthStatus,
  l10n: L10n,
  everGranted: boolean,
): string {
  switch (status) {
    case 'granted':
      return l10n.settings.performanceModeAuthorized;
    case 'denied':
      return l10n.settings.performanceModeDenied;
    case 'timeout':
      return l10n.settings.performanceModeTimeout;
    case 'rejected_manual':
      return l10n.settings.performanceModeRejectedManual;
    case 'binder_dead':
      return l10n.settings.performanceModeServiceMissing;
    default:
      return everGranted
        ? l10n.settings.performanceModeAuthInvalid
        : l10n.settings.performanceModeNotAuthorizedShort;
  }
}
