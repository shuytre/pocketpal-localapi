import React from 'react';
import {Platform, Pressable, StyleSheet, View} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {
  Bot,
  Gauge,
  type LucideIcon,
  MessageCircle,
  Package,
  Settings,
} from 'lucide-react-native';

import {ROUTES} from '../../utils/navigationConstants';
import {ACTIVE_GLOW, BRAND, GLASS, RADIUS} from '../LiquidGlass';

// The bar's glass is the shared `surface` tier from the LiquidGlass tokens, so
// the tab bar and the general-purpose glass component stay in sync. The tab
// bar's own sheen is slightly brighter than the default surface (0.14 vs 0.12)
// to keep its existing look, so we keep a local pair of strings for that.
const BAR_SHEEN = {
  top: 'rgba(255, 255, 255, 0.14)',
  bottom: 'rgba(255, 255, 255, 0.04)',
} as const;

const SURFACE = GLASS.surface;

// Bar geometry. Kept deliberately tight: the bar floats 10pt above the safe
// area, so the *total* bottom space it eats is BAR_HEIGHT + BAR_MARGIN_BOTTOM
// + insets.bottom. On MIUI with gesture nav insets.bottom is ~24, giving a
// true footprint of ~82pt instead of the ~126pt we used to over-reserve.
const BAR_HEIGHT = 58;
const BAR_RADIUS = RADIUS.lg;
const BAR_MARGIN_H = 16;
const BAR_MARGIN_BOTTOM = 10;
const ICON_SIZE = 21;

/**
 * Bottom space the floating bar occupies in RN points, *excluding* the
 * device's own safe-area inset: the bar itself plus its bottom gap.
 *
 * Consumers that must clear the bar (e.g. the chat input, which is absolutely
 * positioned at `bottom: 0`) should pair this with the live `insets.bottom`
 * rather than using the raw constant, so we don't double-count the system
 * navigation bar on devices where `insets.bottom` is already large.
 *
 * Why a constant rather than `useBottomTabBarHeight()`: this bar is drawn via
 * the navigator's `tabBar` prop, so bottom-tabs never measures it and the
 * height context would report the *default* bar height (~49), which would
 * under-reserve and hide content behind the glass.
 */
export const LIQUID_TAB_BAR_HEIGHT = BAR_HEIGHT + BAR_MARGIN_BOTTOM; // = 68

/**
 * Total bottom clearance needed, safe-area aware. Prefer this over the raw
 * constant anywhere a real layout decision is made.
 */
export const useLiquidTabBarSpace = (): number => {
  const insets = useSafeAreaInsets();
  return LIQUID_TAB_BAR_HEIGHT + Math.max(insets.bottom, 0);
};

type TabMeta = {
  label: string;
  icon: LucideIcon;
};

// Route name -> label + icon. Only the five primary routes get a tab; any
// other route registered on the tab navigator is ignored.
const TAB_META: Record<string, TabMeta> = {
  [ROUTES.CHAT]: {label: '对话', icon: MessageCircle},
  [ROUTES.MODELS]: {label: '模型', icon: Package},
  [ROUTES.LOCAL_API]: {label: 'Agent', icon: Bot},
  [ROUTES.PERFORMANCE]: {label: '性能', icon: Gauge},
  [ROUTES.SETTINGS]: {label: '设置', icon: Settings},
};

type TabButtonProps = {
  focused: boolean;
  meta: TabMeta;
  onPress: () => void;
  onLongPress: () => void;
  testID: string;
  accessibilityLabel: string;
};

const TabButton: React.FC<TabButtonProps> = ({
  focused,
  meta,
  onPress,
  onLongPress,
  testID,
  accessibilityLabel,
}) => {
  const progress = useSharedValue(focused ? 1 : 0);

  React.useEffect(() => {
    progress.value = focused
      ? withSpring(1, {damping: 16, stiffness: 220, mass: 0.7})
      : withTiming(0, {duration: 180});
  }, [focused, progress]);

  // Icon: subtle scale pop on selection.
  const iconStyle = useAnimatedStyle(() => ({
    transform: [{scale: 1 + progress.value * 0.12}],
    opacity: 0.72 + progress.value * 0.28,
  }));

  // Label: fades in / out of the active color.
  const labelStyle = useAnimatedStyle(() => ({
    opacity: 0.6 + progress.value * 0.4,
  }));

  // Pill behind the icon that grows with selection.
  const pillStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{scale: 0.7 + progress.value * 0.3}],
  }));

  const Icon = meta.icon;
  const tint = focused ? BRAND.primary : BRAND.inactive;
  return (
    <Pressable
      style={styles.tabButton}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={focused ? {selected: true} : {}}
      accessibilityLabel={accessibilityLabel}>
      <View style={styles.tabInner}>
        <Animated.View
          style={[styles.activePill, pillStyle]}
          pointerEvents="none"
        />
        <Animated.View style={iconStyle}>
          <Icon size={ICON_SIZE} color={tint} strokeWidth={focused ? 2.4 : 2} />
        </Animated.View>
      </View>
      <Animated.Text style={[styles.tabLabel, {color: tint}, labelStyle]}>
        {meta.label}
      </Animated.Text>
    </Pressable>
  );
};

/**
 * Floating "liquid glass" bottom tab bar (Apple-style).
 *
 * Rendered as the `tabBar` of the main BottomTab.Navigator so it replaces the
 * default bar entirely. It floats above the screen with rounded corners and a
 * bottom gap (safe-area aware) instead of being docked to the edge.
 */
export const LiquidGlassTabBar: React.FC<BottomTabBarProps> = ({
  state,
  navigation,
}) => {
  const insets = useSafeAreaInsets();
  const bottomGap = BAR_MARGIN_BOTTOM + Math.max(insets.bottom, 0);

  const tabs = state.routes.filter(route => TAB_META[route.name]);
  if (tabs.length === 0) {
    return null;
  }

  return (
    <View
      style={[styles.container, {bottom: bottomGap}]}
      pointerEvents="box-none">
      <View style={styles.shadow}>
        {/* One gradient carries the whole material (base + diagonal sheen).
            Earlier this was two stacked gradients plus two rim Views; that
            stack re-composited on every tab press and showed up as jank. */}
        <LinearGradient
          colors={[BAR_SHEEN.top, SURFACE.base, BAR_SHEEN.bottom]}
          locations={[0, 0.5, 1]}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={[styles.glassBase, styles.borderOuter]}>
          <View style={styles.tabRow}>
            {tabs.map(route => {
              const focused = state.routes[state.index]?.key === route.key;
              const meta = TAB_META[route.name];
              const label = meta.label;
              return (
                <TabButton
                  key={route.key}
                  focused={focused}
                  meta={meta}
                  testID={`tab-${route.name}`}
                  accessibilityLabel={label}
                  onPress={() => {
                    const event = navigation.emit({
                      type: 'tabPress',
                      target: route.key,
                      canPreventDefault: true,
                    });
                    if (!focused && !event.defaultPrevented) {
                      navigation.navigate(route.name);
                    }
                  }}
                  onLongPress={() => {
                    navigation.emit({
                      type: 'tabLongPress',
                      target: route.key,
                    });
                  }}
                />
              );
            })}
          </View>
        </LinearGradient>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: BAR_MARGIN_H,
    right: BAR_MARGIN_H,
    // `bottom` is set dynamically from safe-area insets.
  },
  shadow: {
    borderRadius: BAR_RADIUS,
    // Shadow to lift the glass off the content behind it. Kept to a single
    // modest elevation: on the Redmi K20's Adreno 618, a large blur radius on
    // a surface that re-composites on every tab press shows up as jank.
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 12,
  },
  glassBase: {
    height: BAR_HEIGHT,
    borderRadius: BAR_RADIUS,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  borderOuter: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: SURFACE.borderTop,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 6,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Platform.OS === 'ios' ? 6 : 4,
  },
  tabInner: {
    width: 40,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activePill: {
    position: 'absolute',
    width: 40,
    height: 30,
    borderRadius: 15,
    backgroundColor: ACTIVE_GLOW.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ACTIVE_GLOW.glow,
  },
  tabLabel: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});

export default LiquidGlassTabBar;
