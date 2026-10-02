import React, {useEffect, useRef, useState} from 'react';
import {Platform, Pressable, StyleSheet} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, {Circle, G, Path, Rect} from 'react-native-svg';
import LinearGradient from 'react-native-linear-gradient';

/**
 * TwinCore 品牌启动动画（RN 侧，总时长 ~1.8s + 0.2s 退场）。
 *
 * 与 Android 12+ 系统原生 SplashScreen（纯 #0A0E1A 底 + 品牌图形）无缝衔接：
 * 原生 splash 退场的瞬间，本覆盖层以同色背景接管并播放：
 *   1. 0-500ms    背景径向渐显；上下双核从 ±40 汇聚到中心并淡入
 *   2. 500-850ms  双路（CPU + NPU 通道）向两侧展开点亮
 *   3. 650-950ms  中心空洞节点回弹点亮（连接双核的桥）
 *   4. 900-1250ms 环状脉冲：logo 缩放 1→1.06→1 + 外环一次呼吸
 *   5. 1250-1700ms TwinCore 文字淡入 + 上移归位
 *   6. 1800-2000ms 整层淡出，卸载
 *
 * 实现：logo 拆成 5 个独立 Animated.View 层（背景 / 双路 / 双核 / 节点 /
 * 文字），reanimated 只驱动 View 的 opacity / transform，不进 SVG 内部 ——
 * 稳定且 60fps。点击任意处跳过（无障碍 label 明确）。仅 Android 启用
 * （iOS 保持系统默认无动画启动）。
 */

const easeOut = Easing.out(Easing.cubic);
const easeInOut = Easing.inOut(Easing.cubic);

// —— logo 几何（512 视窗，与 assets/svg/logo-mark.svg 同源） ——
const MARK_VIEWBOX = 512;
const MARK_SIZE = 200;
const markScale = MARK_SIZE / MARK_VIEWBOX;

const CORE_TOP =
  'M204 112 L308 112 A28 28 0 0 1 336 140 L336 192 A28 28 0 0 1 308 220 L204 220 A28 28 0 0 1 176 192 L176 140 A28 28 0 0 1 204 112 Z';
const CORE_BOTTOM =
  'M204 292 L308 292 A28 28 0 0 1 336 320 L336 372 A28 28 0 0 1 308 400 L204 400 A28 28 0 0 1 176 372 L176 320 A28 28 0 0 1 204 292 Z';

// wordmark（920×148 视窗，与 assets/svg/logo-wordmark.svg 同源）
const WORD_SIZE = 236;
const WORD_H = WORD_SIZE * (148 / 920);

export const SplashOverlay: React.FC<{onDone?: () => void}> = ({onDone}) => {
  const [gone, setGone] = useState(false);
  const finishedRef = useRef(false);

  // —— shared values ——
  const bgOpacity = useSharedValue(0);
  const glowOpacity = useSharedValue(0);
  const topCoreOpacity = useSharedValue(0);
  const topCoreOffset = useSharedValue(-40);
  const bottomCoreOpacity = useSharedValue(0);
  const bottomCoreOffset = useSharedValue(40);
  const lanesOpacity = useSharedValue(0);
  const lanesScale = useSharedValue(0.35);
  const nodeOpacity = useSharedValue(0);
  const nodeScale = useSharedValue(0);
  const haloScale = useSharedValue(0.85);
  const haloOpacity = useSharedValue(0);
  const pulseScale = useSharedValue(1);
  const textOpacity = useSharedValue(0);
  const textOffset = useSharedValue(10);
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
    // —— 段 1：背景 + 双核汇聚（0-500ms） ——
    bgOpacity.value = withTiming(1, {duration: 420, easing: easeOut});
    glowOpacity.value = withDelay(
      120,
      withTiming(0.8, {duration: 600, easing: easeOut}),
    );
    topCoreOpacity.value = withDelay(
      40,
      withTiming(1, {duration: 460, easing: easeOut}),
    );
    topCoreOffset.value = withDelay(
      40,
      withTiming(0, {duration: 460, easing: easeOut}),
    );
    bottomCoreOpacity.value = withDelay(
      40,
      withTiming(1, {duration: 460, easing: easeOut}),
    );
    bottomCoreOffset.value = withDelay(
      40,
      withTiming(0, {duration: 460, easing: easeOut}),
    );

    // —— 段 2：双路向两侧展开（500-850ms） ——
    lanesOpacity.value = withDelay(
      500,
      withTiming(1, {duration: 320, easing: easeOut}),
    );
    lanesScale.value = withDelay(
      500,
      withTiming(1, {duration: 350, easing: Easing.out(Easing.back(1.3))}),
    );

    // —— 段 3：中心节点回弹点亮（650-950ms） ——
    nodeOpacity.value = withDelay(
      650,
      withTiming(1, {duration: 180, easing: easeOut}),
    );
    nodeScale.value = withDelay(
      650,
      withTiming(1, {duration: 300, easing: Easing.out(Easing.back(1.8))}),
    );

    // —— 段 4：环状脉冲 1→1.06→1（900-1250ms） ——
    pulseScale.value = withDelay(
      900,
      withSequence(
        withTiming(1.06, {duration: 170, easing: easeInOut}),
        withTiming(1, {duration: 180, easing: easeInOut}),
      ),
    );
    // 外环一次性呼吸：放大 + 淡出
    haloOpacity.value = withDelay(
      900,
      withSequence(
        withTiming(0.5, {duration: 120, easing: easeOut}),
        withTiming(0, {duration: 230, easing: easeOut}),
      ),
    );
    haloScale.value = withDelay(
      900,
      withTiming(1.35, {duration: 350, easing: easeOut}),
    );

    // —— 段 5：TwinCore 文字淡入（1250-1700ms） ——
    textOpacity.value = withDelay(
      1250,
      withTiming(1, {duration: 400, easing: easeOut}),
    );
    textOffset.value = withDelay(
      1250,
      withTiming(0, {duration: 400, easing: easeOut}),
    );

    // —— 段 6：退场，1800ms 后整层淡出 200ms ——
    overlayOpacity.value = withDelay(
      1800,
      withTiming(0, {duration: 200, easing: Easing.in(Easing.quad)}, () =>
        runOnJS(finish)(),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— animated styles ——
  const bgStyle = useAnimatedStyle(() => ({opacity: bgOpacity.value}));
  const glowStyle = useAnimatedStyle(() => ({opacity: glowOpacity.value}));
  const topCoreStyle = useAnimatedStyle(() => ({
    opacity: topCoreOpacity.value,
    transform: [{translateY: topCoreOffset.value}],
  }));
  const bottomCoreStyle = useAnimatedStyle(() => ({
    opacity: bottomCoreOpacity.value,
    transform: [{translateY: bottomCoreOffset.value}],
  }));
  const lanesStyle = useAnimatedStyle(() => ({
    opacity: lanesOpacity.value,
    transform: [{scaleX: lanesScale.value}],
  }));
  const nodeStyle = useAnimatedStyle(() => ({
    opacity: nodeOpacity.value,
    transform: [{scale: nodeScale.value}],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: haloOpacity.value,
    transform: [{scale: haloScale.value}],
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
    <Animated.View
      style={[styles.overlay, overlayStyle]}
      testID="splash-overlay">
      {/* 点击任意处跳过 */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={finish}
        accessibilityRole="button"
        accessibilityLabel="Skip splash"
        testID="splash-skip"
      />

      {/* 背景：深色底 + 中心青色光晕 */}
      <Animated.View
        style={[StyleSheet.absoluteFill, bgStyle]}
        pointerEvents="none">
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={['#0A0E1A', '#0E1730', '#0A0E1A']}
          locations={[0, 0.5, 1]}
        />
      </Animated.View>
      <Animated.View
        style={[styles.radialGlow, glowStyle]}
        pointerEvents="none">
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={['rgba(0,229,160,0.22)', 'rgba(0,229,160,0.0)']}
        />
      </Animated.View>

      <Animated.View
        style={[styles.logoWrap, logoWrapStyle]}
        pointerEvents="none">
        {/* 环状脉冲光晕 */}
        <Animated.View style={[styles.layer, haloStyle]}>
          <Svg
            width={MARK_SIZE}
            height={MARK_SIZE}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Circle
                cx={256}
                cy={256}
                r={232}
                stroke="#00E5A0"
                strokeWidth={6}
                fill="none"
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 双路（CPU + NPU 通道） */}
        <Animated.View style={[styles.layer, lanesStyle]}>
          <Svg
            width={MARK_SIZE}
            height={MARK_SIZE}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path
                d="M 300 256 H 432"
                stroke="#00E5A0"
                strokeWidth={15}
                strokeLinecap="round"
              />
              <Path
                d="M 212 256 H 80"
                stroke="#00E5A0"
                strokeWidth={15}
                strokeLinecap="round"
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 上核：性能核 */}
        <Animated.View style={[styles.layer, topCoreStyle]}>
          <Svg
            width={MARK_SIZE}
            height={MARK_SIZE}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path d={CORE_TOP} fill="#00E5A0" />
              <Rect
                x={206}
                y={146}
                width={100}
                height={13}
                rx={6.5}
                fill="#0A0E1A"
                opacity={0.5}
              />
              <Rect
                x={206}
                y={172}
                width={68}
                height={13}
                rx={6.5}
                fill="#0A0E1A"
                opacity={0.5}
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 下核：效率核 */}
        <Animated.View style={[styles.layer, bottomCoreStyle]}>
          <Svg
            width={MARK_SIZE}
            height={MARK_SIZE}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path d={CORE_BOTTOM} fill="#00B283" />
              <Rect
                x={206}
                y={326}
                width={100}
                height={13}
                rx={6.5}
                fill="#0A0E1A"
                opacity={0.5}
              />
              <Rect
                x={206}
                y={352}
                width={68}
                height={13}
                rx={6.5}
                fill="#0A0E1A"
                opacity={0.5}
              />
            </G>
          </Svg>
        </Animated.View>

        {/* 中心桥 + 空洞节点 */}
        <Animated.View style={[styles.layer, nodeStyle]}>
          <Svg
            width={MARK_SIZE}
            height={MARK_SIZE}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}>
            <G scale={markScale}>
              <Path
                d="M 256 224 V 236 M 256 276 V 288"
                stroke="#F1F5F9"
                strokeWidth={15}
                strokeLinecap="round"
              />
              <Path
                d="M 256 226 L 286 256 L 256 286 L 226 256 Z"
                fill="#F1F5F9"
              />
              <Path
                d="M 256 243 L 269 256 L 256 269 L 243 256 Z"
                fill="#0A0E1A"
              />
            </G>
          </Svg>
        </Animated.View>
      </Animated.View>

      {/* TwinCore 文字 */}
      <Animated.View style={[styles.wordWrap, textStyle]} pointerEvents="none">
        <Svg width={WORD_SIZE} height={WORD_H} viewBox="0 -14 920 148">
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
  radialGlow: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 460,
    height: 460,
    marginTop: -230,
    marginLeft: -230,
    borderRadius: 230,
    overflow: 'hidden',
  },
  logoWrap: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
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
