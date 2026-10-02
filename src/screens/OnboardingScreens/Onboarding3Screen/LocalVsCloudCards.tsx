import React from 'react';
import Svg, {Circle, G, Path, Rect, Text as SvgText} from 'react-native-svg';

export type LocalVsCloudCardsProps = {
  /** Layout width in RN points; height scales to keep aspect 369:217. */
  width?: number;
};

// TwinCore brand palette.
const BRAND_DARK = '#0A0E1A';
const BRAND_MINT = '#00E5A0';
const BRAND_MINT_DIM = '#00B283';
const BRAND_NODE = '#F1F5F9';

const CARD_FILL = '#F1F3F7';
const CARD_STROKE = '#E2E6EE';
const INK = '#0F172A';
const INK_SOFT = '#64748B';
const INK_FAINT = '#94A3B8';

/**
 * Screen 3 "local vs cloud" comparison illustration, redrawn as a live,
 * brand-aligned SVG. Mirrors the composition of the former
 * `screen-3-cards.png` (a dark phone card labelled "TwinCore" overlapping a
 * light cloud card labelled "ChatGPT / Claude") but swaps the embedded
 * PocketPal yellow mascot for the TwinCore twin-core mark, so no PocketPal
 * artwork survives in the first-run flow.
 *
 * Fixed brand colours (not theme-derived) — matches the previous PNG, which
 * was a flat light-scheme asset rendered identically in both schemes.
 */
export const LocalVsCloudCards: React.FC<LocalVsCloudCardsProps> = ({
  width = 369,
}) => {
  const viewBoxW = 369;
  const viewBoxH = 217;
  const height = (width * viewBoxH) / viewBoxW;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}>
      {/* ---------------- Cloud card (ChatGPT / Claude) ---------------- */}
      <G rotation={4} origin="262,118">
        <Rect
          x={206}
          y={10}
          width={150}
          height={190}
          rx={16}
          ry={16}
          fill={CARD_FILL}
          stroke={CARD_STROKE}
          strokeWidth={1.5}
        />
        {/* Cloud glyph. */}
        <G>
          <Circle cx={281} cy={62} r={13} fill="#E8EDF5" />
          <Circle cx={299} cy={57} r={17} fill="#EEF2F8" />
          <Circle cx={317} cy={63} r={12} fill="#E8EDF5" />
          <Rect x={280} y={60} width={38} height={16} rx={8} fill="#EEF2F8" />
          <Path
            d="M281 74 H318"
            stroke="#D5DCE8"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </G>
        <SvgText
          x={281}
          y={124}
          fill={INK}
          fontSize={21}
          fontWeight="700"
          textAnchor="middle">
          ChatGPT / Claude
        </SvgText>
        <SvgText
          x={281}
          y={150}
          fill={INK_SOFT}
          fontSize={13}
          textAnchor="middle">
          Lives in the cloud
        </SvgText>
        <SvgText
          x={281}
          y={172}
          fill={INK_FAINT}
          fontSize={13}
          textAnchor="middle">
          Bigger · Online · Tracked
        </SvgText>
      </G>

      {/* ---------------- Local card (TwinCore) ---------------- */}
      <G rotation={-5} origin="86,108">
        <Rect
          x={12}
          y={16}
          width={148}
          height={184}
          rx={16}
          ry={16}
          fill="#FFFFFF"
          stroke={CARD_STROKE}
          strokeWidth={1.5}
        />
        {/* Device outline holding the TwinCore twin-core mark. */}
        <Rect
          x={64}
          y={38}
          width={44}
          height={70}
          rx={9}
          ry={9}
          fill={BRAND_DARK}
          stroke={INK}
          strokeWidth={3}
        />
        <Rect
          x={82}
          y={43}
          width={8}
          height={2.4}
          rx={1.2}
          fill={BRAND_NODE}
          opacity={0.4}
        />
        {/* Performance core. */}
        <Rect
          x={73}
          y={54}
          width={26}
          height={12}
          rx={4}
          ry={4}
          fill={BRAND_MINT}
        />
        {/* Efficiency core. */}
        <Rect
          x={73}
          y={82}
          width={26}
          height={12}
          rx={4}
          ry={4}
          fill={BRAND_MINT_DIM}
        />
        {/* Bridge + hollow node. */}
        <Path
          d="M 86 68 V 71 M 86 83 V 82"
          stroke={BRAND_NODE}
          strokeWidth={2.4}
          strokeLinecap="round"
        />
        <Path d="M 86 68.5 L 91.5 75 L 86 81.5 L 80.5 75 Z" fill={BRAND_NODE} />
        <Path d="M 86 72.5 L 88.5 75 L 86 77.5 L 83.5 75 Z" fill={BRAND_DARK} />

        <SvgText
          x={86}
          y={140}
          fill={INK}
          fontSize={21}
          fontWeight="700"
          textAnchor="middle">
          TwinCore
        </SvgText>
        <SvgText
          x={86}
          y={163}
          fill={INK_SOFT}
          fontSize={13}
          textAnchor="middle">
          Lives on your phone
        </SvgText>
        <SvgText
          x={86}
          y={185}
          fill={INK_FAINT}
          fontSize={12}
          textAnchor="middle">
          Fast · Offline · Private
        </SvgText>
      </G>

      {/* "vs" separator. */}
      <SvgText
        x={183}
        y={80}
        fill={INK_SOFT}
        fontSize={13}
        fontStyle="italic"
        textAnchor="middle">
        vs
      </SvgText>
    </Svg>
  );
};

export default LocalVsCloudCards;
