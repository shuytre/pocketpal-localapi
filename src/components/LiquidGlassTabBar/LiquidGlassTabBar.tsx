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
  type LucideIcon,
  MessageCircle,
  Package,
  Settings,
} from 'lucide-react-native';

import {ROUTES} from '../../utils/navigationConstants';

// TwinCore brand palette. The glass sits on the dark app background, so the
// tint is a low-alpha near-white over an almost-transparent dark base.
const BRAND = {
  background: '#0A0E1A',
  primary: '#00E5A0',
  inactive: 'rgba(233, 238, 248, 0.55)',
  // Layered rgba highlights/shadows that fake a frosted-glass surface
  // without pulling in a native blur dependency.
  glassTop: 'rgba(255, 255, 255, 0.14)',
  glassBottom: 'rgba(255, 255, 255, 0.04)',
  glassBase: 'rgba(18, 24, 40, 0.72)',
  borderTop: 'rgba(255, 255, 255, 0.22)',
  borderBottom: 'rgba(255, 255, 255, 0.06)',
  activePill: 'rgba(0, 229, 160, 0.16)',
  activeGlow: 'rgba(0, 229, 160, 0.28)',
} as const;

const BAR_HEIGHT = 64;
const BAR_RADIUS = 28;
const BAR_MARGIN_H = 18;
const BAR_MARGIN_BOTTOM = 14;
const ICON_SIZE = 22;

type TabMeta = {
  label: string;
  icon: LucideIcon;
};

// Route name -> label + icon. Only the four primary routes get a tab; any
// other route registered on the tab navigator is ignored.
const TAB_META: Record<string, TabMeta> = {
  [ROUTES.CHAT]: {label: '对话', icon: MessageCircle},
  [ROUTES.MODELS]: {label: '模型', icon: Package},
  [ROUTES.LOCAL_API]: {label: 'Agent', icon: Bot},
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
        <LinearGradient
          colors={[BRAND.glassBase, BRAND.glassBase]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={[styles.glassBase, styles.borderOuter]}>
          {/* Frost layer: diagonal light-to-dark sheen on top of the base. */}
          <LinearGradient
            colors={[BRAND.glassTop, BRAND.glassBottom]}
            start={{x: 0, y: 0}}
            end={{x: 1, y: 1}}
            style={[StyleSheet.absoluteFill, styles.frost]}
            pointerEvents="none"
          />
          {/* Top rim highlight — the thin bright edge that reads as glass. */}
          <View style={styles.specular} pointerEvents="none" />
          {/* Subtle inner border to deepen the enclosure. */}
          <View style={styles.innerBorder} pointerEvents="none" />

          <View style={styles.tabRow}>
            {tabs.map(route => {
              const focused =
                state.routes[state.index]?.key === route.key;
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
    // Elevation/shadow to lift the glass off the content behind it.
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 18,
  },
  glassBase: {
    height: BAR_HEIGHT,
    borderRadius: BAR_RADIUS,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  borderOuter: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BRAND.borderTop,
  },
  frost: {
    borderRadius: BAR_RADIUS,
  },
  specular: {
    position: 'absolute',
    top: 0,
    left: BAR_RADIUS / 2,
    right: BAR_RADIUS / 2,
    height: StyleSheet.hairlineWidth * 2,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  innerBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: BAR_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BRAND.borderBottom,
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
    backgroundColor: BRAND.activePill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BRAND.activeGlow,
  },
  tabLabel: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});

export default LiquidGlassTabBar;
