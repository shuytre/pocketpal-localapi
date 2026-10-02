import React, {useState} from 'react';
import {TouchableOpacity} from 'react-native';
import {Menu} from 'lucide-react-native';

import {styles} from './styles';
import {useTheme} from '../../hooks';
import {SessionDrawer} from '../SessionDrawer';

/**
 * 聊天页头部的会话列表入口。
 *
 * 历史：原实现打开 Drawer 侧边栏。导航改成底部液态玻璃 tab 后 Drawer 被移除，
 * 但会话列表（历史 / 置顶 / 重命名 / 删除 / 导出）是核心功能不能丢，
 * 因此这里改为打开 SessionDrawer —— 一个基于 Modal 的轻量侧滑面板，
 * 内容复用现成的 SidebarContent 组件。
 *
 * 点击即开；面板内的跳转与关闭由 SessionDrawer 自己处理。
 */
export const HeaderLeft: React.FC = () => {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      <TouchableOpacity
        testID="open-session-drawer-button"
        accessibilityLabel="会话列表"
        accessibilityRole="button"
        style={styles.menuIcon}
        onPress={() => setOpen(true)}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Menu size={24} color={theme.colors.onBackground} />
      </TouchableOpacity>
      <SessionDrawer visible={open} onClose={() => setOpen(false)} />
    </>
  );
};
