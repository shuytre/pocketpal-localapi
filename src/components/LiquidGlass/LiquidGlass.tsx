import React from 'react';
import {StyleProp, StyleSheet, View, ViewStyle} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

import {GLASS, GlassVariant, RADIUS, SHADOW} from './tokens';

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
 * Reusable "liquid glass" surface — cheap variant.
 *
 * ## Why this is deliberately not fancy
 *
 * The first implementation stacked three `LinearGradient`s (base + sheen +
 * tint) plus two absolutely-positioned rim `View`s *per instance*. With
 * 15+ instances on a single screen (settings cards, model cards, chat input)
 * and several of them inside a scrolling `FlatList`, the Redmi K20's Adreno
 * 618 spent its whole frame budget compositing low-alpha layers that are
 * visually almost identical to a single gradient. That is what produced the
 * "everything janks and the open animation tears into layers" report.
 *
 * The current structure is **three nodes total**, and only *one* of them is a
 * gradient (two in the accent tier):
 *
 *   1. Outer  View — radius + shadow
 *   2. Inner  LinearGradient — a single diagonal base + sheen ramp
 *   3. Content View — `children`, styled via `contentStyle`
 *
 * What was dropped and why it costs nothing visually:
 *   - the separate 1px specular rim — the gradient's bright top stop already
 *     reads as the lit edge, and the rim was rendering sub-pixel on most
 *     densities anyway;
 *   - the separate 1px inner border — folded into the gradient ramp;
 *   - the accent tint layer — folded into the accent tier's own stops.
 *
 * Hierarchy between the tiers is preserved: each variant has its own opacity
 * and sheen strength, so cards, overlays and secondary containers still read
 * as different materials instead of one uniform slab.
 */
export const LiquidGlass: React.FC<LiquidGlassProps> = React.memo(
  ({
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
      <View testID={testID} style={[shadow, {borderRadius: radius}, style]}>
        <View
          style={[
            {borderRadius: radius},
            clip ? styles.hidden : null,
            // Border is a real `borderColor` rather than a separate overlay
            // View, so it darkens/lightens with the tier without extra nodes.
            {
              borderWidth: StyleSheet.hairlineWidth,
              borderTopColor: tier.borderTop,
              borderBottomColor: tier.borderBottom,
              borderLeftColor: tier.borderTop,
              borderRightColor: tier.borderBottom,
              overflow: 'hidden',
            },
          ]}>
          {/* Single gradient carrying the whole material: base fill, diagonal
              sheen and (for accent) the brand tint, in one draw call. */}
          <LinearGradient
            colors={
              tier.tint
                ? [tier.tint, tier.base, tier.sheenBottom]
                : [tier.sheenTop, tier.base, tier.sheenBottom]
            }
            locations={tier.tint ? [0, 0.45, 1] : [0, 0.5, 1]}
            start={{x: 0, y: 0}}
            end={{x: 1, y: 1}}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
          <View style={contentStyle}>{children}</View>
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  hidden: {
    overflow: 'hidden',
  },
});

export default LiquidGlass;
