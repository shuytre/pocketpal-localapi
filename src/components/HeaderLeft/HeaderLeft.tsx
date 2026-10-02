import React from 'react';
import {View} from 'react-native';

import {styles} from './styles';

/**
 * 聊天页头部左侧。
 *
 * 现在是**空占位符**：TwinCore 的导航完全由底部液态玻璃 tab bar 承担，
 * 不再有侧边栏（原 Drawer / 会话列表面板已整体移除）。
 *
 * 保留这个组件而不是直接从 ChatHeader 里删掉，是因为头部是左右分栏布局
 * （左侧标题 + 右侧操作），左侧需要一个等宽占位才能让标题保持视觉居中。
 * 宽度沿用原来的 `styles.menuIcon`，与右侧操作区对称。
 */
export const HeaderLeft: React.FC = () => {
  return <View testID="header-left-spacer" style={styles.menuIcon} />;
};
