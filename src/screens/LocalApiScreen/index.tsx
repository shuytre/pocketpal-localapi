import React, {useCallback, useContext, useEffect, useState} from 'react';
import {ScrollView, View, Platform} from 'react-native';
import {useNavigation} from '@react-navigation/native';

import {observer} from 'mobx-react-lite';
import {SafeAreaView} from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import {Button, Card, Divider, Switch, Text} from 'react-native-paper';

import {L10nContext} from '../../utils';
import {useTheme} from '../../hooks';
import {localApiStore} from '../../store/LocalApiStore';
import {modelStore} from '../../store/ModelStore';
import {TextInput} from '../../components';
import {localApiSupported} from '../../services/localApi/localApiBridge';
import {applyRecommendedToStore} from '../../services/perfTune/bootstrapPerformanceMode';
import {
  detectDeviceProfile,
  recommendParams,
} from '../../services/perfTune/deviceProfile';
import {t} from '../../locales';

import {createStyles} from './styles';

const POLL_INTERVAL_MS = 4000;

/** MB 显示：报告里的数字（mlock 锁定字节数等）需要人能读的量级。 */
const formatMb = (bytes?: number): string => {
  if (!bytes) {
    return '-';
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

const formatTime = (timestamp?: number): string =>
  timestamp ? new Date(timestamp).toLocaleTimeString() : '-';

/**
 * 局域网 API 服务：设置 + 调优报告 + 调用管理界面。
 *
 * 这里的每个开关背后都有对应的回读值显示在「调优报告」里 —— 面板的职责不是
 * 让用户相信开关生效了，而是让用户可以核对它是否真的生效。
 */
export const LocalApiScreen: React.FC = observer(() => {
  const navigation = useNavigation<any>();
  const l10n = useContext(L10nContext);
  const theme = useTheme();
  const styles = createStyles(theme);

  const [portDraft, setPortDraft] = useState(String(localApiStore.port));
  const [apiKeyDraft, setApiKeyDraft] = useState(localApiStore.apiKey);
  const [maxTokensDraft, setMaxTokensDraft] = useState(
    String(localApiStore.defaultMaxTokens),
  );
  const [temperatureDraft, setTemperatureDraft] = useState(
    String(localApiStore.defaultTemperature),
  );
  const [forceCoreDraft, setForceCoreDraft] = useState(
    String(localApiStore.forceCoreCount),
  );
  const [backgroundNiceDraft, setBackgroundNiceDraft] = useState(
    String(localApiStore.backgroundNice),
  );
  const [rebindDraft, setRebindDraft] = useState(
    String(localApiStore.rebindIntervalMs),
  );
  const [socketTimeoutDraft, setSocketTimeoutDraft] = useState(
    String(localApiStore.socketReadTimeoutMs),
  );
  const [maxWaitingDraft, setMaxWaitingDraft] = useState(
    String(localApiStore.maxWaiting),
  );
  const [showThreads, setShowThreads] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const [showPerformance, setShowPerformance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setPortDraft(String(localApiStore.port));
    setApiKeyDraft(localApiStore.apiKey);
    setMaxTokensDraft(String(localApiStore.defaultMaxTokens));
    setTemperatureDraft(String(localApiStore.defaultTemperature));
    setForceCoreDraft(String(localApiStore.forceCoreCount));
    setBackgroundNiceDraft(String(localApiStore.backgroundNice));
    setRebindDraft(String(localApiStore.rebindIntervalMs));
    setSocketTimeoutDraft(String(localApiStore.socketReadTimeoutMs));
    setMaxWaitingDraft(String(localApiStore.maxWaiting));

    navigation.setOptions({title: l10n.screenTitles.localApi});
    void localApiStore.refresh();
    void localApiStore.refreshTuningReport();
  }, [navigation, l10n.screenTitles.localApi]);

  // 轮询状态：端口 / 连接数 / 等待数必须实时 —— 排查「为什么一直 503」时，
  // 这几个数字比任何日志都直接。
  useEffect(() => {
    if (!localApiStore.serviceEnabled) {
      return;
    }
    const timer = setInterval(() => {
      void localApiStore.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [localApiStore.serviceEnabled]);

  const commitNumber = useCallback(
    (raw: string, fallback: number, apply: (value: number) => void) => {
      const parsed = Number.parseInt(raw, 10);
      apply(Number.isFinite(parsed) ? parsed : fallback);
    },
    [],
  );

  const onToggleService = async (value: boolean) => {
    setBusy(true);
    localApiStore.setServiceEnabled(value);
    if (value) {
      await localApiStore.startService();
    } else {
      await localApiStore.stopService();
    }
    await localApiStore.refresh();
    setBusy(false);
  };

  const onApplyPort = () => {
    commitNumber(portDraft, localApiStore.port, value => {
      localApiStore.port = Math.min(Math.max(value, 1024), 65535);
      setPortDraft(String(localApiStore.port));
    });
    void localApiStore.applyRuntimeConfig();
  };

  const onApplyApiKey = () => {
    localApiStore.apiKey = apiKeyDraft.trim();
    void localApiStore.applyRuntimeConfig();
  };

  const onCopy = async (value: string, key: string) => {
    try {
      await Clipboard.setString(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用时保持静默：Base URL 仍然可读、可手抄。
    }
  };

  const onReapplyRecommended = async () => {
    setBusy(true);
    try {
      const profile = await detectDeviceProfile();
      const recommended = recommendParams(profile);
      await applyRecommendedToStore(recommended);
    } catch {
      // 旁路增强失败只记录：UI 保持可用。
    } finally {
      setBusy(false);
    }
  };

  if (!localApiSupported) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <View style={styles.container}>
          <Text variant="bodyMedium">
            局域网 API 服务当前仅支持 Android 构建（本机代为 iOS）。
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const status = localApiStore.status;
  const modelReady = Boolean(modelStore.context);
  const displayStatus = !localApiStore.running
    ? l10n.localApi.statusStopped
    : modelReady
      ? l10n.localApi.statusRunning
      : l10n.localApi.statusWaitingModel;

  const report = localApiStore.tuningReport;
  const stats = localApiStore.callStats;
  const baseUrls = localApiStore.baseUrls;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* ① 服务 */}
        <Card elevation={0} style={styles.card}>
          <Card.Title title={l10n.localApi.serviceSection} />
          <Card.Content>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="titleMedium" style={styles.label}>
                  {l10n.localApi.serviceSwitch}
                </Text>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.serviceSwitchDescription}
                </Text>
              </View>
              <Switch
                testID="local-api-service-switch"
                value={localApiStore.serviceEnabled}
                disabled={busy}
                onValueChange={value => {
                  void onToggleService(value);
                }}
              />
            </View>

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.statusLabel}
                </Text>
                <Text
                  variant="bodyMedium"
                  style={[
                    styles.valueText,
                    localApiStore.running && modelReady
                      ? styles.okText
                      : undefined,
                  ]}>
                  {displayStatus}
                </Text>
              </View>
              <Button compact onPress={() => void localApiStore.refresh()}>
                {l10n.localApi.refresh}
              </Button>
            </View>

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.modelLabel}
                </Text>
                <Text
                  variant="bodyMedium"
                  style={[styles.valueText, modelReady ? undefined : styles.errorText]}>
                  {modelStore.activeModel?.name ?? l10n.localApi.unknown} ·{' '}
                  {modelReady ? l10n.localApi.modelReady : l10n.localApi.modelNotReady}
                </Text>
              </View>
            </View>

            <Divider />

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="titleMedium" style={styles.label}>
                  {l10n.localApi.baseUrl}
                </Text>
                {baseUrls.length === 0 ? (
                  <Text variant="labelSmall" style={styles.description}>
                    {l10n.localApi.baseUrlEmpty}
                  </Text>
                ) : (
                  baseUrls.map(url => (
                    <View key={url} style={styles.chipRow}>
                      <Text style={[styles.mono, styles.urlText]} selectable>
                        {url}
                      </Text>
                      <Button
                        compact
                        onPress={() => void onCopy(url, url)}
                        testID={`copy-base-url-${url}`}>
                        {copied === url ? l10n.localApi.copied : l10n.localApi.copy}
                      </Button>
                    </View>
                  ))
                )}
              </View>
            </View>

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.port}
                </Text>
                <TextInput
                  testID="local-api-port-input"
                  style={styles.input}
                  keyboardType="numeric"
                  value={portDraft}
                  onChangeText={setPortDraft}
                  onEndEditing={onApplyPort}
                  helperText={l10n.localApi.portHelper}
                />
              </View>
            </View>

            <Divider />

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="titleMedium" style={styles.label}>
                  {l10n.localApi.apiKey}
                </Text>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.apiKeyDescription}
                </Text>
                <TextInput
                  testID="local-api-key-input"
                  style={styles.fullInput}
                  value={apiKeyDraft}
                  onChangeText={setApiKeyDraft}
                  onEndEditing={onApplyApiKey}
                  secureTextEntry={false}
                  autoCapitalize="none"
                />
              </View>
              <Switch
                testID="local-api-require-key-switch"
                value={localApiStore.requireApiKey}
                onValueChange={value => {
                  localApiStore.requireApiKey = value;
                  void localApiStore.applyRuntimeConfig();
                }}
              />
            </View>
            <Text variant="labelSmall" style={styles.description}>
              {l10n.localApi.requireApiKey}
            </Text>

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.allowCors}
                </Text>
              </View>
              <Switch
                testID="local-api-cors-switch"
                value={localApiStore.allowCors}
                onValueChange={value => {
                  localApiStore.allowCors = value;
                  void localApiStore.applyRuntimeConfig();
                }}
              />
            </View>

            <Text variant="labelSmall" style={styles.notice}>
              {l10n.localApi.safetyNotice}
            </Text>
          </Card.Content>
        </Card>

        {/* ② 提升模型能力 */}
        <Card elevation={0} style={styles.card}>
          <Card.Title
            title={l10n.localApi.performanceSection}
            right={() => (
              <Button
                compact
                onPress={() => setShowPerformance(prev => !prev)}
                testID="local-api-performance-toggle">
                {showPerformance ? '收起' : '展开'}
              </Button>
            )}
          />
          <Card.Content>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="labelSmall" style={styles.description}>
                  {l10n.localApi.profile}
                </Text>
                <Text variant="bodyMedium" style={styles.valueText}>
                  {localApiStore.profileLabel}
                </Text>
                <Text variant="labelSmall" style={styles.description}>
                  {t(l10n.localApi.profileConfidence, {
                    level: localApiStore.profileConfidence,
                  })}
                </Text>
              </View>
              <Button
                compact
                disabled={busy}
                onPress={() => void onReapplyRecommended()}
                testID="local-api-apply-recommended">
                {l10n.localApi.applyRecommended}
              </Button>
            </View>

            {localApiStore.profileReasons.length > 0 && (
              <View>
                <Button
                  compact
                  onPress={() => setShowReasons(prev => !prev)}
                  testID="local-api-toggle-reasons">
                  {l10n.localApi.recommendedReasons}
                </Button>
                {showReasons &&
                  localApiStore.profileReasons.map(reason => (
                    <Text
                      key={reason}
                      variant="labelSmall"
                      style={styles.description}>
                      · {reason}
                    </Text>
                  ))}
              </View>
            )}

            {showPerformance && (
              <>
                <Divider />

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.forceCoreCount}
                    </Text>
                    <TextInput
                      testID="local-api-force-core-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={forceCoreDraft}
                      onChangeText={setForceCoreDraft}
                      onEndEditing={() =>
                        commitNumber(
                          forceCoreDraft,
                          localApiStore.forceCoreCount,
                          value => {
                            localApiStore.forceCoreCount = Math.max(0, value);
                            localApiStore.alignThreadCount(value);
                            void localApiStore.applyTuning();
                          },
                        )
                      }
                      helperText={l10n.localApi.forceCoreCountDescription}
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.bindBigCores}
                    </Text>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.bindBigCoresDescription}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-bind-switch"
                    value={localApiStore.bindBigCores}
                    onValueChange={value => {
                      localApiStore.bindBigCores = value;
                      void localApiStore.applyTuning();
                    }}
                  />
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.enablePriority}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-priority-switch"
                    value={localApiStore.enablePriority}
                    onValueChange={value => {
                      localApiStore.enablePriority = value;
                      void localApiStore.applyTuning();
                    }}
                  />
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.enableRealTime}
                    </Text>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.enableRealTimeDescription}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-rt-switch"
                    value={localApiStore.enableRealTime}
                    onValueChange={value => {
                      localApiStore.enableRealTime = value;
                      void localApiStore.applyTuning();
                    }}
                  />
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.yieldBackground}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-yield-switch"
                    value={localApiStore.yieldBackground}
                    onValueChange={value => {
                      localApiStore.yieldBackground = value;
                      void localApiStore.applyTuning();
                    }}
                  />
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.backgroundNice}
                    </Text>
                    <TextInput
                      testID="local-api-background-nice-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={backgroundNiceDraft}
                      onChangeText={setBackgroundNiceDraft}
                      onEndEditing={() =>
                        commitNumber(
                          backgroundNiceDraft,
                          localApiStore.backgroundNice,
                          value => {
                            localApiStore.backgroundNice = Math.min(
                              Math.max(value, 1),
                              19,
                            );
                            void localApiStore.applyTuning();
                          },
                        )
                      }
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.rebindInterval}
                    </Text>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.rebindIntervalDescription}
                    </Text>
                    <TextInput
                      testID="local-api-rebind-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={rebindDraft}
                      onChangeText={setRebindDraft}
                      onEndEditing={() =>
                        commitNumber(
                          rebindDraft,
                          localApiStore.rebindIntervalMs,
                          value => {
                            localApiStore.rebindIntervalMs = Math.min(
                              Math.max(value, 50),
                              5000,
                            );
                            void localApiStore.applyTuning();
                          },
                        )
                      }
                    />
                  </View>
                </View>

                <Divider />

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.keepModelResident}
                    </Text>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.keepModelResidentDescription}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-resident-switch"
                    value={localApiStore.keepModelResident}
                    onValueChange={value => {
                      localApiStore.setKeepModelResident(value);
                    }}
                  />
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="titleMedium" style={styles.label}>
                      {l10n.localApi.mlockEnabled}
                    </Text>
                  </View>
                  <Switch
                    testID="local-api-mlock-switch"
                    value={localApiStore.mlockEnabled}
                    onValueChange={value => {
                      localApiStore.mlockEnabled = value;
                      if (value) {
                        void localApiStore.syncMemoryLockForActiveModel();
                      } else {
                        localApiStore.releaseMemoryLock();
                      }
                    }}
                  />
                </View>

                <Divider />

                {/* HTTP 层的两个可配置阈值。
                    读超时同时决定「请求体读取上限」和「keep-alive 空闲连接的
                    阻塞时长」—— 传 300 秒意味着一条闲置长连接占住一个工作线程
                    整整五分钟，所以默认降到 60 秒并允许改。 */}
                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.socketTimeout}
                    </Text>
                    <TextInput
                      testID="local-api-socket-timeout-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={socketTimeoutDraft}
                      onChangeText={setSocketTimeoutDraft}
                      onEndEditing={() =>
                        commitNumber(
                          socketTimeoutDraft,
                          localApiStore.socketReadTimeoutMs,
                          value => {
                            localApiStore.socketReadTimeoutMs = Math.min(
                              Math.max(value, 1000),
                              300000,
                            );
                            void localApiStore.applyRuntimeConfig();
                          },
                        )
                      }
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.maxWaiting}
                    </Text>
                    <TextInput
                      testID="local-api-max-waiting-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={maxWaitingDraft}
                      onChangeText={setMaxWaitingDraft}
                      onEndEditing={() =>
                        commitNumber(maxWaitingDraft, localApiStore.maxWaiting, value => {
                          localApiStore.maxWaiting = Math.min(Math.max(value, 0), 64);
                          void localApiStore.applyRuntimeConfig();
                        })
                      }
                    />
                  </View>
                </View>

                <Divider />

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.defaultMaxTokens}
                    </Text>
                    <TextInput
                      testID="local-api-max-tokens-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={maxTokensDraft}
                      onChangeText={setMaxTokensDraft}
                      onEndEditing={() =>
                        commitNumber(
                          maxTokensDraft,
                          localApiStore.defaultMaxTokens,
                          value => {
                            localApiStore.defaultMaxTokens = Math.max(value, 1);
                          },
                        )
                      }
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text variant="labelSmall" style={styles.description}>
                      {l10n.localApi.defaultTemperature}
                    </Text>
                    <TextInput
                      testID="local-api-temperature-input"
                      style={styles.input}
                      keyboardType="numeric"
                      value={temperatureDraft}
                      onChangeText={setTemperatureDraft}
                      onEndEditing={() => {
                        const parsed = Number.parseFloat(temperatureDraft);
                        localApiStore.defaultTemperature = Number.isFinite(
                          parsed,
                        )
                          ? Math.min(Math.max(parsed, 0), 2)
                          : localApiStore.defaultTemperature;
                      }}
                    />
                  </View>
                </View>
              </>
            )}
          </Card.Content>
        </Card>

        {/* ③ 调优报告 */}
        <Card elevation={0} style={styles.card}>
          <Card.Title title={l10n.localApi.reportSection} />
          <Card.Content>
            <Text variant="labelSmall" style={styles.description}>
              {l10n.localApi.reportHint}
            </Text>

            {!report && (
              <Text variant="labelSmall" style={styles.description}>
                {l10n.localApi.notApplied}
              </Text>
            )}

            {!!report && (
              <>
                <ReportRow
                  label={l10n.localApi.topology}
                  value={
                    report.topology?.singleCluster
                      ? l10n.localApi.uniformCluster
                      : `${t(l10n.localApi.clusterSummary, {
                          big: String(report.topology?.bigClusterCpus?.length ?? 0),
                          small: String(report.topology?.smallCoreCount ?? 0),
                          total: String(report.topology?.totalCores ?? 0),
                        })} · ${
                          report.topology?.hardware ||
                          l10n.localApi.unknown
                        }`
                  }
                  styles={styles}
                />
                {/* 「强制核数」是用户意图，「目标核列表」是设备实际给得出的结果 ——
                    两者分开显示，才能在「要 2 个但设备只有 1 个大核」时如实说明。 */}
                <ReportRow
                  label={`${l10n.localApi.targetCpus} · ${l10n.localApi.effectiveCoreCount}`}
                  value={`${report.targetCpus.join(',') || '-'} · ${report.effectiveCoreCount}`}
                  styles={styles}
                />
                <ReportRow
                  label={`${l10n.localApi.affinityRequested} (${report.requestedForceCoreCount})`}
                  value={
                    report.affinityRequested.length === 0
                      ? l10n.localApi.statusStopped
                      : report.affinityRequested.join(',')
                  }
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.affinityActual}
                  value={
                    report.affinityActual.length === 0
                      ? '-'
                      : report.affinityActual.join(',')
                  }
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.affinityWorkers}
                  value={t(l10n.localApi.affinityWorkers, {
                    bound: String(report.affinityBoundWorkerThreads),
                    matched: String(report.affinityMatchedWorkerThreads),
                  })}
                  styles={styles}
                />
                <ReportRow
                  label={`${l10n.localApi.niceTarget} / ${l10n.localApi.niceActual}`}
                  value={`${report.niceRequested} / ${report.niceActual}`}
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.rlimitNice}
                  value={`${report.niceRlimitBefore?.soft}/${report.niceRlimitBefore?.hard} → ${report.niceRlimitAfter?.soft}/${report.niceRlimitAfter?.hard}`}
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.rlimitMemlock}
                  value={`${report.memlockRlimitBefore?.soft}/${report.memlockRlimitBefore?.hard} → ${report.memlockRlimitAfter?.soft}/${report.memlockRlimitAfter?.hard}`}
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.scheduler}
                  value={`${report.schedPolicyName} (rt=${report.rtPriority})`}
                  styles={styles}
                />
                <ReportRow
                  label={l10n.localApi.oomAdj}
                  value={`${report.oomRequested} / ${report.oomAfter}`}
                  styles={styles}
                />
                {!!localApiStore.mlockReport && (
                  <ReportRow
                    label={l10n.localApi.memoryLock}
                    value={`${formatMb(
                      localApiStore.mlockReport.lockedBytes,
                    )} / ${formatMb(localApiStore.mlockReport.fileSizeBytes)} · ${
                      localApiStore.mlockReport.note
                    }`}
                    styles={styles}
                  />
                )}

                {report.notes.length > 0 && (
                  <View style={{marginTop: 8}}>
                    <Text variant="labelSmall" style={styles.label}>
                      {l10n.localApi.notes}
                    </Text>
                    {report.notes.map(note => (
                      <Text key={note} variant="labelSmall" style={styles.description}>
                        · {note}
                      </Text>
                    ))}
                  </View>
                )}

                {report.errors.length > 0 && (
                  <View style={{marginTop: 8}}>
                    <Text variant="labelSmall" style={styles.errorText}>
                      {l10n.localApi.errors}
                    </Text>
                    {report.errors.map(error => (
                      <Text key={error} variant="labelSmall" style={styles.errorText}>
                        · {error}
                      </Text>
                    ))}
                  </View>
                )}

                {report.threads.length > 0 && (
                  <View style={{marginTop: 8}}>
                    <Button
                      compact
                      onPress={() => setShowThreads(prev => !prev)}
                      testID="local-api-toggle-threads">
                      {l10n.localApi.threads}
                    </Button>
                    {showThreads && (
                      <ScrollView style={styles.threadBox} nestedScrollEnabled>
                        {report.threads.slice(0, 60).map(thread => (
                          <Text key={thread} variant="labelSmall" style={styles.description}>
                            {thread}
                          </Text>
                        ))}
                      </ScrollView>
                    )}
                  </View>
                )}
              </>
            )}
          </Card.Content>
        </Card>

        {/* ④ 调用统计 */}
        <Card elevation={0} style={styles.card}>
          <Card.Title title={l10n.localApi.statsSection} />
          <Card.Content>
            <View style={styles.statGrid}>
              <Stat label={l10n.localApi.statsTotal} value={String(stats.total)} styles={styles} />
              <Stat
                label={l10n.localApi.statsStreaming}
                value={String(stats.streaming)}
                styles={styles}
              />
              <Stat
                label={l10n.localApi.statsFailed}
                value={String(stats.failed)}
                styles={styles}
              />
              <Stat
                label={l10n.localApi.statsAvgDuration}
                value={`${stats.averageDurationMs}ms`}
                styles={styles}
              />
              <Stat
                label={l10n.localApi.statsDropped}
                value={String(localApiStore.droppedTokens)}
                styles={styles}
              />
              <Stat
                label={l10n.localApi.statsInFlight}
                value={String(localApiStore.inFlight.length)}
                styles={styles}
              />
            </View>
            <Text variant="labelSmall" style={styles.description}>
              {l10n.localApi.statsLastCall}: {formatTime(stats.lastCallAt)}
            </Text>
            {!!status && (
              <Text variant="labelSmall" style={styles.description}>
                {`waiting=${status.inferenceWaiting} rejected=${status.inferenceRejected} conn=${status.httpConnections} threads=${status.httpThreadsActive}/${status.httpThreads} pipe=${status.pipePendingBytes}B drop=${status.droppedTokens}/${status.pipeDroppedFrames}`}
              </Text>
            )}
          </Card.Content>
        </Card>

        {/* ⑤ 调用明细 */}
        <Card elevation={0} style={styles.card}>
          <Card.Title
            title={l10n.localApi.logSection}
            right={() => (
              <Button compact onPress={localApiStore.clearCallLog}>
                {l10n.localApi.clearLog}
              </Button>
            )}
          />
          <Card.Content>
            {localApiStore.callRecords.length === 0 ? (
              <Text variant="labelSmall" style={styles.description}>
                {l10n.localApi.logEmpty}
              </Text>
            ) : (
              localApiStore.callRecords.slice(0, 40).map(record => (
                <View key={record.id} style={styles.logRow} testID={`call-row-${record.id}`}>
                  <Text
                    variant="bodySmall"
                    style={record.status >= 400 ? styles.errorText : styles.valueText}>
                    {`[${record.status}] ${formatTime(record.startedAt)} · ${record.durationMs}ms · ${
                      record.stream ? 'stream' : 'block'
                    } · ${record.remoteIp}`}
                  </Text>
                  <Text variant="labelSmall" style={styles.description} numberOfLines={2}>
                    {record.preview || '(no preview)'}
                  </Text>
                  <Text variant="labelSmall" style={styles.logMeta}>
                    {`tokens ${record.promptTokens}/${record.completionTokens}${
                      record.error ? ` · ${record.error}` : ''
                    }`}
                  </Text>
                </View>
              ))
            )}
          </Card.Content>
        </Card>

        {Platform.OS === 'android' && (
          <Button
            mode="text"
            onPress={() => void localApiStore.refreshTuningReport()}
            style={styles.sectionButton}>
            {l10n.localApi.refresh}
          </Button>
        )}


      </ScrollView>
    </SafeAreaView>
  );
});

const ReportRow: React.FC<{
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}> = ({label, value, styles}) => (
  <View style={styles.row}>
    <Text variant="labelSmall" style={[styles.rowText, styles.description]}>
      {label}
    </Text>
    <Text variant="labelSmall" style={styles.valueText}>
      {value}
    </Text>
  </View>
);

const Stat: React.FC<{
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}> = ({label, value, styles}) => (
  <View style={styles.statCell}>
    <Text style={styles.statValue}>{value}</Text>
    <Text variant="labelSmall" style={styles.statLabel}>
      {label}
    </Text>
  </View>
);
