/**
 * Tests for the design-token typography surface.
 *
 * Locale-aware resolution scenarios:
 *   - Headline renders in Fraunces for Latin locales.
 *   - Headline falls back to Inter for non-Latin locales.
 *   - JetBrains Mono is locale-agnostic (no swap for code blocks).
 */
import type {AvailableLanguage} from '../../../locales';

import {
  FONT_FAMILIES,
  NON_LATIN_LOCALES,
  darkColors,
  lightColors,
  resolveTokens,
  typography,
  typographyForLocale,
} from '../index';

describe('typography tokens', () => {
  describe('absolute line-heights', () => {
    it('headlineH1 has lineHeight resolved to absolute px (36 × 1.4 = 50)', () => {
      expect(typography.headlineH1).toMatchObject({
        fontFamily: FONT_FAMILIES.FRAUNCES_MEDIUM,
        fontSize: 36,
        lineHeight: 50,
        fontWeight: '500',
      });
    });

    it('styledXs has lineHeight === fontSize (100% multiplier resolved)', () => {
      expect(typography.styledXs.lineHeight).toBe(typography.styledXs.fontSize);
      expect(typography.styledXs.fontFamily).toBe(
        FONT_FAMILIES.FRAUNCES_ITALIC,
      );
      expect(typography.styledXs.fontStyle).toBe('italic');
    });

    it('every typography token has a numeric absolute lineHeight', () => {
      for (const key of Object.keys(typography) as Array<
        keyof typeof typography
      >) {
        const style = typography[key];
        expect(typeof style.lineHeight).toBe('number');
        expect(Number.isFinite(style.lineHeight)).toBe(true);
      }
    });
  });

  describe('Latin locales render Fraunces', () => {
    // pt / pt_BR are load-bearing here: Portuguese diacritics are all Latin-1
    // and covered by the bundled Fraunces subset, so these locales must NOT
    // fall back to Inter the way pl does.
    const latinLocales: AvailableLanguage[] = ['en', 'id', 'ms', 'pt', 'pt_BR'];

    it.each(latinLocales)(
      'headlineH1 in %s resolves to Fraunces-Medium at 36 / 50',
      locale => {
        const resolved = typographyForLocale('headlineH1', locale);
        expect(resolved.fontFamily).toBe(FONT_FAMILIES.FRAUNCES_MEDIUM);
        expect(resolved.fontSize).toBe(36);
        expect(resolved.lineHeight).toBe(50);
        expect(resolved.fontWeight).toBe('500');
      },
    );

    it('styledXs in en resolves to Fraunces-Italic', () => {
      const resolved = typographyForLocale('styledXs', 'en');
      expect(resolved.fontFamily).toBe(FONT_FAMILIES.FRAUNCES_ITALIC);
      expect(resolved.fontStyle).toBe('italic');
    });
  });

  describe('non-Latin locales fall back to Inter', () => {
    it.each(NON_LATIN_LOCALES)(
      'headlineH1 in %s falls back to Inter-Medium at 36 / 50',
      locale => {
        const resolved = typographyForLocale('headlineH1', locale);
        expect(resolved.fontFamily).toBe(FONT_FAMILIES.INTER_MEDIUM);
        expect(resolved.fontSize).toBe(36);
        expect(resolved.lineHeight).toBe(50);
        expect(resolved.fontWeight).toBe('500');
      },
    );

    it.each(NON_LATIN_LOCALES)(
      'styledXs in %s falls back to Inter-Medium with synthesised italic',
      locale => {
        const resolved = typographyForLocale('styledXs', locale);
        expect(resolved.fontFamily).toBe(FONT_FAMILIES.INTER_MEDIUM);
        expect(resolved.fontStyle).toBe('italic');
        expect(resolved.fontSize).toBe(typography.styledXs.fontSize);
        expect(resolved.lineHeight).toBe(typography.styledXs.lineHeight);
      },
    );
  });

  describe('JetBrains Mono is locale-agnostic', () => {
    it.each(NON_LATIN_LOCALES)(
      'codeM in %s remains JetBrainsMono-Regular',
      locale => {
        const resolved = typographyForLocale('codeM', locale);
        expect(resolved.fontFamily).toBe(FONT_FAMILIES.JETBRAINS_MONO_REGULAR);
      },
    );

    it('codeS in en is JetBrainsMono-Regular', () => {
      const resolved = typographyForLocale('codeS', 'en');
      expect(resolved.fontFamily).toBe(FONT_FAMILIES.JETBRAINS_MONO_REGULAR);
    });

    it.each(['en', ...NON_LATIN_LOCALES] as AvailableLanguage[])(
      'bodyM (Inter) in %s is unchanged',
      locale => {
        const resolved = typographyForLocale('bodyM', locale);
        expect(resolved.fontFamily).toBe(FONT_FAMILIES.INTER_REGULAR);
      },
    );
  });

  describe('mode resolution', () => {
    // 断言 token 模块自己的常量，而不是把字面值抄一遍 —— 之前这里钉的是
    // #ffffff / #000000，既不是上游值也不是本fork 的值（上游是
    // #F9FAFB / #111827，TwinCore 换成了 #F8FAFC / #0A0E1A），所以它既
    // 锁不住改动方向，也拦不住误改。引用常量后，fork 换色时这条会跟着
    // 指向新的正确值，而 tokens 与实际渲染不一致仍然会失败。
    it('resolveTokens("light") returns lightColors bound', () => {
      const t = resolveTokens('light');
      expect(t.colors.background).toBe(lightColors.background);
      expect(t.colors.background).toBe('#F8FAFC');
    });

    it('resolveTokens("dark") returns darkColors bound', () => {
      const t = resolveTokens('dark');
      expect(t.colors.background).toBe(darkColors.background);
      // TwinCore 品牌深色背景。
      expect(t.colors.background).toBe('#0A0E1A');
    });

    it('typography binding is shared across modes (locale swap is in builder)', () => {
      const l = resolveTokens('light');
      const d = resolveTokens('dark');
      expect(l.typography).toBe(d.typography);
    });
  });
});
