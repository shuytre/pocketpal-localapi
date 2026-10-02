import * as React from 'react';
import {Platform, StyleSheet, View} from 'react-native';

import {observer} from 'mobx-react';
import {isHydrated} from 'mobx-persist-store';
import {NavigationContainer} from '@react-navigation/native';
import {Provider as PaperProvider} from 'react-native-paper';
import {BottomSheetModalProvider} from '@gorhom/bottom-sheet';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {KeyboardProvider} from 'react-native-keyboard-controller';
import {
  gestureHandlerRootHOC,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';

import {ttsStore, uiStore} from './src/store';
import {useTheme} from './src/hooks';
import {useDeepLinking} from './src/hooks/useDeepLinking';
import {Theme} from './src/utils/types';

import {l10n, initLocale} from './src/locales';
import {L10nContext} from './src/utils';
import {ROUTES} from './src/utils/navigationConstants';

import {
  ModelsHeaderRight,
  PalHeaderRight,
  AppWithMigration,
  TTSSetupSheet,
  DownloadOverlay,
  HubRunSheetHost,
  LiquidGlassTabBar,
  ErrorBoundary,
} from './src/components';
import {MarkdownProvider} from './src/components/MarkdownView';
import {SplashOverlay} from './src/components/SplashOverlay';
import {AutomationBridge, BenchmarkRunnerScreen} from './src/__automation__';
import {bootstrapPerformanceMode} from './src/services/perfTune/bootstrapPerformanceMode';
import {
  ChatScreen,
  ModelsScreen,
  SettingsScreen,
  BenchmarkScreen,
  AboutScreen,
  LocalApiScreen,
  PerformanceScreen,

  // Dev tools screen. Only available in debug mode.
  DevToolsScreen,
} from './src/screens';
import PalsScreen from './src/screens/PalsScreen';
import {OnboardingStack} from './src/screens/OnboardingScreens';

// Check if app is in debug mode
const isDebugMode = __DEV__;

// Main bottom-tab navigator. The visible bar is a custom floating
// liquid-glass component; secondary routes are registered as siblings and
// filtered out of the bar (see MainTabs).
const Tab = createBottomTabNavigator();

// Component that handles deep linking - must be inside NavigationContainer
const DeepLinkHandler = () => {
  useDeepLinking();
  return null;
};

// Every destination the app can navigate to. The four "primary" ones render a
// button in the floating liquid-glass bar; the rest (Pals / Benchmark /
// App Info / Dev Tools / Benchmark Runner) are registered as siblings that the
// custom bar filters out, so existing `navigate(ROUTES.XXX)` calls by bare
// route name still resolve. This mirrors the previous flat Drawer layout,
// where all routes were siblings in one navigator.
const MainTabs: React.FC = observer(() => {
  const theme = useTheme();
  const currentL10n = l10n[uiStore.language];
  const styles = createStyles(theme);

  // 每个 tab 用带名字的错误边界包住：任何一页渲染炸了，屏幕上会直接写明
  // 是哪一页 + 完整堆栈，而不是一张看不出归属的红屏。
  const screen = (label: string, Comp: React.ComponentType<any>) =>
    gestureHandlerRootHOC(() => (
      <ErrorBoundary label={label}>
        <Comp />
      </ErrorBoundary>
    ));

  return (
    <Tab.Navigator
      tabBar={props => <LiquidGlassTabBar {...props} />}
      screenOptions={{
        headerStyle: styles.headerWithoutDivider,
        headerTintColor: theme.colors.onBackground,
        headerTitleStyle: styles.headerTitle,
        // Scenes stay full-bleed and transparent-backgrounded so the floating
        // glass bar genuinely floats *over* content (that is what sells the
        // material). Each screen is responsible for its own bottom clearance —
        // `sceneStyle.paddingBottom` used to live here, but padding a scene
        // that already sits on `theme.colors.background` just inserted a band
        // of raw background under the bar, which read as "a grey strip with
        // the bar sitting on top of it" rather than glass on glass.
        sceneStyle: {backgroundColor: 'transparent'},
      }}>
      {/* === primary tabs (shown in the glass bar) === */}
      <Tab.Screen
        name={ROUTES.CHAT}
        component={screen('对话', ChatScreen)}
        options={{headerShown: false}}
      />
      <Tab.Screen
        name={ROUTES.MODELS}
        component={screen('模型', ModelsScreen)}
        options={{
          headerRight: () => <ModelsHeaderRight />,
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.models,
        }}
      />
      <Tab.Screen
        name={ROUTES.LOCAL_API}
        component={screen('Agent', LocalApiScreen)}
        options={{
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.localApi,
        }}
      />
      <Tab.Screen
        name={ROUTES.PERFORMANCE}
        component={screen('性能模式', PerformanceScreen)}
        options={{
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.performance,
        }}
      />
      <Tab.Screen
        name={ROUTES.SETTINGS}
        component={screen('设置', SettingsScreen)}
        options={{
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.settings,
        }}
      />

      {/* === secondary destinations (registered, not shown in the bar) === */}
      <Tab.Screen
        name={ROUTES.PALS}
        component={screen('Pals', PalsScreen)}
        options={{
          headerRight: () => <PalHeaderRight />,
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.pals,
        }}
      />
      <Tab.Screen
        name={ROUTES.BENCHMARK}
        component={screen('基准测试', BenchmarkScreen)}
        options={{
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.benchmark,
        }}
      />
      <Tab.Screen
        name={ROUTES.APP_INFO}
        component={screen('关于', AboutScreen)}
        options={{
          headerStyle: styles.headerWithoutDivider,
          title: currentL10n.screenTitles.appInfo,
        }}
      />
      {isDebugMode && (
        <Tab.Screen
          name={ROUTES.DEV_TOOLS}
          component={screen('开发者工具', DevToolsScreen)}
          options={{
            headerStyle: styles.headerWithoutDivider,
            title: 'Dev Tools',
          }}
        />
      )}
      {/*
        E2E-only deep-link-driven benchmark matrix runner. Reachable only by
        the deep link pocketpal://e2e/benchmark in the e2e flavor build (see
        useDeepLinking cold-launch effect and
        android/app/src/e2e/AndroidManifest.xml).
      */}
      {__E2E__ && (
        <Tab.Screen
          name={ROUTES.BENCHMARK_RUNNER}
          component={gestureHandlerRootHOC(BenchmarkRunnerScreen)}
          options={{
            headerStyle: styles.headerWithoutDivider,
            title: 'Benchmark Runner',
          }}
        />
      )}
    </Tab.Navigator>
  );
});

// Branches between the OnboardingStack (first-launch flow) and the main
// root-stack navigator. Both children mount under the same provider tree —
// switching does NOT remount providers above this point.
//
// The hydration check is belt-and-suspenders. AppWithMigrationWrapper
// already gates render on `isHydrated(uiStore)`, but reading the same
// observable here keeps the contract local and survives refactors of the
// outer gate.
type SwitchPointProps = {main: React.ReactNode};
const SwitchPoint: React.FC<SwitchPointProps> = observer(({main}) => {
  if (!isHydrated(uiStore)) {
    return null;
  }
  if (!uiStore.hasCompletedOnboarding) {
    return <OnboardingStack />;
  }
  return <>{main}</>;
});

const App = observer(() => {
  const theme = useTheme();
  const styles = createStyles(theme);
  const currentL10n = l10n[uiStore.language];

  // Initialize locale with the current language
  React.useEffect(() => {
    initLocale(uiStore.language);
  }, []);

  // Initialize TTS store (memory gate + AppState/session listeners).
  // Fire-and-forget: `init()` is idempotent and swallows its own errors.
  React.useEffect(() => {
    ttsStore.init().catch(() => {
      // init() swallows its own errors; catch to satisfy no-floating-promises.
    });
  }, []);

  // 打开 App 自动进入最佳性能模式（识别 → 写配置 → 同步原生 → 原子应用 → 启服务）。
  // 幂等：内部有标记，热重载 / 重复挂载只跑一次。失败只记录不抛出。
  React.useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    void bootstrapPerformanceMode().catch(() => undefined);
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      {__E2E__ ? <AutomationBridge /> : null}
      {/* TwinCore：1.8s 六段品牌启动动画（Android only；E2E 跳过，点击可跳过） */}
      {__E2E__ ? null : <SplashOverlay />}
      <SafeAreaProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
          <PaperProvider theme={theme}>
            <L10nContext.Provider value={currentL10n}>
              <MarkdownProvider>
                <NavigationContainer>
                  <DeepLinkHandler />
                  <BottomSheetModalProvider>
                    <SwitchPoint main={<MainTabs />} />
                    <TTSSetupSheet />
                    <DownloadOverlay />
                    <HubRunSheetHost />
                  </BottomSheetModalProvider>
                </NavigationContainer>
              </MarkdownProvider>
            </L10nContext.Provider>
          </PaperProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    headerWithoutDivider: {
      elevation: 0,
      shadowOpacity: 0,
      borderBottomWidth: 0,
      backgroundColor: theme.colors.background,
    },
    headerWithDivider: {
      backgroundColor: theme.colors.background,
    },
    headerTitle: {
      ...theme.fonts.titleSmall,
    },
  });

// Background-only hold, rendered until mobx-persist-store has loaded
// UIStore from AsyncStorage. It is a single full-screen View whose only
// meaningful property is backgroundColor.
//
// TwinCore: this MUST stay the same dark brand color as the native
// `AppTheme.Starting` splash (android/.../values/styles.xml,
// windowSplashScreenBackground = #0A0E1A). Resolving it from the system
// color scheme used to paint pure white (#ffffff) on a light-mode device,
// producing a white->dark flash between native splash teardown and this
// first RN frame. Pinning it to #0A0E1A removes that flash on every
// color scheme — light, dark, or AMOLED.
const splashStyles = StyleSheet.create({
  hold: {flex: 1, backgroundColor: '#0A0E1A'},
});

const HydrationHold = () => (
  <View testID="hydration-splash" style={splashStyles.hold} />
);

// Wrap the App component with AppWithMigration to show migration UI when
// needed. Gates the first render of any theme-consuming subtree on
// mobx-persist-store hydration so persisted `language` and `colorScheme`
// are observed on first paint.
//
// The gate must wrap App itself (App calls useTheme() BEFORE <PaperProvider>
// mounts), so AppWithMigrationWrapper — which sits above App and has no
// theme dependency — is the chosen host. While unhydrated it renders the
// neutral background-only hold above.
const AppWithMigrationWrapper = observer(() => {
  if (!isHydrated(uiStore)) {
    return <HydrationHold />;
  }
  return (
    <AppWithMigration>
      <App />
    </AppWithMigration>
  );
});

export default AppWithMigrationWrapper;
