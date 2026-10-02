import React from 'react';
import Svg, {Circle, G, Path, Rect} from 'react-native-svg';

export type PipMascotProps = {
  /** Outer width in RN points; height scales to keep aspect 66:62. */
  width?: number;
};

// TwinCore brand palette.
const BRAND_DARK = '#0A0E1A'; // deep brand background
const BRAND_MINT = '#00E5A0'; // primary accent
const BRAND_MINT_DIM = '#00B283'; // secondary / efficiency
const BRAND_NODE = '#F1F5F9'; // node / foreground glyph

/**
 * Screen 6 illustration — TwinCore "twin-core" mascot. Replaces the
 * PocketPal yellow "Pip" mascot with a brand-aligned geometric mark: a
 * 66×62 rounded dark card holding two stacked mint cores (performance +
 * efficiency) bridged by a hollow node — the same double-core motif as
 * the app icon and splash. Colour is fixed brand (not theme-derived) so
 * the mark reads identically in light and dark system schemes.
 *
 * Contract preserved: same export name `PipMascot`, same
 * `PipMascotProps` (`width?`), same 66:62 aspect ratio.
 */
export const PipMascot: React.FC<PipMascotProps> = ({width = 66}) => {
  const viewBoxW = 66;
  const viewBoxH = 62;
  const height = (width * viewBoxH) / viewBoxW;
  // Card fill is fixed brand dark regardless of the system scheme, matching
  // the app icon / splash mark; only the glyph accents vary.
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}>
      {/* Brand card. */}
      <Rect
        x={1.5}
        y={1.5}
        width={viewBoxW - 3}
        height={viewBoxH - 3}
        rx={18}
        ry={18}
        fill={BRAND_DARK}
        stroke={BRAND_MINT}
        strokeWidth={2}
        strokeOpacity={0.55}
      />
      <G>
        {/* Upper performance core. */}
        <Rect
          x={20}
          y={14}
          width={26}
          height={15}
          rx={5}
          ry={5}
          fill={BRAND_MINT}
        />
        <Rect
          x={25}
          y={19.5}
          width={12}
          height={2.6}
          rx={1.3}
          ry={1.3}
          fill={BRAND_DARK}
          opacity={0.55}
        />
        {/* Lower efficiency core. */}
        <Rect
          x={20}
          y={34}
          width={26}
          height={15}
          rx={5}
          ry={5}
          fill={BRAND_MINT_DIM}
        />
        <Rect
          x={25}
          y={39.5}
          width={12}
          height={2.6}
          rx={1.3}
          ry={1.3}
          fill={BRAND_DARK}
          opacity={0.45}
        />
        {/* Bridge + hollow node. */}
        <Path
          d="M 33 29 V 33 M 33 34 V 34"
          stroke={BRAND_NODE}
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        <Path d="M 40 31.5 L 45.5 26 L 51 31.5 L 45.5 37 Z" fill={BRAND_NODE} />
        <Path
          d="M 45.5 29.5 L 48 31.5 L 45.5 33.5 L 43 31.5 Z"
          fill={BRAND_DARK}
        />
        {/* Twin lanes reaching the node. */}
        <Path
          d="M 46 21.5 H 57"
          stroke={BRAND_NODE}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
        <Path
          d="M 46 41.5 H 57"
          stroke={BRAND_NODE}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
        {/* Accent dot, echoes the brand pulse. */}
        <Circle cx={13} cy={31.5} r={2.2} fill={BRAND_MINT} />
      </G>
    </Svg>
  );
};
