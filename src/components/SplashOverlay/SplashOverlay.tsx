import React, {useEffect, useRef, useState} from 'react';
import {Platform, StyleSheet} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, {G, Path, Rect} from 'react-native-svg';
import LinearGradient from 'react-native-linear-gradient';

/**
 * TwinCore 启动动画（RN 侧六段序列，总时长 1.8s + 0.2s 退场）。
 *
 * 与 Android 12+ 系统原生 SplashScreen（纯 #0A0E1A 底 + 品牌图形）无缝衔接：
 * 原生 splash 退场的瞬间，本覆盖层以同色背景接管并播放：
 *   1. 0-500ms    背景渐变浮现，双核从上/下分开淡入并汇聚
 *   2. 500-900ms  连接元素延伸：轨道环浮现、双路展开、NPU 菱形节点点亮
 *   3. 900-1500ms 整体脉冲 1.0 → 1.05 → 1.0
 *   4. 1500-1800ms TwinCore 文字淡入
 *   5. 1800-2000ms 整层淡出，卸载
 * （1-4 属六段编排，5 是退场尾巴。）
 *
 * 实现：logo 拆成 4 个独立 Animated.View 层（背景 / 双核 / 连接 / 文字），
 * reanimated 只驱动 View 属性，不进 SVG 内部 —— 稳定且 60fps。
 * 点击任意处跳过。仅 Android 启用（iOS 保持系统默认无动画启动）。
 */

const easeOut = Easing.out(Easing.cubic);
const easeInOut = Easing.inOut(Easing.cubic);

// —— logo 几何（512 视窗，与 assets/svg/logo-mark.svg 同源） ——
const MARK_VIEWBOX = 512;
const MARK_SIZE = 200;
const markScale = MARK_SIZE / MARK_VIEWBOX;

const CORE_TOP = 'M204 112 L308 112 A28 28 0 0 1 336 140 L336 192 A28 28 0 0 1 308 220 L204 220 A28 28 0 0 1 176 192 L176 140 A28 28 0 0 1 204 112 Z';
const CORE_BOTTOM = 'M204 292 L308 292 A28 28 0 0 1 336 320 L336 372 A28 28 0 0 1 308 400 L204 400 A28 28 0 0 1 176 372 L176 320 A28 28 0 0 1 204 292 Z';

// wordmark（920×120 视窗，与 assets/svg/logo-wordmark.svg 同源）
const WORD_SIZE = 240;
const WORD_SCALE = WORD_SIZE / 920;

export const SplashOverlay: React.FC<{onDone?: () => void}> = ({onDone}) => {
  const [gone, setGone] = useState(false);
  const finishedRef = useRef(false);

  // —— shared values ——
  const bgOpacity = useSharedValue(0);
  const topCoreOpacity = useSharedValue(0);
  const topCoreOffset = useSharedValue(-36);
  const bottomCoreOpacity = useSharedValue(0);
  const bottomCoreOffset = useSharedValue(36);
  const ringOpacity = useSharedValue(0);
  const lanesOpacity = useSharedValue(0);
  const lanesScale = useSharedValue(0.2);
  const nodeScale = useSharedValue(0);
  const pulseScale = useSharedValue(1);
  const textOpacity = useSharedValue(0);
  const textOffset = useSharedValue(8);
  const overlayOpacity = useSharedValue(1);

  const finish = () => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    setGone(true);
    onDone?.();
  };

  useEffect(() => {
    // —— 段 1：背景 + 双核分开淡入（0-500ms） ——
    bgOpacity.value = withTiming(1, {duration: 400, easing: easeOut});
    topCoreOpacity.value = withDelay(
      60,
      withTiming(1, {duration: 440, easing: easeOut}),
    );
    topCoreOffset.value = withDelay(
      60,
      withTiming(0, {duration: 440, easing: easeOut}),
    );
    bottomCoreOpacity.value = withDelay(
      60,
      withTiming(1, {duration: 440, easing: easeOut}),
    );
    bottomCoreOffset.value = withDelay(
      60,
      withTiming(0, {duration: 440, easing: easeOut}),
    );

    // —— 段 2：连接元素延伸（500-900ms） ——
    ringOpacity.value = withDelay(
      500,
      withTiming(1, {duration: 400, easing: easeOut}),
    );
    lanesOpacity.value = withDelay(
      520,
      withTiming(1, {duration: 380, easing: easeOut}),
    );
    lanesScale.value = withDelay(
      520,
      withTiming(1, {duration: 380, easing: easeOut}),
    );
    nodeScale.value = withDelay(
      640,
      withTiming(1, {duration: 260, easing: Easing.out(Easing.back(1.6))}),
    );

    // —— 段 3-5：脉冲 1.0 → 1.05 → 1.0（900-1500ms） ——
    pulseScale.value = withDelay(
      900,
      withSequence(
        withTiming(1.05, {duration: 300, easing: easeInOut}),
        withTiming(1, {duration: 300, easing: easeInOut}),
      ),
    );

    // —— 段 6：TwinCore 文字淡入（1500-1800ms） ——
    textOpacity.value = withDelay(
      1500,
      withTiming(1, {duration: 300, easing: easeOut}),
    );
    textOffset.value = withDelay(
      1500,
      withTiming(0, {duration: 300, easing: easeOut}),
    );

    // —— 退场：1800ms 后整层淡出 200ms，然后卸载 ——
    overlayOpacity.value = withDelay(
      1800,
      withTiming(0, {duration: 200, easing: Easing.in(Easing.quad)}, isDone =>
        runOnJS(finish)(),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— animated styles ——
  const bgStyle = useAnimatedStyle(() => ({opacity: bgOpacity.value}));
  const topCoreStyle = useAnimatedStyle(() => ({
    opacity: topCoreOpacity.value,
    transform: [{translateY: topCoreOffset.value}],
  }));
  const bottomCoreStyle = useAnimatedStyle(() => ({
    opacity: bottomCoreOpacity.value,
    transform: [{translateY: bottomCoreOffset.value}],
  }));
  const ringStyle = useAnimatedStyle(() => ({opacity: ringOpacity.value}));
  const lanesStyle = useAnimatedStyle(() => ({
    opacity: lanesOpacity.value,
    transform: [{scaleX: lanesScale.value}],
  }));
  const nodeStyle = useAnimatedStyle(() => ({
    transform: [{scale: nodeScale.value}],
  }));
  const logoWrapStyle = useAnimatedStyle(() => ({
    transform: [{scale: pulseScale.value}],
  }));
  const textStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
    transform: [{translateY: textOffset.value}],
  }));
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  if (Platform.OS !== 'android' || gone) {
    return null;
  }

  return (
    <Animated.View style={[styles.overlay, overlayStyle]} testID="splash-overlay">
      <Animated.View style={[StyleSheet.absoluteFill, bgStyle]}>
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={['#0A0E1A', '#101B33', '#0A0E1A']}
          locations={[0, 0.5, 1]}
        />
      </Animated.View>

      <Animated.View style={[styles.logoWrap, logoWrapStyle]}>
        {/* 轨道环 */}
        <Animated.View style={[styles.layer, ringStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path
                d="M 94.9 163 A 186 186 0 0 1 417.1 163"
                stroke="#3B82F6"
                strokeWidth={22}
                fill="none"
                strokeLinecap="round"
              />
              <Path
                d="M 417.1 349 A 186 186 0 0 1 94.9 349"
                stroke="#3B82F6"
                strokeWidth={22}
                fill="none"
                strokeLinecap="round"
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 双路（CPU + NPU 通道） */}
        <Animated.View style={[styles.layer, lanesStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path
                d="M 286 256 H 430"
                stroke="#00E5A0"
                strokeWidth={14}
                strokeLinecap="round"
              />
              <Path
                d="M 226 256 H 82"
                stroke="#00E5A0"
                strokeWidth={14}
                strokeLinecap="round"
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 上核：性能核 */}
        <Animated.View style={[styles.layer, topCoreStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path d={CORE_TOP} fill="#00E5A0" />
              <Rect x={206} y={146} width={100} height={13} rx={6.5} fill="#0A0E1A" opacity={0.5} />
              <Rect x={206} y={172} width={68} height={13} rx={6.5} fill="#0A0E1A" opacity={0.5} />
            </G>
          </Svg>
        </Animated.View>

        {/* 下核：效率核 */}
        <Animated.View style={[styles.layer, bottomCoreStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path d={CORE_BOTTOM} fill="#3B82F6" />
              <Rect x={206} y={326} width={100} height={13} rx={6.5} fill="#0A0E1A" opacity={0.5} />
              <Rect x={206} y={352} width={68} height={13} rx={6.5} fill="#0A0E1A" opacity={0.5} />
            </G>
          </Svg>
        </Animated.View>

        {/* NPU 菱形节点 + 桥 */}
        <Animated.View style={[styles.layer, nodeStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path
                d="M 256 224 V 234 M 256 278 V 288"
                stroke="#F1F5F9"
                strokeWidth={16}
                strokeLinecap="round"
              />
              <Path d="M 256 226 L 286 256 L 256 286 L 226 256 Z" fill="#F1F5F9" />
              <Path d="M 256 243 L 269 256 L 256 269 L 243 256 Z" fill="#0A0E1A" />
            </G>
          </Svg>
        </Animated.View>
      </Animated.View>

      {/* TwinCore 文字 */}
      <Animated.View style={[styles.wordWrap, textStyle]} pointerEvents="none">
        <Svg width={WORD_SIZE} height={WORD_SIZE * (148 / 920)} viewBox="0 -14 920 148">
          <G
            fill="none"
            stroke="#F1F5F9"
            strokeWidth={22}
            strokeLinecap="round"
            strokeLinejoin="round">
            <Path d="M0 0 H90 M45 0 V120" />
            <Path d="M135 0 L154 120 L179 42 L204 120 L223 0" />
            <Path d="M279 0 V120" />
            <Path d="M335 120 V0 L409 120 V0" />
            <Path d="M540 22 A54 54 0 1 0 540 98" />
            <Path d="M584 60 A49 49 0 1 0 584.01 60" />
            <Path d="M727 120 V0 H765 A31 31 0 0 1 765 62 H727 M765 62 L795 120" />
            <Path d="M920 0 H851 V120 H920 M851 60 H902" />
          </G>
        </Svg>
      </Animated.View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A0E1A',
    zIndex: 9999,
    elevation: 9999,
  },
  logoWrap: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default SplashOverlay;
