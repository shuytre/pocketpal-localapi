import React from 'react';
import {
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

import {
  GLASS,
  GlassVariant,
  RADIUS,
  SHADOW,
} from './tokens';

export type LiquidGlassVariant = GlassVariant;

export type LiquidGlassProps = {
  /** Glass tier — controls opacity, tint and elevation. Default 'surface'. */
  variant?: LiquidGlassVariant;
  /** Corner radius. Defaults to tokens `radius.md` (20). */
  radius?: number;
  /** Extra style applied to the outer container. */
  style?: StyleProp<ViewStyle>;
  /** Style for the inner (padding) container that wraps `children`. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Override the `overflow: 'hidden'` clip on the container. */
  clip?: boolean;
  children?: React.ReactNode;
  testID?: string;
};

/**
 * Reusable "liquid glass" surface.
 *
 * A frosted-glass slab faked entirely with layered rgba gradients — no native
 * blur dependency. Structure, back to front:
 *
 *   1. Outer View       — radius + elevation + overflow clip
 *   2. Base gradient    — the tier's dark base fill
 *   3. Sheen gradient   — diagonal white highlight (light → transparent)
 *   4. Tint gradient    — brand-mint wash (accent tier only)
 *   5. Specular bar     — 1px bright rim along the top edge
 *   6. Inner border     — dim hairline border deepening the enclosure
 *   7. Content          — `children`, styled via `contentStyle`
 *
 * Pick a `variant` that matches the element's role so surfaces stay
 * visually distinct instead of every panel looking identical.
 */
export const LiquidGlass: React.FC<LiquidGlassProps> = ({
  variant = 'surface',
  radius = RADIUS.md,
  style,
  contentStyle,
  clip = true,
  children,
  testID,
}) => {
  const tier = GLASS[variant];
  const shadow = SHADOW[tier.elevation];

  return (
    <View
      testID={testID}
      style={[
        shadow,
        {borderRadius: radius},
        style,
      ]}>
      <View
        style={[
          styles.clip,
          {borderRadius: radius},
          clip ? styles.hidden : null,
        ]}>
        {/* Base fill. */}
        <LinearGradient
          colors={[tier.base, tier.base]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Diagonal sheen — the "frost". */}
        <LinearGradient
          colors={[tier.sheenTop, tier.sheenBottom]}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Accent tint (accent tier only). */}
        {tier.tint ? (
          <LinearGradient
            colors={[tier.tint, 'rgba(0, 229, 160, 0.02)']}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        ) : null}

        {/* Top specular rim — the bright edge that reads as glass. */}
        <View
          style={[
            styles.specular,
            {
              left: radius / 2,
              right: radius / 2,
              backgroundColor: tier.specular,
            },
          ]}
          pointerEvents="none"
        />

        {/* Dim inner border. */}
        <View
          style={[
            styles.innerBorder,
            {
              borderRadius: radius,
              borderTopColor: tier.borderTop,
              borderBottomColor: tier.borderBottom,
            },
          ]}
          pointerEvents="none"
        />

        <View style={contentStyle}>{children}</View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  clip: {
    // `overflow: hidden` is applied conditionally via `hidden`.
  },
  hidden: {
    overflow: 'hidden',
  },
  specular: {
    position: 'absolute',
    top: 0,
    height: StyleSheet.hairlineWidth * 2,
    borderRadius: 2,
  },
  innerBorder: {
    ...StyleSheet.absoluteFillObject,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255, 255, 255, 0.04)',
    borderRightColor: 'rgba(255, 255, 255, 0.04)',
  },
});

export default LiquidGlass;
