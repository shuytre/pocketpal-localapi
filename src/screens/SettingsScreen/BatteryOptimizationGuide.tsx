import React, {useCallback, useContext, useState} from 'react';
import {Linking, Platform, View} from 'react-native';
import {Button, Card, Text} from 'react-native-paper';
import {BatteryFull} from 'lucide-react-native';

import {useTheme} from '../../hooks';
import {L10nContext} from '../../utils';
import {LiquidGlass, RADIUS} from '../../components/LiquidGlass';

import {createStyles} from './styles';

/** 应用包名（applicationId）。 */
const APP_PACKAGE = 'com.twincore';

/**
 * 「无限制省电策略」权限引导。
 *
 * 为什么需要：MIUI / HyperOS 默认会给后台应用套上较激进的省电策略，限制其
 * CPU 配额与后台网络。TwinCore 的推理（长时占用大核）与局域网 API（持续监听
 * socket）都会被这套策略掐掉，表现为「切到后台一会儿就变慢 / 局域网客户端
 * 连不上」。把本应用的省电策略设为「无限制」后这两者才稳定。
 *
 * 实现：优先用 `Linking.openURL('package:<包名>')` 直接跳到本应用的系统
 * 「应用信息」页（MIUI 上该页自带「省电策略」入口）；若该 scheme 不被识别，
 * 退回 `android.settings.APPLICATION_DETAILS_SETTINGS`。不新增任何依赖。
 */
export const BatteryOptimizationGuide: React.FC = () => {
  const l10n = useContext(L10nContext);
  const theme = useTheme();
  const styles = createStyles(theme);

  const [note, setNote] = useState<string | null>(null);

  const openSettings = useCallback(async () => {
    setNote(null);
    const packageUrl = `package:${APP_PACKAGE}`;
    const detailsUrl = `android.settings.APPLICATION_DETAILS_SETTINGS?package=${APP_PACKAGE}`;
    try {
      const can = await Linking.canOpenURL(packageUrl);
      await Linking.openURL(can ? packageUrl : detailsUrl);
    } catch {
      try {
        // MIUI 上 package: scheme 偶发无法解析，兜底走标准应用详情 action。
        await Linking.openURL(detailsUrl);
      } catch {
        setNote(l10n.settings.batteryUnrestrictedOpenFailed);
      }
    }
  }, [l10n]);

  if (Platform.OS !== 'android') {
    return null;
  }

  return (
    <LiquidGlass
      variant="surface"
      radius={RADIUS.md}
      style={styles.card}
      testID="battery-unrestricted-guide-card">
      <Card.Title title={l10n.settings.batteryUnrestrictedTitle} />
      <Card.Content>
        <View style={styles.settingItemContainer}>
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.batteryUnrestrictedDescription}
          </Text>
          <Text variant="labelSmall" style={styles.textDescription}>
            {l10n.settings.batteryUnrestrictedHowTo}
          </Text>

          <View style={styles.switchContainer}>
            <Button
              mode="contained"
              compact
              testID="open-battery-unrestricted-settings"
              icon={({size, color}) => (
                <BatteryFull size={size} color={color} />
              )}
              onPress={() => void openSettings()}>
              {l10n.settings.batteryUnrestrictedOpen}
            </Button>
          </View>

          {note ? (
            <Text
              variant="labelSmall"
              style={[styles.textDescription, styles.errorText]}>
              {note}
            </Text>
          ) : null}
        </View>
      </Card.Content>
    </LiquidGlass>
  );
};
