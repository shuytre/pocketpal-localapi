import React from 'react';
import {ScrollView} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {useTheme} from '../../hooks';
import {createStyles} from '../SettingsScreen/styles';

import {PerformanceModeSection} from '../SettingsScreen/PerformanceModeSection';
import {PerformanceChecklist} from '../SettingsScreen/PerformanceChecklist';
import {SmartModeCard} from '../SettingsScreen/SmartModeCard';
import {BatteryOptimizationGuide} from '../SettingsScreen/BatteryOptimizationGuide';

/**
 * 性能模式（底部导航独立类别）。
 *
 * 为什么单独成页：性能模式不是一条「设置项」，而是一套「先做前置准备 →
 * 再写内核调频」的流程。放在设置列表里会被语言/内存等条目淹没，用户容易
 * 漏掉分步引导里的某一项，然后抱怨「点了应用没效果」。
 *
 * 结构（自上而下，与执行顺序一致）：
 *   1. PerformanceChecklist —— 分步引导清单。7 步全打勾才算真正开启。
 *   2. PerformanceModeSection —— 档位选择 + 应用/恢复。
 *   3. SmartModeCard —— 智能模式（结束后台应用，需要 Shizuku）。
 *   4. BatteryOptimizationGuide —— 「无限制」省电策略必需权限引导。
 *
 * 底部留白：本页由 LiquidGlassTabBar 悬浮在内容之上，所以滚动内容需要自己
 * 让出 tab bar 的高度，否则最后一张卡片会被玻璃盖住。
 */
export const PerformanceScreen: React.FC = () => {
  const theme = useTheme();
  const styles = createStyles(theme);

  // 与 LiquidGlassTabBar 的 LIQUID_TAB_BAR_HEIGHT 对齐。这里直接用足够大的
  // 固定值而不是读 hook：多留一点顶部空白无害，少留则内容被遮。
  const bottomClearance = 96;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollViewContent,
          {paddingBottom: bottomClearance},
        ]}
        testID="performance-screen-scroll"
        keyboardShouldPersistTaps="handled">
        {/* 引导清单放最上面：用户的注意力应该先落在「还差哪几步」。 */}
        <PerformanceChecklist />
        <PerformanceModeSection />
        <SmartModeCard />
        <BatteryOptimizationGuide />
      </ScrollView>
    </SafeAreaView>
  );
};

export default PerformanceScreen;
