import {StyleSheet} from 'react-native';

import {Theme} from '../../utils/types';

/** TwinCore 品牌色：青绿主色及其半透明底（清单打勾 / 完成横幅用）。 */
const BRAND_OK = '#00E5A0';
const BRAND_OK_SOFT = 'rgba(0, 229, 160, 0.14)';

export const createStyles = (theme: Theme) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    container: {
      padding: 16,
    },
    scrollViewContent: {
      paddingVertical: 16,
      paddingHorizontal: 16,
    },
    card: {
      marginVertical: 8,
      borderRadius: 12,
      backgroundColor: theme.colors.background,
    },
    settingItemContainer: {
      marginVertical: 16,
    },
    switchContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginVertical: 8,
    },
    textContainer: {
      flex: 1,
      marginRight: 16,
    },
    labelWithIconContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    settingIcon: {
      marginRight: 8,
    },
    textLabel: {
      color: theme.colors.onSurface,
    },
    textDescription: {
      color: theme.colors.onSurfaceVariant,
      //marginTop: 4,
    },
    divider: {
      marginVertical: 12,
    },
    slider: {
      //marginVertical: 8,
      //height: 40,
    },
    textInput: {
      marginVertical: 8,
    },
    invalidInput: {
      borderColor: theme.colors.error,
      borderWidth: 1,
    },
    errorText: {
      color: theme.colors.error,
      marginTop: 4,
    },
    // Cap the value side of a settings row so a long value label ellipsizes
    // inside the button instead of squeezing the flex title/description
    // column into a sliver.
    menuContainer: {
      position: 'relative',
      flexShrink: 1,
      maxWidth: '55%',
    },
    menuButton: {
      minWidth: 100,
      maxWidth: '100%',
    },
    // A control too wide to share its row (e.g. the draft-model picker, whose
    // values are model filenames) sits under the title/description instead.
    // Also keeps the menu anchor at the row's left edge, on-screen.
    fullRowControl: {
      marginTop: 8,
      alignSelf: 'flex-start',
      maxWidth: '100%',
    },
    consentContainer: {
      marginVertical: 8,
    },
    consentButton: {
      alignSelf: 'flex-end',
      marginTop: 12,
    },
    buttonContent: {
      flexDirection: 'row-reverse',
      justifyContent: 'space-between',
    },
    advancedSettingsButton: {
      marginVertical: 8,
    },
    advancedSettingsContent: {
      marginTop: 8,
    },
    advancedAccordion: {
      height: 55,
      //backgroundColor: theme.colors.surface,
    },
    accordionTitle: {
      fontSize: 14,
      color: theme.colors.secondary,
    },
    // Floor, not a fixed width: dropdown items size to their longest label
    // (the outer menu clamps at 90% screen and item titles ellipsize past it).
    menu: {
      minWidth: 170,
    },
    linkContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 4,
    },
    linkIcon: {
      marginLeft: 4,
    },
    segmentedButtons: {
      marginVertical: 8,
    },
    // ---- TwinCore: 性能模式三横向卡片 ----
    //
    // 注意（务必保留这条约束）：卡片渲染宿主是普通 View/Pressable，
    // 而不是 react-native-paper 的 <Card>（后者会渲染成 <Surface container>，
    // 背景取 theme.colors.elevation.levelN —— 本 App 的 buildTheme 没提供
    // elevation 色阶，Surface 背景会是 undefined；再叠 rgba 半透明底会走到
    // 安卓「透明背景 → 阴影转移到子节点」的兼容分支，实测把卡片渲染成被挖空的
    // 白块 / 看不见图标文字，即用户截图 #1）。
    // 因此：卡片底色一律用**不透明实色**，并显式给出文字/图标颜色。
    modeCards: {
      flexDirection: 'row',
      gap: 8,
      marginVertical: 8,
    },
    modeCard: {
      flex: 1,
      minHeight: 76,
      // 让整张卡（撑满 flex 宽度）都是可点区，避免点在两卡之间的间隙上。
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderRadius: 16,
      // 用 2px 边框占位，选中态只换颜色，避免选中/未选中尺寸跳动。
      borderWidth: 2,
      borderColor: 'transparent',
      // 不透明实色：深色主题下比卡片容器（background #0A0E1A）略亮一档，
      // 保证三张卡始终“看得见”，选中态再用 surfaceVariant 拔高一层。
      backgroundColor: theme.colors.surface,
    },
    modeCardSelected: {
      borderColor: theme.colors.secondary,
      backgroundColor: theme.colors.surfaceVariant,
    },
    modeCardIcon: {
      marginBottom: 6,
    },
    modeCardLabel: {
      fontSize: 12,
      lineHeight: 16,
      // 不透明底已保证对比度，用 onSurface 而非 onSurfaceVariant，更清晰。
      color: theme.colors.onSurface,
      textAlign: 'center',
    },
    modeCardLabelSelected: {
      color: theme.dark ? theme.colors.secondary : theme.colors.primary,
      fontWeight: '700',
    },
    // ---- TwinCore: Shizuku 状态彩点（绿/黄/红） ----
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginRight: 6,
    },
    // ---- TwinCore: 性能模式「分步引导清单」 ----
    checklistRow: {
      marginVertical: 8,
    },
    // 整行（勾选框 + 文字）可点：扩大命中区，避免只点中小方块。
    checklistRowInner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    checklistCheck: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: theme.colors.onSurfaceVariant,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
      marginTop: 2,
    },
    checklistCheckDone: {
      borderColor: BRAND_OK,
      backgroundColor: BRAND_OK,
    },
    checklistTextContainer: {
      flex: 1,
      marginRight: 8,
    },
    checklistTitle: {
      marginBottom: 2,
    },
    checklistActionButton: {
      alignSelf: 'flex-start',
      marginTop: 8,
      marginLeft: 36,
    },
    checklistBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 12,
      marginBottom: 8,
      backgroundColor: BRAND_OK_SOFT,
    },
    checklistBannerText: {
      marginLeft: 8,
      color: BRAND_OK,
      fontWeight: '700',
    },
    checklistFooterNote: {
      flex: 1,
      marginLeft: 8,
    },
  });
