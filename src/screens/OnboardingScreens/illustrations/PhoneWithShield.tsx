import React from 'react';
import Svg, {G, Path, Rect} from 'react-native-svg';

import {useTheme} from '../../../hooks';

export type PhoneWithShieldProps = {
  /** Outer width in RN points; height scales to keep aspect 85:143. */
  width?: number;
};

// TwinCore brand palette.
const BRAND_MINT = '#00E5A0';
const BRAND_DARK = '#0A0E1A';

/**
 * Screen 4 illustration — phone outline (rounded rect, thick border,
 * speech notch at top) with a Privacy shield glyph centered inside.
 * The shield is now drawn inline in TwinCore brand mint (replacing the
 * imported PocketPal `ShieldGlyph` asset) so this illustration is
 * self-contained and on-brand. Phone outline + notch stay tokenised.
 *
 * Contract preserved: same export name `PhoneWithShield`, same
 * `PhoneWithShieldProps` (`width?`), same 85:143 aspect and shield
 * placement.
 */
export const PhoneWithShield: React.FC<PhoneWithShieldProps> = ({
  width = 170,
}) => {
  const theme = useTheme();
  const viewBoxW = 85;
  const viewBoxH = 143;
  const height = (width * viewBoxH) / viewBoxW;
  const shieldSize = (41 / viewBoxW) * width;
  return (
    <>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}>
        <Rect
          x={3.4}
          y={3.4}
          width={viewBoxW - 6.8}
          height={viewBoxH - 6.8}
          rx={16}
          ry={16}
          fill={theme.colors.background}
          stroke={theme.colors.onBackground}
          strokeWidth={6.83}
        />
        {/* Speech notch — y offset matches the layout where the pill
            sits slightly inset from the phone's top edge. */}
        <Rect
          x={(viewBoxW - 22) / 2}
          y={5}
          width={22}
          height={6}
          rx={3}
          ry={3}
          fill={theme.colors.onBackground}
        />
      </Svg>
      {/* TwinCore brand shield glyph (inline). 41x41 local space,
          mirroring the prior ShieldGlyph footprint + placement. */}
      <Svg
        width={shieldSize}
        height={shieldSize}
        viewBox="0 0 41 41"
        style={{
          position: 'absolute',
          top: (49.8 / viewBoxH) * height,
          left: (width - shieldSize) / 2,
        }}>
        <G>
          {/* Shield shell. */}
          <Path
            d="M20.5 2 L36 8 V20 C36 29.5 29.5 36.5 20.5 39.5 C11.5 36.5 5 29.5 5 20 V8 Z"
            fill={BRAND_MINT}
          />
          {/* Inner dark inlay. */}
          <Path
            d="M20.5 7 L31 11 V20 C31 26.5 26.5 31.5 20.5 34 C14.5 31.5 10 26.5 10 20 V11 Z"
            fill={BRAND_DARK}
            opacity={0.85}
          />
          {/* Twin-core check / node mark inside the shield. */}
          <Path
            d="M20.5 13 V20.5"
            stroke={BRAND_MINT}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <Path
            d="M15.5 20.5 H25.5"
            stroke={BRAND_MINT}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <Path
            d="M20.5 17.5 L23.5 20.5 L20.5 23.5 L17.5 20.5 Z"
            fill="#F1F5F9"
          />
        </G>
      </Svg>
    </>
  );
};
