import React, {useCallback, useContext, useEffect, useState} from 'react';
import {Linking, Platform, Pressable, View} from 'react-native';
import {Button, Card, Divider, Text} from 'react-native-paper';
import {BatteryCharging, Check, Zap} from 'lucide-react-native';
import DeviceInfo from 'react-native-device-info';

import {useTheme} from '../../hooks';
import {L10nContext} from '../../utils';
import {LiquidGlass, RADIUS} from '../../components/LiquidGlass';

import {createStyles} from './styles';
import {
  applyPerformanceMode,
  readPerformanceMode,
  readShizukuStatus,
  requestShizukuPermission,
} from '../../utils/performanceMode';
import type {TwinCoreShizukuStatus} from '../../specs/NativeTwinCorePerf';
import {localApiStore} from '../../store';

/** 品牌色：与 PerformanceModeSection 保持一致。 */
const BRAND_COLORS = {
  ok: '#00E5A0',
  warn: '#F59E0B',
  danger: '#EF4444',
} as const;

/** 应用包名（applicationId）。用于跳转系统「应用信息 / 省电策略」页。 */
const APP_PACKAGE = 'com.twincore';

/** 3 秒自动轮询一次，让「充电中 / 局域网 API」这类外部状态能自动打勾。 */
const POLL_INTERVAL_MS = 3000;

/**
 * 性能模式的「分步引导清单」。
 *
 * 与 PerformanceModeSection 的关系：本组件是**独立的引导层**，不修改也不替代
 * 后者内部逻辑。PerformanceModeSection 负责档位选择/应用/恢复等操作，本清单
 * 负责把「用性能模式前该做的准备」拆成可勾选步骤，自动检测优先。
 *
 * 硬规则：
 *  1. 每步优先自动检测（读真实状态），检测不到才降级为「我已设置」手动勾选。
 *  2. 检测函数全部 try/catch —— 任何一步失败只影响该步，不能把清单带崩。
 *  3. 不自动改写系统设置；只有用户点按钮才触发授权 / 应用调频。
 */
export const PerformanceChecklist: React.FC = () => {
  const l10n = useContext(L10nContext);
  const theme = useTheme();
  const styles = createStyles(theme);

  const supported = Platform.OS === 'android';

  // ---- 自动检测得到的状态 ----
  const [charging, setCharging] = useState(false);
  const [shizuku, setShizuku] = useState<TwinCoreShizukuStatus | null>(null);
  const [perfApplied, setPerfApplied] = useState(false);
  const [apiRunning, setApiRunning] = useState(false);

  // ---- 手动勾选（无 API 的步骤：关闭系统省电模式）----
  const [batteryOptManual, setBatteryOptManual] = useState(false);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // 1. 充电中
    try {
      setCharging(await DeviceInfo.isBatteryCharging());
    } catch {
      setCharging(false);
    }

    // 3/4/5. Shizuku 安装 / 服务 / 授权
    try {
      const status = await readShizukuStatus();
      if (status.kind === 'ok') {
        setShizuku(status.value);
      }
    } catch {
      // ignore —— 保持上一次状态
    }

    // 6. 性能档是否真正写入内核
    try {
      const current = await readPerformanceMode();
      if (current.kind === 'ok') {
        setPerfApplied(
          current.value.mode === 'performance' &&
            (current.value.applied?.length ?? 0) > 0 &&
            (current.value.failures?.length ?? 0) === 0,
        );
      }
    } catch {
      // ignore
    }

    // 7. 局域网 API
    try {
      setApiRunning(
        Boolean(localApiStore.serviceEnabled) && Boolean(localApiStore.running),
      );
    } catch {
      setApiRunning(false);
    }
  }, []);

  // 挂载后立即检测一次，随后轮询（外部状态随时会变）。
  useEffect(() => {
    if (!supported) {
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, supported]);

  // ---- 各步骤的完成判定 ----
  const shizukuInstalled = Boolean(
    shizuku?.serviceInstalled || shizuku?.managerInstalled,
  );
  const binderAlive = shizuku?.binderAlive ?? false;
  const granted = shizuku?.granted ?? false;

  const steps = [
    {id: 'charging', done: charging, manual: false},
    {id: 'batteryOpt', done: batteryOptManual, manual: true},
    {id: 'shizukuInstall', done: shizukuInstalled, manual: false},
    {id: 'shizukuService', done: binderAlive, manual: false},
    {id: 'shizukuGrant', done: granted, manual: false},
    {id: 'perfApplied', done: perfApplied, manual: false},
    {id: 'localApi', done: apiRunning, manual: false},
  ];
  const doneCount = steps.filter(s => s.done).length;
  const allDone = doneCount === steps.length;

  // ---- 动作 ----

  /** 步骤 5：请求 Shizuku 授权。 */
  const handleRequestPermission = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await requestShizukuPermission();
      if (res.kind !== 'ok') {
        setNote(res.reason);
        return;
      }
      setShizuku(res.value);
      if (!res.value.granted) {
        setNote(
          res.value.message || l10n.settings.performanceModeNotAuthorized,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [l10n]);

  /** 步骤 6：切到性能档并写入内核。 */
  const handleApplyPerformance = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await applyPerformanceMode('performance');
      if (res.kind !== 'ok') {
        setNote(res.reason);
        return;
      }
      const report = res.value;
      const ok =
        (report.applied?.length ?? 0) > 0 &&
        (report.failures?.length ?? 0) === 0;
      setPerfApplied(ok);
      if (!ok) {
        setNote(report.message || l10n.settings.performanceModePerfdHint);
      }
    } finally {
      setBusy(false);
    }
  }, [l10n]);

  /** 跳转系统「应用信息」页（含省电策略入口）。 */
  const handleOpenBatterySettings = useCallback(async () => {
    const url = `package:${APP_PACKAGE}`;
    try {
      const can = await Linking.canOpenURL(url);
      await Linking.openURL(
        can
          ? url
          : `android.settings.APPLICATION_DETAILS_SETTINGS?package=${APP_PACKAGE}`,
      );
    } catch {
      try {
        await Linking.openURL(
          `android.settings.APPLICATION_DETAILS_SETTINGS?package=${APP_PACKAGE}`,
        );
      } catch {
        setNote(l10n.settings.performanceChecklistBatteryOpenFailed);
        return;
      }
    }
    // 用户去系统设置里手动改完，回来后自己勾选。
    setBatteryOptManual(true);
  }, [l10n]);

  if (!supported) {
    return null;
  }

  const renderStep = (
    index: number,
    title: string,
    description: string,
    done: boolean,
    options?: {
      action?: {label: string; onPress: () => void; enabled: boolean};
      /** 无系统 API 的步骤（关闭系统省电模式）：允许点整行手动切换勾选。 */
      manualToggle?: () => void;
    },
  ) => {
    const action = options?.action;
    return (
      <View
        key={title}
        style={styles.checklistRow}
        testID={`perf-step-${index}`}>
        <Pressable
          onPress={
            action && action.enabled
              ? action.onPress
              : options?.manualToggle
                ? options.manualToggle
                : undefined
          }
          accessibilityRole={
            action || options?.manualToggle ? 'button' : 'text'
          }
          accessibilityState={{checked: done}}
          style={styles.checklistRowInner}>
          <View
            style={[styles.checklistCheck, done && styles.checklistCheckDone]}>
            {done ? (
              <Check size={16} color={theme.dark ? '#04140E' : '#FFFFFF'} />
            ) : null}
          </View>
          <View style={styles.checklistTextContainer}>
            <Text style={[styles.textLabel, styles.checklistTitle]}>
              {title}
            </Text>
            <Text variant="labelSmall" style={styles.textDescription}>
              {description}
            </Text>
          </View>
        </Pressable>
        {action ? (
          <Button
            mode="outlined"
            compact
            disabled={busy || !action.enabled}
            onPress={action.onPress}
            style={styles.checklistActionButton}>
            {action.label}
          </Button>
        ) : null}
      </View>
    );
  };

  return (
    <LiquidGlass
      variant="surface"
      radius={RADIUS.md}
      style={styles.card}
      testID="performance-checklist-card">
      <Card.Title title={l10n.settings.performanceChecklistTitle} />
      <Card.Content>
        {/* 完成横幅 */}
        {allDone ? (
          <View
            style={styles.checklistBanner}
            testID="performance-activated-banner">
            <Zap size={20} color={BRAND_COLORS.ok} />
            <Text
              variant="titleMedium"
              style={[styles.textLabel, styles.checklistBannerText]}>
              {l10n.settings.performanceChecklistActivated}
            </Text>
          </View>
        ) : (
          <Text variant="labelSmall" style={styles.textDescription}>
            {`${l10n.settings.performanceChecklistProgress} ${doneCount}/${steps.length}`}
          </Text>
        )}

        {renderStep(
          0,
          l10n.settings.performanceChecklistStepCharging,
          l10n.settings.performanceChecklistStepChargingDesc,
          charging,
          {
            action: {
              label: l10n.settings.performanceChecklistActionCharge,
              enabled: true,
              onPress: () =>
                void Linking.openURL(
                  'android.settings.BATTERY_SAVER_SETTINGS',
                ).catch(() => undefined),
            },
          },
        )}
        <Divider style={styles.divider} />

        {renderStep(
          1,
          l10n.settings.performanceChecklistStepBatteryOpt,
          l10n.settings.performanceChecklistStepBatteryOptDesc,
          batteryOptManual,
          {
            action: {
              label: l10n.settings.performanceChecklistActionGoSettings,
              enabled: true,
              onPress: () => void handleOpenBatterySettings(),
            },
            manualToggle: () => setBatteryOptManual(v => !v),
          },
        )}
        <Divider style={styles.divider} />

        {renderStep(
          2,
          l10n.settings.performanceChecklistStepShizukuInstall,
          l10n.settings.performanceChecklistStepShizukuInstallDesc,
          shizukuInstalled,
        )}
        <Divider style={styles.divider} />

        {renderStep(
          3,
          l10n.settings.performanceChecklistStepShizukuService,
          l10n.settings.performanceChecklistStepShizukuServiceDesc,
          binderAlive,
        )}
        <Divider style={styles.divider} />

        {renderStep(
          4,
          l10n.settings.performanceChecklistStepShizukuGrant,
          l10n.settings.performanceChecklistStepShizukuGrantDesc,
          granted,
          {
            action: {
              label: l10n.settings.performanceModeAuthorize,
              enabled: binderAlive && !granted,
              onPress: () => void handleRequestPermission(),
            },
          },
        )}
        <Divider style={styles.divider} />

        {renderStep(
          5,
          l10n.settings.performanceChecklistStepPerfApplied,
          l10n.settings.performanceChecklistStepPerfAppliedDesc,
          perfApplied,
          {
            action: {
              label: l10n.settings.performanceChecklistActionApply,
              enabled: granted && !perfApplied,
              onPress: () => void handleApplyPerformance(),
            },
          },
        )}
        <Divider style={styles.divider} />

        {renderStep(
          6,
          l10n.settings.performanceChecklistStepLocalApi,
          l10n.settings.performanceChecklistStepLocalApiDesc,
          apiRunning,
        )}

        {note ? (
          <Text
            variant="labelSmall"
            style={[styles.textDescription, styles.errorText]}>
            {note}
          </Text>
        ) : null}

        <Divider style={styles.divider} />
        <View style={styles.switchContainer}>
          <BatteryCharging size={18} color={theme.colors.onSurfaceVariant} />
          <Text
            variant="labelSmall"
            style={[styles.textDescription, styles.checklistFooterNote]}>
            {l10n.settings.performanceChecklistAutoDetectNote}
          </Text>
        </View>
      </Card.Content>
    </LiquidGlass>
  );
};
