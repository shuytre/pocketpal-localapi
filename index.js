/**
 * @format
 */

// Hermes/React Native ship no URL; it must exist before the app graph loads.
import 'react-native-url-polyfill/auto';

import {AppRegistry, LogBox} from 'react-native';

// Silence LogBox in E2E builds so the in-app warning toast doesn't cover
// chat-bottom controls Appium needs. Left active otherwise so warnings
// surface during development.
if (__E2E__) {
  LogBox.ignoreAllLogs(true);
}

import App from './App';
import {name as appName} from './app.json';
import {installCrashLogger} from './src/utils/crashLogger';

// 尽早挂上全局错误处理器：把完整堆栈落盘到 crash-log.txt 并打到 logcat，
// 这样即便只有用户的截图，也能拿到真实错误信息。
installCrashLogger();

AppRegistry.registerComponent(appName, () => App);
