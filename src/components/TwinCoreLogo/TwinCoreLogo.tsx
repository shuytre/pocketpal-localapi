import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

export type TwinCoreLogoProps = {
  /** Square edge length in RN points. The mark is 1:1. */
  size?: number;
};

// TwinCore brand palette (fixed, not theme-derived — the app icon is the same
// dark tile in light and dark system schemes).
const BRAND_DARK = '#0A0E1A'; // deep brand background tile
const BRAND_MINT = '#00E5A0'; // primary accent (performance core)
const BRAND_MINT_DIM = '#00B283'; // secondary accent (efficiency core)
const BRAND_NODE = '#F1F5F9'; // connector / hollow node glyph

const VIEWBOX = 128;

/**
 * TwinCore app-icon mark: a deep (#0A0E1A) rounded-square tile holding the
 * "twin-core" geometric symbol — two stacked mint cores (performance +
 * efficiency) bridged by a hollow white node, with twin lanes reaching out
 * to the sides.
 *
 * Vector replacement for the PocketPal yellow-mascot PNGs. Geometry mirrors
 * src/components/SplashOverlay (`assets/svg/logo-mark.svg`) at a 1:1 aspect,
 * so the empty-state / onboarding marks match the app icon and splash.
 *
 * Colour is fixed brand (never inherited from the Paper theme) so the tile
 * reads identically on every color scheme. Renders as a plain 1:1 square.
 */
export const TwinCoreLogo: React.FC<TwinCoreLogoProps> = ({size = 96}) => {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
      {/* Brand tile. */}
      <Rect
        x={2}
        y={2}
        width={VIEWBOX - 4}
        height={VIEWBOX - 4}
        rx={28}
        ry={28}
        fill={BRAND_DARK}
        stroke={BRAND_MINT}
        strokeWidth={2.5}
        strokeOpacity={0.5}
      />

      {/* Twin lanes (CPU + NPU channels) reaching out from the cores. */}
      <Path
        d="M 74 64 H 104"
        stroke={BRAND_MINT}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <Path
        d="M 54 64 H 24"
        stroke={BRAND_MINT}
        strokeWidth={6}
        strokeLinecap="round"
      />

      {/* Upper core: performance. */}
      <Rect
        x={47}
        y={28}
        width={34}
        height={27}
        rx={10}
        ry={10}
        fill={BRAND_MINT}
      />
      <Rect
        x={54}
        y={38}
        width={20}
        height={3.5}
        rx={1.75}
        ry={1.75}
        fill={BRAND_DARK}
        opacity={0.5}
      />

      {/* Lower core: efficiency. */}
      <Rect
        x={47}
        y={73}
        width={34}
        height={27}
        rx={10}
        ry={10}
        fill={BRAND_MINT_DIM}
      />
      <Rect
        x={54}
        y={83}
        width={14}
        height={3.5}
        rx={1.75}
        ry={1.75}
        fill={BRAND_DARK}
        opacity={0.45}
      />

      {/* Central bridge between the two cores. */}
      <Path
        d="M 64 55 V 60 M 64 68 V 73"
        stroke={BRAND_NODE}
        strokeWidth={4}
        strokeLinecap="round"
      />

      {/* Hollow node diamond — the "twin-core" link. */}
      <Path d="M 64 52 L 76 64 L 64 76 L 52 64 Z" fill={BRAND_NODE} />
      <Path d="M 64 60 L 68 64 L 64 68 L 60 64 Z" fill={BRAND_DARK} />

      {/* Brand pulse dot. */}
      <Circle cx={30} cy={44} r={3.5} fill={BRAND_MINT} />
    </Svg>
  );
};

export default TwinCoreLogo;
