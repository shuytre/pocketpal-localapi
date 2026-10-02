/**
 * Liquid glass design tokens (TwinCore brand).
 *
 * A single source of truth for the "frosted glass without a native blur
 * dependency" look used across the app. The illusion is built from layered
 * low-alpha rgba fills (a dark base + a diagonal near-white sheen) plus a thin
 * specular rim — all composited on top of the dark app background
 * (`#0A0E1A`), so every value here assumes that dark backdrop.
 *
 * The four `glass` tiers exist to create *hierarchy*: putting the same
 * treatment on every surface is what causes visual fatigue. Pick the tier that
 * matches the element's role:
 *
 *   surface  - primary cards / sheets that sit inline with content
 *   overlay  - floating modals & popovers that need to read as "above"
 *   subtle   - secondary containers, list rows, grouping backgrounds
 *   accent   - selected/active states, tinted with the brand mint
 */

/** Brand palette. */
export const BRAND = {
  background: '#0A0E1A',
  primary: '#00E5A0',
  inactive: 'rgba(233, 238, 248, 0.55)',
} as const;

/** Corner radii, largest to smallest. */
export const RADIUS = {
  lg: 28,
  md: 20,
  sm: 14,
} as const;

/** Shared spacing scale (4px grid). */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

/** Elevation presets — Android `elevation` + matching iOS shadow. */
export const SHADOW = {
  /** Inline cards: floated just off the background. */
  surface: {
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 12,
  },
  /** Floating overlays / modals: heavier lift. */
  overlay: {
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 10},
    shadowOpacity: 0.4,
    shadowRadius: 22,
    elevation: 20,
  },
  /** Secondary containers: nearly flat. */
  subtle: {
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 5,
  },
} as const;

/**
 * Border / rim highlights. A bright top edge + a dim bottom edge is what makes
 * a flat rectangle read as a lit glass slab.
 */
export const BORDER = {
  borderTop: 'rgba(255, 255, 255, 0.22)',
  borderBottom: 'rgba(255, 255, 255, 0.06)',
} as const;

type GlassTier = {
  /** Base fill of the slab. */
  base: string;
  /** Diagonal sheen, top-left (light) to bottom-right (faded). */
  sheenTop: string;
  sheenBottom: string;
  /** Specular rim along the top edge. */
  specular: string;
  borderTop: string;
  borderBottom: string;
  /** Optional brand-mint tint layered on top (accent only). */
  tint?: string;
  /** Elevation preset key to apply. */
  elevation: keyof typeof SHADOW;
};

/**
 * Glass hierarchy. Each tier is progressively more/less opaque so different
 * surfaces stay visually distinguishable.
 */
export type GlassVariant = 'surface' | 'overlay' | 'subtle' | 'accent';

export const GLASS: Record<GlassVariant, GlassTier> = {
  /** Primary card: the baseline frosted slab. */
  surface: {
    base: 'rgba(18, 24, 40, 0.72)',
    sheenTop: 'rgba(255, 255, 255, 0.12)',
    sheenBottom: 'rgba(255, 255, 255, 0.02)',
    specular: 'rgba(255, 255, 255, 0.22)',
    borderTop: BORDER.borderTop,
    borderBottom: BORDER.borderBottom,
    elevation: 'surface',
  },
  /** Overlay / popover: denser so underlying content does not bleed through. */
  overlay: {
    base: 'rgba(14, 19, 32, 0.86)',
    sheenTop: 'rgba(255, 255, 255, 0.14)',
    sheenBottom: 'rgba(255, 255, 255, 0.03)',
    specular: 'rgba(255, 255, 255, 0.26)',
    borderTop: BORDER.borderTop,
    borderBottom: BORDER.borderBottom,
    elevation: 'overlay',
  },
  /** Secondary container: lighter, blends further into the background. */
  subtle: {
    base: 'rgba(22, 28, 46, 0.55)',
    sheenTop: 'rgba(255, 255, 255, 0.07)',
    sheenBottom: 'rgba(255, 255, 255, 0.01)',
    specular: 'rgba(255, 255, 255, 0.14)',
    borderTop: 'rgba(255, 255, 255, 0.14)',
    borderBottom: 'rgba(255, 255, 255, 0.04)',
    elevation: 'subtle',
  },
  /** Accent / selected: brand-mint tinted slab. */
  accent: {
    base: 'rgba(0, 229, 160, 0.12)',
    sheenTop: 'rgba(255, 255, 255, 0.14)',
    sheenBottom: 'rgba(255, 255, 255, 0.02)',
    specular: 'rgba(0, 229, 160, 0.35)',
    borderTop: 'rgba(0, 229, 160, 0.38)',
    borderBottom: 'rgba(0, 229, 160, 0.10)',
    tint: 'rgba(0, 229, 160, 0.12)',
    elevation: 'surface',
  },
} as const;

/**
 * Aggregate token bag. Exported under a couple of aliases so callers can pick
 * whichever name reads best at the call site.
 */
export const LIQUID_GLASS_TOKENS = {
  brand: BRAND,
  radius: RADIUS,
  spacing: SPACING,
  shadow: SHADOW,
  border: BORDER,
  glass: GLASS,
} as const;

/** Alias for consumers that prefer the shorter name. */
export const GLASS_TOKENS = LIQUID_GLASS_TOKENS;

/** Standalone specular highlight geometry (used by the tab bar's rim). */
export const SPECULAR = {
  color: 'rgba(255, 255, 255, 0.35)',
  height: 1,
} as const;

/** Legacy alias kept for the tab bar's existing opacity-driven glow. */
export const ACTIVE_GLOW = {
  pill: 'rgba(0, 229, 160, 0.16)',
  glow: 'rgba(0, 229, 160, 0.28)',
} as const;
