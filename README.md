<div align="center">

<img src="assets/svg/logo-primary.svg" alt="TwinCore logo" width="140" />

# TwinCore

**双核，双路加速 —— 为骁龙大核与 Hexagon NPU 而生的本地 AI 助手。**

TwinCore 是一个完全运行在手机上的私有 AI 助手：本地大模型对话、局域网 OpenAI 兼容 API、
CPU 大核绑定与 Hexagon NPU 加速、Shizuku 三档性能模式 —— 全部离线，无需账号、无需云端。

<a href="#%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B">快速开始</a> ·
<a href="#twincore-%E6%80%A7%E8%83%BD%E6%8A%80%E6%9C%AF">性能技术</a> ·
<a href="#%E5%B1%80%E5%9F%9F%E7%BD%91-openai-%E5%85%BC%E5%AE%B9-api">局域网 API</a> ·
<a href="#%E6%9E%84%E5%BB%BA%E4%B8%8E%E5%8F%91%E5%B8%83">构建与发布</a>

[![Build APK](https://img.shields.io/github/actions/workflow/status/shuytre/pocketpal-localapi/build.yml?label=Build%20APK)](https://github.com/shuytre/pocketpal-localapi/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

> **Based on PocketPal AI (MIT License)** — TwinCore fork 自
> [a-ghorbani/pocketpal-ai](https://github.com/a-ghorbani/pocketpal-ai)，
> 遵循其 MIT 许可证。感谢上游项目与所有贡献者。

## 为什么是 TwinCore

中端骁龙芯片（如红米 K20 / Snapdragon 730：2×A75 大核 + 6×A55 小核）跑本地大模型时，
系统调度器常常把推理线程摊到全部 8 个核上 —— 小核拖慢整体吞吐。TwinCore 把推理
**钉在大核上**，并优先把算子Offload 到 **Hexagon NPU**：

| 能力 | 说明 |
|---|---|
| CPU 大核绑定 | 推理线程固定到 A75 集群（cpu6-7），实测吞吐 11.79 → 22.86 tok/s |
| Hexagon NPU | 启用 GGML_HEXAGON / GGML_OPENCL 后端，HTP → OpenCL → CPU 回退链 |
| Shizuku 三档性能模式 | 省电 / 均衡 / 性能：通过 Shizuku 写 cpufreq，无需 Root |
| 局域网 OpenAI API | 手机即服务端：`/v1/chat/completions`（SSE 流式）+ `/v1/models` |
| 品牌视觉 | 全部资产为手绘 SVG 矢量（`assets/svg/`），一套源导出全部分辨率 |

## TwinCore 性能技术

### 1. CPU 亲和性（默认生效）

`src/utils/twincore.ts` 在模型加载前注入 CPU 策略：`n_threads` 锁定大核数量，
`n_threads_batch` 同步（batch 推理继承同一线程池）。拓扑探测自动识别大小核布局，
非对称设备安全降级。

### 2. Hexagon NPU / OpenCL（自动探测）

`android/app/build.gradle` 显式 `-DGGML_HEXAGON=ON -DGGML_OPENCL=ON`。加载模型时
`devices: ['htp', 'opencl', 'cpu']` 依次尝试，失败自动回退，永不阻塞。可选原生库在
Manifest 中声明为 `required=false`，无 NPU 设备照常安装。

### 3. Shizuku 三档性能模式（可选）

设置 → 性能模式。通过 [Shizuku](https://shizuku.rikka.app/) 获取 ADB 级权限后直接写
`/sys/devices/system/cpu/*/cpufreq`：

| 模式 | 小核 | 大核 | 附加动作 |
|---|---|---|---|
| 省电 powersave | 822MHz · powersave | 822MHz · powersave | — |
| 均衡 balanced | 1.4GHz · schedutil | 1.8GHz · schedutil | — |
| 性能 performance | 1.8GHz · performance | 2.2GHz · performance | 唤醒两个大核、解除后台限制 |

- 授权五态：`granted / denied / timeout / rejected_manual / binder_dead`，120s 超时
- 写入结果逐项读回校验，返回 `applied[]` + `failures[]` 双列表，部分生效不阻塞
- 可选「每 60 秒重新应用」对抗 MIUI/HyperOS perfd 覆写（仅前台）
- 未授权也能选档：只记录偏好，授权后一键应用

> 调频是**系统级**的，对整机生效。TwinCore 只调用 Shizuku 客户端 API，
> 不修改 Shizuku 本身，也不影响其他已授权应用。

## 局域网 OpenAI 兼容 API

设置 → Local API 打开开关后，手机变成一台 OpenAI 兼容服务器（默认端口 `8080`）：

```bash
# 查看已加载模型
curl http://<手机IP>:8080/v1/models

# 流式对话（与 OpenAI SDK / 任意 OpenAI 兼容客户端直接对接）
curl http://<手机IP>:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<模型名>",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

- 原生实现（`java.net.ServerSocket`，零第三方依赖），前台服务保活
- SSE 流式输出，15s 心跳保活长连接
- 端口可在设置内调整；Base URL 自动展示本机地址

## 快速开始

### 下载预构建 APK

见 [Releases](https://github.com/shuytre/pocketpal-localapi/releases) ——
每次推送到 `main` 都会自动构建 debug APK 并附到 Release。

### 从源码构建

```bash
git clone https://github.com/shuytre/pocketpal-localapi.git
cd pocketpal-localapi
yarn install
# 从 SVG 源重新导出全部 launcher PNG（可选，已提交产物）
yarn svg:export
cd android && ./gradlew assembleDebug && cd ..
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

要求：Node ≥ 22、JDK 17、Android SDK 36 / NDK 27.3.13750724。

## 构建与发布

`.github/workflows/build.yml`：

- **触发**：push 到 `main` 或手动（workflow_dispatch）
- **缓存**：yarn 依赖 + Gradle wrapper/caches + Android SDK/NDK（命中后构建时间大幅缩短）
- **并行**：Gradle `--max-workers=4`（吃满 GitHub 托管 runner 的 4 核）
- **产物**：`app-debug.apk` 自动附加到 tag `v1.0.<run_number>` 的 GitHub Release

## 项目结构（TwinCore 增量）

```
assets/svg/                     # 8 个手绘品牌 SVG（唯一样式源）
scripts/export-svg.js           # SVG → 全分辨率 launcher PNG（sharp）
src/utils/twincore.ts           # CPU 大核绑定 + NPU 回退链
src/utils/performanceMode.ts    # 三档模式 + 降级 + 60s 重应用
src/specs/NativeTwinCorePerf.ts # TurboModule Spec
src/screens/SettingsScreen/
  └─ PerformanceModeSection.tsx # Shizuku 状态面板 + 三横向档位卡片
src/components/SplashOverlay/   # 1.8s 六段启动动画
android/.../TwinCorePerfModule.kt        # Shizuku + cpufreq 原生实现
android/.../localapi/                    # 局域网 OpenAI 兼容服务器
.github/workflows/build.yml              # 缓存 + 4 核构建 + Release
```

## 许可证

MIT。基于 [PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai)（MIT License）构建，
品牌与性能相关改动版权归各自作者。
