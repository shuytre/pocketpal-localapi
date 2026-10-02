import React, {useCallback, useContext, useEffect, useState} from 'react';
import {Platform, View} from 'react-native';
import {Card, Divider, Switch, Text} from 'react-native-paper';

import {useTheme} from '../../hooks';
import {L10nContext} from '../../utils';
import {LiquidGlass, RADIUS} from '../../components/LiquidGlass';

import {createStyles} from './styles';
import {
  isPerformanceModeSupported,
  killBackgroundProcesses,
  readShizukuStatus,
} from '../../utils/performanceMode';

/**
 * 需求 7：智能模式（杀非系统后台进程）的独立小卡片。
 *
 * 为什么单独成组件而不是塞进 PerformanceModeSection：后者正被另一条并行任务
 * 修改修 bug，把新 UI 放这里可以完全避免冲突，也方便单独复用。
 *
 * 硬规则：
 *  1. 这是高风险操作 —— 卡片上必须有明确警告（会终止其它后台应用）。
 *  2. Shizuku 未授权时开关不可用，且必须说清「需要授权」，不能假装可用。
 *  3. 调用已 try/catch，失败只显示提示，绝不崩。
 */
export const SmartModeCard: React.FC = () => {
  const l10n = useContext(L10nContext);
  const theme = useTheme();
  const styles = createStyles(theme);

  const supported = isPerformanceModeSupported();
  const [granted, setGranted] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // 挂载时只读检测一次，判断开关是否可用。
  useEffect(() => {
    if (!supported) {
      return;
    }
    let canceled = false;
    (async () => {
      const status = await readShizukuStatus();
      if (!canceled && status.kind === 'ok') {
        setGranted(status.value.granted);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [supported]);

  const handleKill = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await killBackgroundProcesses();
      if (res.kind === 'unsupported') {
        setNote(res.reason);
        setEnabled(false);
        return;
      }
      if (res.kind === 'error') {
        setNote(`失败：${res.reason}`);
        setEnabled(false);
        return;
      }
      const report = res.value;
      setGranted(report.granted);
      setNote(
        report.failures.length > 0
          ? `部分完成（${report.message}）`
          : `已完成：杀掉 ${report.killedCount} 个后台应用`,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const handleToggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      if (next) {
        void handleKill();
      } else {
        // 关掉只是停止「智能模式」的意图，不恢复任何被杀的应用 —— 无法恢复。
        setNote(null);
      }
    },
    [handleKill],
  );

  if (Platform.OS !== 'android') {
    return null;
  }

  return (
    <LiquidGlass
      variant="surface"
      radius={RADIUS.md}
      style={styles.card}
      testID="smart-mode-card">
      <Card.Title title={l10n.settings.smartModeTitle} />
      <Card.Content>
        <View style={styles.switchContainer}>
          <View style={styles.textContainer}>
            <Text variant="titleMedium" style={styles.textLabel}>
              {l10n.settings.smartModeSwitch}
            </Text>
            <Text variant="labelSmall" style={styles.textDescription}>
              {l10n.settings.smartModeDescription}
            </Text>
          </View>
          <Switch
            testID="smart-mode-switch"
            value={enabled}
            disabled={!supported || !granted || busy}
            onValueChange={handleToggle}
          />
        </View>

        {/* 高风险警告：必须显眼。 */}
        <Text
          variant="labelSmall"
          style={[styles.textDescription, styles.errorText]}>
          {l10n.settings.smartModeWarning}
        </Text>

        {!granted && (
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.smartModeNeedsAuth}
          </Text>
        )}

        <Divider style={styles.divider} />

        {busy ? (
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.smartModeKilling}
          </Text>
        ) : null}

        {note ? (
          <Text variant="labelSmall" style={styles.textDescription}>
            {note}
          </Text>
        ) : null}
      </Card.Content>
    </LiquidGlass>
  );
};
