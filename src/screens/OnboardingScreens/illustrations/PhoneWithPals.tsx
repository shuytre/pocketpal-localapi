import React from 'react';
import Svg, {Circle, G, Path, Rect} from 'react-native-svg';

import {useTheme} from '../../../hooks';

export type PhoneWithPalsProps = {
  /** Outer width in RN points; height scales to keep aspect 85:143. */
  width?: number;
};

// TwinCore brand palette for the pal chips.
const BRAND_MINT = '#00E5A0';
const BRAND_MINT_DIM = '#00B283';
const BRAND_CYAN = '#37E6C8';
const BRAND_TEAL = '#0FB89A';
const BRAND_NODE = '#F1F5F9';

type Pal = {
  // Pal body center (in local space, viewBox 85x143).
  cx: number;
  cy: number;
  // Pal body rotation in degrees.
  rot: number;
  // Pal body size (square, in viewBox px).
  size: number;
  // Body fill color.
  fill: string;
};

/**
 * Screen 2 illustration — phone outline (rounded rect, thick border,
 * speech notch at top) with 5 TwinCore "core chip" blobs scattered
 * inside. Replaces the PocketPal warm-palette blob mascots with brand
 * mint/cyan rounded chips, each carrying the tiny twin-lane + node
 * motif. Aspect and layout contract unchanged (85:143).
 *
 * Contract preserved: same export name `PhoneWithPals`, same
 * `PhoneWithPalsProps` (`width?`).
 */
export const PhoneWithPals: React.FC<PhoneWithPalsProps> = ({width = 170}) => {
  const theme = useTheme();
  const viewBoxW = 85;
  const viewBoxH = 143;
  const height = (width * viewBoxH) / viewBoxW;
  // Brand chip palette (mint family, varied for depth).
  const palFills = [
    BRAND_MINT,
    BRAND_TEAL,
    BRAND_CYAN,
    BRAND_MINT_DIM,
    BRAND_MINT,
  ];
  // Geometric centers in viewBox space.
  const pals: Pal[] = [
    {cx: 33, cy: 43, rot: 0, size: 20.7, fill: palFills[0]},
    {cx: 56, cy: 47, rot: 9.8, size: 20.7, fill: palFills[1]},
    {cx: 56, cy: 75, rot: 13.4, size: 20.7, fill: palFills[2]},
    {cx: 23, cy: 65, rot: -23.2, size: 20.7, fill: palFills[3]},
    {cx: 43, cy: 100, rot: -14.4, size: 20.7, fill: palFills[4]},
  ];
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}>
      {/* Phone outline — rounded rect with thick brand border. */}
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
      {/* Speech notch (top center). */}
      <Rect
        x={(viewBoxW - 22) / 2}
        y={5}
        width={22}
        height={6}
        rx={3}
        ry={3}
        fill={theme.colors.onBackground}
      />
      {/* Five brand chips inside the phone. */}
      {pals.map((p, i) => (
        <G key={i} rotation={p.rot} originX={p.cx} originY={p.cy}>
          <Rect
            x={p.cx - p.size / 2}
            y={p.cy - p.size / 2}
            width={p.size}
            height={p.size}
            rx={p.size / 2}
            ry={p.size / 2}
            fill={p.fill}
          />
          {/* Twin-lane glyph inside the chip. */}
          <Path
            d={`M ${p.cx - 5.5} ${p.cy} H ${p.cx + 5.5}`}
            stroke="#0A0E1A"
            strokeOpacity={0.5}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
          {/* Hollow node dot. */}
          <Circle cx={p.cx} cy={p.cy} r={2.6} fill="#0A0E1A" opacity={0.75} />
          <Circle cx={p.cx} cy={p.cy} r={1.1} fill={p.fill} />
          {/* Top accent dash for a chip-like read. */}
          <Path
            d={`M ${p.cx - 4} ${p.cy - 5.5} H ${p.cx + 4}`}
            stroke={BRAND_NODE}
            strokeOpacity={0.55}
            strokeWidth={1.3}
            strokeLinecap="round"
          />
        </G>
      ))}
    </Svg>
  );
};
