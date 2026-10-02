import {StyleSheet} from 'react-native';

import {Theme} from '../../utils/types';

export const createStyles = (theme: Theme) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    container: {
      padding: 16,
      paddingBottom: 48,
    },
    // 外层分组容器背景改由 <LiquidGlass variant="surface"> 提供，
    // 这里只留间距，避免不透明底覆盖玻璃。
    card: {
      marginVertical: 8,
      backgroundColor: 'transparent',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginVertical: 10,
    },
    rowText: {
      flex: 1,
      marginRight: 12,
    },
    label: {
      color: theme.colors.onSurface,
    },
    description: {
      color: theme.colors.onSurfaceVariant,
      marginTop: 2,
    },
    mono: {
      fontFamily: 'monospace',
      color: theme.colors.onSurface,
    },
    valueText: {
      color: theme.colors.onSurface,
      marginTop: 2,
    },
    input: {
      marginVertical: 6,
      width: 160,
    },
    fullInput: {
      marginVertical: 6,
    },
    chipRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginVertical: 4,
    },
    urlText: {
      flex: 1,
      marginRight: 8,
    },
    urlGroup: {
      marginTop: 6,
    },
    notice: {
      marginVertical: 8,
      color: theme.colors.error,
    },
    statGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 8,
    },
    // subtle 玻璃内嵌容器的内边距，替代原 statGrid 的直接贴边。
    statGlassContent: {
      paddingHorizontal: 12,
      paddingBottom: 6,
    },
    statCell: {
      width: '50%',
      paddingVertical: 6,
    },
    statValue: {
      fontSize: 18,
      color: theme.colors.onSurface,
    },
    statLabel: {
      color: theme.colors.onSurfaceVariant,
    },
    logRow: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    logMeta: {
      color: theme.colors.onSurfaceVariant,
      marginTop: 2,
    },
    errorText: {
      color: theme.colors.error,
    },
    okText: {
      color: theme.colors.primary,
    },
    sectionButton: {
      marginTop: 8,
    },
    threadBox: {
      marginTop: 8,
      maxHeight: 180,
    },
  });
