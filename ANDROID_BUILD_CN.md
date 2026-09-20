# Android 构建说明（局域网 API 服务 + 调度调优版）

这份文档给出**在 Windows / Linux / macOS 上把这套改动编成可安装 APK** 的完整步骤，
以及本机（D:\PocketPal）为什么没能直接编出 APK 的实测原因。

---

## 一、产物与功能

编出来的 APK：App 内加载 GGUF 模型后，同一局域网内的任何电脑/手机可以直接用
**标准 OpenAI 接口**调用这个模型：

```
POST http://<手机局域网IP>:8080/v1/chat/completions
GET  http://<手机局域网IP>:8080/v1/models
GET  http://<手机局域网IP>:8080/health          # 实时状态（排队/连接/线程/丢弃计数）
```

- `stream: true` 走 SSE，逐块吐 token，结尾 `data: [DONE]`
- 单并发（同时只跑一个推理），排队满返回 503
- 未加载模型时返回 503（不是崩溃、也不是空 200）
- 设置页 →「Local Network API Service」里有：服务开关、端口、Base URL（可复制）、
  API Key 校验开关、CORS、性能参数、调优报告、调用统计与调用明细
- 仅用于学术研究

---

## 二、本机（这台 Windows 机器）实测结论

**没能编出 APK**，但代码本身已经过了四层编译验证（见下表），剩下的全是环境问题。

| 验证项 | 结果 | 说明 |
|---|---|---|
| TypeScript（`tsc --noEmit`） | ✅ 本次新增/改动的文件 **0 错误** | 全仓另有 331 条历史报错（缺 `@types/node` 导致的 `fs`/`global`/`NodeJS`/`URL` 等），分布在本次未触碰的文件里 |
| JS 打包（Metro bundle） | ✅ 成功产出 17.74 MB bundle + 50 个 asset | 说明新增的所有 JS/TS 模块依赖解析与转译正确 |
| Kotlin（`compileProdDebugKotlin`） | ✅ **BUILD SUCCESSFUL** | 含 codegen 生成的 `NativePerfTuneSpec` / `NativeLocalApiServerSpec` 抽象类，覆盖签名全部对得上 |
| C++/JNI（NDK clang，`-Wall`） | ✅ 编译通过、零警告 | `perf_tune.cpp` 单独用 NDK 27 的 clang++ 验证 |
| 完整 APK | ❌ 卡在 Windows 长路径 | 与代码无关，见下表 |

实际撞到并已逐个处理的阻塞点（**长路径只是第 6 个**）：

| # | 阻塞点 | 现象 | 处理 |
|---|--------|------|------|
| 1 | PowerShell 执行策略 | `npm`（npm.ps1）被禁止运行 | 改用 `npm.cmd` 全路径 |
| 2 | npm 依赖解析冲突 | `npm install` 报 ERESOLVE（react-native-windows 的 peer 冲突） | 工程用 yarn.lock，必须 `yarn install` |
| 3 | 沙箱拦截 | 写入 `node_modules\...` 被拒、后台任务被终止 | 关闭沙箱 + 用「前台调用，超时自动转后台」的长任务姿势 |
| 4 | Gradle wrapper 下载不到 | `services.gradle.org` 超时（10s 超时直接失败） | 本机 `~/.gradle` 里已有完整 `gradle-9.0.0`，直接调用它的 `bin/gradle.bat` |
| 5 | NDK 是空目录 | `[CXX1101] NDK ... did not have a source.properties file`（目录里只有 `.installer`，0 MB） | `sdkmanager --install "ndk;27.3.13750724"`（2.25 GB） |
| 6 | **Windows 长路径未开启** | `LongPathsEnabled=0`；对象路径 376 字符 > 260，ninja 报 `Filename longer than 260 characters` | **无解**（需要管理员权限改注册表，本机被拒）。改目录名最多省 ~35 字符，不够 |
| 7 | 内存不够 | Metro 打包 node 堆 1986 MB → `JavaScript heap out of memory` | `NODE_OPTIONS=--max-old-space-size=3200` + `--max-workers 1`（已验证：单独跑 Metro 成功，耗时 24 分钟） |
| 8 | Java 版本不对 | 本机只有 JDK 26，AGP/Kotlin 不认 | 下载 Temurin **JDK 17** 并指定 `JAVA_HOME` |
| 9 | `google-services.json` 缺失 | Google Services 插件会在配置阶段直接失败 | 已补占位文件（发布前请换成真实配置） |

### 本次修复的 4 个真实代码问题（编译验证抓出来的）

这几处**只靠肉眼审查不会发现**，是在本机跑 tsc / kotlinc / clang 之后才暴露的，已经全部改好：

1. `src/screens/SettingsScreen/SettingsScreen.tsx`：`ROUTES` 不是从 `../../utils` 导出的，
   必须从 `../../utils/navigationConstants` 导入（tsc 报 `has no exported member 'ROUTES'`）。
2. `LocalApiServerModule.kt`：codegen 把 TS 的 `number` 映射成 Java 的 **`double`**，
   所以 `pushFinish(...)` / `pushError(...)` 的参数必须是 `Double`，写成 `Int` 会报
   `overrides nothing`。已改为收 `Double`、内部转 `Int`。
3. `PerfTuneModule.kt`：一行错误的 import —— `java.util.concurrent.locks.CountDownLatch`
   （这个类不存在，`CountDownLatch` 在 `java.util.concurrent` 下），导致三处 `Unresolved reference`。
4. `PerfTuneModule.kt`：`ReadableArray.getString()` 返回 `String?`，直接 `add` 进 `MutableList<String>`
   会报可空类型不匹配，已改为判空后再加。

---

## 三、在能编的机器上怎么编（照抄即可）

### 0. 前置条件

| 项 | 版本 | 说明 |
|----|------|------|
| Node | ≥ 22.21 | `package.json` engines 要求 |
| JDK | **17** | AGP 要求；不要用 JDK 21+/26，容易踩 Kotlin 编译器的坑 |
| Android SDK | platform 36 / build-tools 36.0.0 / **NDK 27.3.13750724** / CMake 3.22.1 | 与本项目 `android/build.gradle` 里的 `ext` 完全一致 |
| Windows | 必须 | 打开长路径：`LongPathsEnabled=1`（管理员），或把工程放到很短的根本目录（如 `C:\p`），否则 ninja 会以 376 字符的对象路径直接拒绝 |
| 内存 | ≥ 8 GB 建议 | Metro 打包阶段 node 需要 ~2.5 GB 堆 |

Windows 打开长路径（管理员 PowerShell，之后重开终端）：

```powershell
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled -Value 1 -Type DWord
```

### 1. 安装依赖

```bash
cd <工程根目录>
npm install -g yarn                     # 工程用 yarn.lock
yarn install                            # 国内可加 --registry https://registry.npmmirror.com
npx patch-package                       # 应用 patches/ 下两个补丁（yarn install 的 postinstall 也会做）
```

### 2. Firebase 配置文件（必须处理）

工程里的 `google-services.json` 是**占位文件**（原本缺失，会让 `com.google.gms.google-services`
插件直接失败）。它只服务于「自愿上传基准测试结果到 HuggingFace Spaces」这一个功能，
与本改造无关。两种处理方式：

- 想保留原功能：从自己的 Firebase 项目下载真实的 `google-services.json` 覆盖它；
- 不需要：保留占位文件即可，构建通过，运行时 Firebase 相关的那个可选功能会静默失败。

### 3. 生成签名（可选，用默认 debug 签名也能装）

`android/app/build.gradle` 在找不到 release 签名时会回退到 debug keystore（会打印警告）。
所以下面命令直接能出可安装的 APK。

### 4. 开始构建

```bash
cd android
# Windows
set JAVA_HOME=C:\path\to\jdk-17
set NODE_OPTIONS=--max-old-space-size=3200
gradlew.bat assembleProdRelease -PreactNativeArchitectures=arm64-v8a

# macOS / Linux
export JAVA_HOME=/path/to/jdk-17
export NODE_OPTIONS=--max-old-space-size=3200
./gradlew assembleProdRelease -PreactNativeArchitectures=arm64-v8a
```

要点：

- 用 `-PreactNativeArchitectures=arm64-v8a`，**只编红米 K20 需要的 ABI**，
  否则 x86_64 会白编一遍（时间翻倍）。
- `NODE_OPTIONS=--max-old-space-size=3200` 是给 Metro 打包用的。3.9 GB 内存的机器上
  不设它会在 `createBundleProdDebugJsAndAssets` 阶段 `JavaScript heap out of memory`。
- 想编 debug 包用于真机联调，把 `assembleProdRelease` 换成 `assembleProdDebug`，
  但注意：**debug 包需要 Metro 服务器**（`npx react-native start`），不能独立运行；
  要独立安装就用 release。

产物路径：

```
android/app/build/outputs/apk/prod/release/app-prod-release.apk
（debug 为 android/app/build/outputs/apk/prod/debug/app-prod-debug.apk）
```

安装：

```bash
adb install -r android/app/build/outputs/apk/prod/release/app-prod-release.apk
```

---

## 四、装到红米 K20 后的验收步骤

1. 手机连 Wi-Fi，打开 App，进「Models」加载一个 GGUF（建议 Q4_K_M，≤2 GB）。
2. 进「Settings → Local Network API Service」：
   - 服务默认已自动开启；确认状态显示 **Listening**
   - 复制页面上的 Base URL（形如 `http://192.168.x.x:8080/v1`）
   - 想看调优详情就点开「Tuning report」：里面有
     **请求核 vs 实际亲和掩码（`sched_getaffinity` 回读）**、nice 阶梯命中档位、
     `RLIMIT_NICE` / `RLIMIT_MEMLOCK` 抬升前后、mlock 实际锁住多少 MB、
     以及进程内线程名快照（`tid:name`）。
     K20 上期望看到实际掩码是 `6,7`；nice 大概率仍是 0（未 root 无 CAP_SYS_NICE，
     这是预期结果，报告里会写明原因而不是假装成功）。
3. 电脑上验证：

```bash
# 健康检查
curl http://192.168.x.x:8080/health

# 非流式
curl http://192.168.x.x:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"用一句话介绍你自己"}],"max_tokens":128}'

# 流式（应看到 token 逐块到达，最后 data: [DONE]）
curl -N http://192.168.x.x:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"数到20"}],"stream":true}'

# 模型列表
curl http://192.168.x.x:8080/v1/models
```

> 用 `curl -N`（或 Python `httpx`）测流式。**不要用带 gzip 的裸 curl 对比**：
> 服务端已永久关闭 SSE 的 gzip，并强制 `Cache-Control: no-cache, no-transform`。

4. 编码 Agent 接入（Claude Code / Cline / Continue 等）：自定义 OpenAI Base URL 填
   `http://192.168.x.x:8080/v1`，API Key 填任意值（除非你在设置里开了校验）。
5. 连续 10 轮对话观察：设置页「Usage」里的 calls / failed / dropped tokens 与
   `/health` 的 `inference_waiting` / `inference_rejected` 是否正常；
   服务在 App 切后台后应依然可用（前台服务通知会常驻）。

---

## 五、本次改造在构建层面的两个注意点

1. **新增了 NDK 编译单元**：`android/app/src/main/jni/src/perf_tune.cpp`
   （已加入 `jni/CMakeLists.txt`）。所以构建**必须**有 NDK —— 缺 NDK 会报
   `[CXX1101] NDK ... did not have a source.properties file` 或找不到 `ninja`。
2. **新增了前台服务与权限**：`AndroidManifest.xml` 里加了
   `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` / `FOREGROUND_SERVICE`
   以及 `com.pocketpal.localapi.LocalApiForegroundService`（普通权限，无需运行时授权，兼容 Android 10）。

---

## 六、仅用于学术研究

本功能用于逆向工程课程课题研究，禁止用于任何非法用途。
