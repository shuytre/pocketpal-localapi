import React, {useCallback, useEffect, useState} from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';

import {SidebarContent} from '../SidebarContent/SidebarContent';
import {useTheme} from '../../hooks';

const WINDOW_WIDTH = Dimensions.get('window').width;

/**
 * 会话列表侧滑面板（替代被移除的 Drawer 侧边栏）。
 *
 * 背景：导航从 Drawer 改成底部液态玻璃 tab 后，原 Drawer 的会话列表入口
 * （历史会话 / 置顶 / 重命名 / 删除 / 导出）也随之消失 —— 那是核心功能，
 * 必须补回。这里用 RN 原生 Modal + Animated 做一个轻量侧滑抽屉，
 * 内容直接复用现成的 SidebarContent（零重写、零新依赖）。
 *
 * SidebarContent 原本要求 DrawerContentComponentProps（navigation + state）。
 * 这里用 useNavigation() 构造一个最小适配器：
 *   - navigation.navigate(route)  → 关闭面板 + 跳转
 *   - navigation.closeDrawer()    → 关闭面板
 * 其余字段（state 等）SidebarContent 实际未使用，给了也不会读。
 */
interface SessionDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export const SessionDrawer: React.FC<SessionDrawerProps> = ({
  visible,
  onClose,
}) => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

  // 面板宽度：大屏固定 320，小屏占 80%，与旧 Drawer 保持一致。
  const panelWidth = WINDOW_WIDTH > 400 ? 320 : WINDOW_WIDTH * 0.8;

  // Modal 的 visible 与动画解耦：关闭时先播动画再卸载，避免闪。
  const [mounted, setMounted] = useState(visible);
  const translateX = React.useRef(new Animated.Value(-panelWidth)).current;
  const backdrop = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -panelWidth,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 模拟 DrawerContentComponentProps：SidebarContent 只会用到 navigation。
  const drawerProps = {
    navigation: {
      ...navigation,
      closeDrawer: onClose,
      openDrawer: onClose,
      toggleDrawer: onClose,
      // 跳转前先收起面板，避免遮挡新页面。
      navigate: (...args: any[]) => {
        onClose();
        navigation.navigate(...args);
      },
    },
    state: {routes: [], index: 0, key: 'session-drawer', routeNames: []},
    descriptors: {},
  } as any;

  const handleBackdropPress = useCallback(() => onClose(), [onClose]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, {opacity: backdrop}]}>
          <Pressable style={styles.backdropPress} onPress={handleBackdropPress} />
        </Animated.View>
        <Animated.View
          testID="session-drawer-panel"
          style={[
            styles.panel,
            {
              width: panelWidth,
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              backgroundColor: theme.colors.background,
              transform: [{translateX}],
            },
          ]}>
          <SidebarContent {...drawerProps} />
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  backdropPress: {
    flex: 1,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
  },
});
