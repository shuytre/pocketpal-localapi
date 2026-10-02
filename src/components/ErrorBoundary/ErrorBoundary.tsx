import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';

type Props = {
  children: React.ReactNode;
  /** 用于标注是哪个区域炸了（例如屏幕名）。 */
  label?: string;
};

type State = {
  error: Error | null;
  info: string | null;
};

/**
 * 把渲染期异常转成**可读的屏幕内容**，而不是 RN 默认那张只有堆栈的红屏。
 *
 * 动机同 crashLogger：用户报「除对话页外全部报错」，而红屏截图我看不全。
 * 挂上这个边界后，崩溃页面会直接把 error.message + stack 显示在设备上，
 * 用户截图即可，不用接 adb。
 *
 * 生产环境同样保留：这类自绘错误页比红屏对用户友好，也便于远程排查。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {error: null, info: null};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({info: info?.componentStack ?? null});
    // 同时走全局处理器，落盘到 crash-log.txt。

    console.log('[TwinCore][BOUNDARY]', error?.message, info?.componentStack);
  }

  render() {
    const {error, info} = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <View style={styles.root} testID="error-boundary-fallback">
        <Text style={styles.title}>
          界面渲染失败{this.props.label ? `（${this.props.label}）` : ''}
        </Text>
        <Text style={styles.sub}>请截图这一屏发给开发者</Text>
        <ScrollView style={styles.scroll}>
          <Text style={styles.mono}>{String(error?.name)}</Text>
          <Text style={styles.mono}>{String(error?.message)}</Text>
          <Text style={styles.mono}>{String(error?.stack ?? '')}</Text>
          <Text style={styles.mono}>{String(info ?? '')}</Text>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0E1A',
    padding: 20,
    paddingTop: 60,
  },
  title: {
    color: '#EF4444',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  sub: {
    color: '#8b93a7',
    fontSize: 12,
    marginBottom: 14,
  },
  scroll: {
    flex: 1,
  },
  mono: {
    color: '#F1F5F9',
    fontSize: 10,
    fontFamily: 'Courier',
    marginBottom: 8,
  },
});

export default ErrorBoundary;
