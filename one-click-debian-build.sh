#!/usr/bin/env bash
# =============================================================================
# PocketPal · 局域网 API 服务 + 调度调优版 —— Debian 一键编译脚本
# =============================================================================
# 作用：在**全新 Debian 机器**上从零把本项目编成可安装的 APK（默认 release，
#       arm64-v8a，即红米 K20 等真机可用的那个）。
#
# 用法：
#     chmod +x one-click-debian-build.sh
#     ./one-click-debian-build.sh              # 一键：装工具链 → 装依赖 → 出 APK
#
# 常用可选参数（都是环境变量，放在命令前面即可）：
#     SKIP_DEPS=1    # 跳过 apt / Node / 依赖安装，只重新编译
#     SKIP_SDK=1     # 跳过 Android SDK 安装（已装过时用）
#     ABI=arm64-v8a  # 目标 ABI，也可 arm64-v8a,x86_64
#     GRADLE_TASK=assembleProdDebug
#     NPM_REGISTRY=https://registry.npmmirror.com    # 国内镜像
#     INSTALL=1      # 编完自动 adb install（需要手机已连上）
#     SDK_ROOT=/opt/android-sdk                      # 自定义 SDK 位置
#
# 环境要求：Debian 10/11/12/13（x86_64 或 arm64 主机均可）、能联网、
#           建议 ≥8GB 内存 / ≥15GB 空闲磁盘（NDK 就要 2.3GB）。
# 产物：android/app/build/outputs/apk/prod/release/app-prod-release.apk
# 说明：仅用于学术研究，禁止用于非法用途。
# =============================================================================

set -Eeuo pipefail

# ─────────────────────────── 可调参数 ────────────────────────────────────────
SDK_ROOT="${SDK_ROOT:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
NDK_VERSION="27.3.13750724"
PLATFORM_VERSION="android-36"
BUILD_TOOLS_VERSION="36.0.0"
CMAKE_VERSION="3.22.1"
CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-13114758}"
CMDLINE_TOOLS_FALLBACKS="12266719 11076708"
NODE_VERSION="${NODE_VERSION:-v22.21.0}"
ABI="${ABI:-arm64-v8a}"
GRADLE_TASK="${GRADLE_TASK:-assembleProdRelease}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
GRADLE_MIRROR="${GRADLE_MIRROR:-https://mirrors.cloud.tencent.com/gradle}"
SKIP_DEPS="${SKIP_DEPS:-0}"
SKIP_SDK="${SKIP_SDK:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
INSTALL="${INSTALL:-0}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_ROOT/build-logs"
mkdir -p "$LOG_DIR"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# ─────────────────────────── 输出工具 ────────────────────────────────────────
C_RESET=$'\033[0m'; C_INFO=$'\033[1;36m'; C_OK=$'\033[1;32m'
C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'

step() { printf '\n%s▶ %s%s\n' "$C_INFO" "$*" "$C_RESET"; }
ok()   { printf '%s  ✓ %s%s\n' "$C_OK" "$*" "$C_RESET"; }
warn() { printf '%s  ! %s%s\n' "$C_WARN" "$*" "$C_RESET"; }
die()  { printf '\n%s✗ %s%s\n' "$C_ERR" "$*" "$C_RESET" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ────────────── 0. 前置检查 ─────────────────────────────────────────────────
step "0/9 环境检查"
[ -f "$PROJECT_ROOT/package.json" ] || die "当前目录不像工程根目录（找不到 package.json）：$PROJECT_ROOT"
[ -d "$PROJECT_ROOT/android" ]     || die "找不到 android/ 目录"
need_cmd apt-get || die "这个脚本是给 Debian/Ubuntu 用的（缺少 apt-get）。其他发行版请手动装：JDK17、Node 22、Android SDK/NDK。"
ok "工程根目录：$PROJECT_ROOT"

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)  HOST_ARCH="x64";   ;;
  aarch64|arm64) HOST_ARCH="arm64"; ;;
  *) die "不支持的 CPU 架构：$ARCH_RAW（本脚本支持 x86_64 / aarch64）";;
esac

# ── ARM64 主机守卫 ───────────────────────────────────────────────────────────
# 实测事实（2026-09-19 核对 dl.google.com 与 SDK repository2-3.xml）：
#   · NDK 只有 linux-x86_64 版本：android-ndk-r27d-linux-aarch64.zip 等一律 404；
#     最后一版带 aarch64 主机支持的是 NDK **r23**，而本工程要求 27.3.13750724。
#   · SDK 里的 cmake;3.22.1 同样没有 linux-aarch64 归档（只有古老的 3.6/3.10 有）。
#   · React Native 的 Hermes 编译器只随包提供 linux64-bin（x86_64），
#     release 包的 Hermes 字节码编译在 arm64 上会 Exec format error。
# 所以 x86_64 之外的 Linux 主机没法用官方工具链直接编译 —— 提前说清楚，
# 免得下完 2.3GB 的 NDK 才在 ninja/clang 那一步炸掉。
if [ "$HOST_ARCH" = "arm64" ] && [ "${ALLOW_ARM64_HOST:-0}" != "1" ]; then
  cat <<'ARM64_MSG'

✗ 检测到 ARM64（aarch64）主机：**无法用官方工具链编译本工程**。

原因（三条都已实测确认）：
  1. NDK 不提供 Linux-aarch64 版本。android-ndk-r27d-linux-aarch64.zip → 404；
     最后一版支持 aarch64 主机的是 NDK r23，而本工程要求 27.3.13750724。
  2. SDK 的 cmake;3.22.1 没有 aarch64 归档（只有 3.6 / 3.10 这类老版本有）。
  3. RN 自带的 Hermes 编译器只有 linux64-bin（x86_64），release 打包会 Exec format error。

三条可行路线：
  A. 换 x86_64 机器 / x86_64 虚拟机 / 云构建（最省事，推荐）。
  B. 在 ARM64 主机上用仿真跑 x86_64 工具链：
       sudo apt install qemu-user-static binfmt-support
       docker run --platform linux/amd64 -v "$PWD":/w -w /w ubuntu:22.04 bash one-click-debian-build.sh
     （或给 NDK 的 clang/ninja/cmake/hermesc 套 box64 包装脚本）——慢，且 LLVM 在仿真下偶发崩溃。
  C. 明知道后果、仍要硬试：把 NDK/CMake 换成能跑的组合后加 ALLOW_ARM64_HOST=1 跳过本检查
     （工程里 ndkVersion 与 compileSdk 是绑死的，改它们等于改工程，不推荐）。

补充：**编出来的 APK 本身与主机架构无关**（它装的是交叉编译出的 arm64-v8a 目标库），
      所以只要有 x86_64 主机编一次，产物在 ARM64 手机上跑起来完全一样。

ARM64_MSG
  die "已在 ARM64 主机上提前退出（加 ALLOW_ARM64_HOST=1 可强行继续）"
fi
ok "主机架构 $ARCH_RAW（x86_64 主机，官方工具链齐备）"

FREE_KB="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
[ "$FREE_GB" -lt 12 ] && warn "可用磁盘只有 ${FREE_GB}GB，NDK+构建缓存建议至少 15GB"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
[ "$MEM_MB" -lt 7000 ] && warn "内存只有 ${MEM_MB}MB：JS 打包阶段可能吃紧，必要时把 NODE_OPTIONS 调大并加交换分区"
ok "主机架构 $ARCH_RAW / 内存 ${MEM_MB}MB / 可用磁盘 ${FREE_GB}GB"

# ────────────── 1. apt 依赖 + JDK 17 ───────────────────────────────────────
if [ "$SKIP_DEPS" != "1" ]; then
  step "1/9 安装系统依赖（JDK 17 / unzip / curl / git / python3 …）"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y
  # RN 0.82 + AGP 要求 JDK 17；不要用 JDK 21/26，Kotlin 编译器容易出兼容问题。
  $SUDO apt-get install -y --no-install-recommends \
    openjdk-17-jdk unzip curl wget git python3 ca-certificates file procps
  ok "apt 依赖安装完成"
else
  step "1/9 跳过 apt 依赖（SKIP_DEPS=1）"
fi

# JAVA_HOME：优先问 dpkg，其次猜常见路径
JAVA_HOME_DETECTED="$(dirname "$(dirname "$(readlink -f "$(command -v javac 2>/dev/null || echo /usr/bin/javac)")")")"
if [ ! -x "${JAVA_HOME_DETECTED}/bin/java" ]; then
  for candidate in /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/java-17-openjdk-arm64; do
    [ -x "$candidate/bin/java" ] && JAVA_HOME_DETECTED="$candidate" && break
  done
fi
[ -x "${JAVA_HOME_DETECTED}/bin/java" ] || die "找不到 JDK 17，请手动安装 openjdk-17-jdk"
export JAVA_HOME="$JAVA_HOME_DETECTED"
export PATH="$JAVA_HOME/bin:$PATH"
JAVA_VER="$("$JAVA_HOME/bin/java" -version 2>&1 | head -n1)"
ok "JAVA_HOME=$JAVA_HOME （$JAVA_VER）"

# ────────────── 2. Node 22 ─────────────────────────────────────────────────
if [ "$SKIP_DEPS" != "1" ]; then
  step "2/9 准备 Node.js（需要 ≥22.21，package.json engines 要求）"
  NODE_OK=0
  if need_cmd node; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
    if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 21 ]; }; then
      NODE_OK=1
      ok "已有 Node $(node -v)"
    else
      warn "现有 Node $(node -v) 太旧，将安装 $NODE_VERSION"
    fi
  fi
  if [ "$NODE_OK" != "1" ]; then
    # 走 npmmirror 的二进制镜像（国内可直连），不依赖 NodeSource 源。
    NODE_TARBALL_URL="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}/${NODE_VERSION}/node-${NODE_VERSION}-linux-${HOST_ARCH}.tar.xz"
    TMP_TARBALL="/tmp/node-${NODE_VERSION}-linux-${HOST_ARCH}.tar.xz"
    step "   下载 Node：$NODE_TARBALL_URL"
    curl -fL --retry 3 --connect-timeout 20 -o "$TMP_TARBALL" "$NODE_TARBALL_URL" \
      || die "Node 下载失败。可手动装 Node 22 后加 SKIP_DEPS=1 重跑本脚本。"
    $SUDO mkdir -p /usr/local/lib/nodejs
    $SUDO tar -xJf "$TMP_TARBALL" -C /usr/local/lib/nodejs
    NODE_DIR="/usr/local/lib/nodejs/node-${NODE_VERSION}-linux-${HOST_ARCH}"
    for bin in node npm npx corepack; do
      [ -e "$NODE_DIR/bin/$bin" ] && $SUDO ln -sf "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"
    done
    ok "Node 安装完成：$(node -v)"
  fi
  need_cmd npm || die "npm 不可用"
  npm config set registry "$NPM_REGISTRY" >/dev/null 2>&1 || true
  ok "npm registry = $(npm config get registry)"
  if ! need_cmd yarn; then
    step "   安装 yarn 1.x（工程用 yarn.lock，不要用 npm install）"
    $SUDO npm install -g yarn@1.22.22 --registry="$NPM_REGISTRY"
  fi
  ok "yarn $(yarn -v)"
else
  step "2/9 跳过 Node/yarn 安装（SKIP_DEPS=1）"
fi

# ────────────── 3. Android SDK + NDK ───────────────────────────────────────
if [ "$SKIP_SDK" != "1" ]; then
  step "3/9 安装 Android SDK / NDK（NDK 约 2.3GB，第一次会慢）"
  # 本机没有 cmdline-tools 才去下
  if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
    mkdir -p "$SDK_ROOT/cmdline-tools" "$LOG_DIR"
    DOWNLOADED=0
    for build in "$CMDLINE_TOOLS_BUILD" $CMDLINE_TOOLS_FALLBACKS; do
      url="https://dl.google.com/android/repository/commandlinetools-linux-${build}_latest.zip"
      step "   尝试下载 cmdline-tools：$url"
      if curl -fL --retry 2 --connect-timeout 20 -o "/tmp/cmdline-tools.zip" "$url"; then
        DOWNLOADED=1; break
      fi
      warn "该版本下载失败，换下一个候选版本"
    done
    [ "$DOWNLOADED" = "1" ] || die "cmdline-tools 下载失败：请检查网络能否访问 dl.google.com（国内一般可直连）"
    rm -rf "$SDK_ROOT/cmdline-tools/latest" /tmp/cmdline-tools-x
    mkdir -p /tmp/cmdline-tools-x
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-x
    mv /tmp/cmdline-tools-x/cmdline-tools "$SDK_ROOT/cmdline-tools/latest"
    ok "cmdline-tools 就绪"
  else
    ok "已有 cmdline-tools"
  fi

  export ANDROID_HOME="$SDK_ROOT"
  export ANDROID_SDK_ROOT="$SDK_ROOT"
  export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$PATH"

  step "   接受 SDK 许可协议"
  yes | sdkmanager --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true

  step "   安装 platform-tools / platform / build-tools / NDK / CMake"
  # 版本必须与 android/build.gradle 的 ext 完全一致，否则会报
  # [CXX1101] NDK ... did not have a source.properties file 或 CMake 找不到。
  sdkmanager --sdk_root="$SDK_ROOT" \
    "platform-tools" \
    "platforms;${PLATFORM_VERSION}" \
    "build-tools;${BUILD_TOOLS_VERSION}" \
    "ndk;${NDK_VERSION}" \
    "cmake;${CMAKE_VERSION}"
  ok "SDK 组件安装完成"
else
  step "3/9 跳过 SDK 安装（SKIP_SDK=1）"
fi

# local.properties：AGP 会优先读它，路径不对会直接构建失败，所以每次都覆盖写。
step "   写入 android/local.properties"
printf 'sdk.dir=%s\n' "$SDK_ROOT" > "$PROJECT_ROOT/android/local.properties"
export ANDROID_HOME="${ANDROID_HOME:-$SDK_ROOT}"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_NDK_HOME="$SDK_ROOT/ndk/$NDK_VERSION"
export PATH="$SDK_ROOT/platform-tools:$PATH"
ok "sdk.dir=$SDK_ROOT"

# ────────────── 4. Firebase 配置占位 ───────────────────────────────────────
step "4/9 检查 google-services.json"
GS="$PROJECT_ROOT/android/app/google-services.json"
if [ ! -f "$GS" ]; then
  warn "缺少 google-services.json，写入占位文件（构建能过；Firebase 可选功能会静默失效）"
  cat > "$GS" <<'JSON'
{"project_info":{"project_number":"000000000000","project_id":"pocketpal-local","storage_bucket":"pocketpal-local.appspot.com"},
"client":[{"client_info":{"mobilesdk_app_id":"1:000000000000:android:0000000000000000","android_client_info":{"package_name":"com.pocketpalai"}},
"oauth_client":[],"api_key":[{"current_key":"AIzaSyLocalBuildPlaceholderKey000000000000000"}],
"services":{"analytics_service":{"status":1},"appinvite_service":{"status":1,"other_platform_oauth_client":[]},"ads_service":{"status":2}}}],
"configuration_version":"1"}
JSON
else
  ok "已存在（如果是占位文件，发布前请换成真实配置）"
fi

# ────────────── 5. JS 依赖 ─────────────────────────────────────────────────
if [ "$SKIP_DEPS" != "1" ]; then
  step "5/9 安装 JS 依赖（yarn install，约 10~30 分钟）"
  cd "$PROJECT_ROOT"
  # 必须用 yarn：npm install 会因 react-native-windows 的 peer 冲突直接 ERESOLVE 失败。
  yarn install --non-interactive --network-timeout 600000 --registry "$NPM_REGISTRY" \
    2>&1 | tee "$LOG_DIR/yarn-install.log"
  ok "依赖安装完成"
  step "   应用 patches/ 下的补丁（patch-package）"
  npx --yes patch-package 2>&1 | tee -a "$LOG_DIR/yarn-install.log" || warn "patch-package 未全部成功，检查上面的日志"
else
  step "5/9 跳过依赖安装（SKIP_DEPS=1）"
fi

# ────────────── 6. Gradle 分发（国内加速） ─────────────────────────────────
step "6/9 检查 Gradle 分发"
WRAPPER_PROPS="$PROJECT_ROOT/android/gradle/wrapper/gradle-wrapper.properties"
[ -f "$WRAPPER_PROPS" ] || die "找不到 $WRAPPER_PROPS"
GRADLE_DIST_VERSION="$(sed -n 's#.*gradle-\([0-9.]*\)-bin\.zip.*#\1#p' "$WRAPPER_PROPS" | head -n1)"
[ -n "$GRADLE_DIST_VERSION" ] || GRADLE_DIST_VERSION="9.0.0"
if curl -fsI --max-time 10 https://services.gradle.org/distributions/ >/dev/null 2>&1; then
  ok "官方源可达，沿用 distributionUrl（Gradle $GRADLE_DIST_VERSION）"
else
  MIRROR_URL="$GRADLE_MIRROR/gradle-${GRADLE_DIST_VERSION}-bin.zip"
  warn "官方源 services.gradle.org 不可达（国内常见），改用镜像：$MIRROR_URL"
  # 只替换 distributionUrl 一行，其余不动
  sed -i "s#^distributionUrl=.*#distributionUrl=${MIRROR_URL//\//\\/}#" "$WRAPPER_PROPS"
  # 换成了镜像就不要再校验官方 sha256，否则必然失败
  sed -i '/^distributionSha256Sum=/d' "$WRAPPER_PROPS"
fi
chmod +x "$PROJECT_ROOT/android/gradlew"
ok "gradlew 就绪"

# ────────────── 7. 编译 ────────────────────────────────────────────────────
if [ "$SKIP_BUILD" != "1" ]; then
  step "7/9 开始编译（$GRADLE_TASK，ABI=$ABI）"
  cd "$PROJECT_ROOT/android"
  # 给 Metro 打包留够堆：默认 ~2GB 会在 createBundle*JsAndAssets 阶段 OOM。
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
  export GRADLE_OPTS="${GRADLE_OPTS:--Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m}"
  # 只编目标 ABI，避免 x86_64 白编一遍（时间直接翻倍）。
  ./gradlew "$GRADLE_TASK" -PreactNativeArchitectures="$ABI" --console=plain \
    2>&1 | tee "$LOG_DIR/gradle-build.log"
  ok "Gradle 构建完成"
else
  step "7/9 跳过编译（SKIP_BUILD=1）"
fi

# ────────────── 8. 产出 ────────────────────────────────────────────────────
step "8/9 产物"
APK="$(find "$PROJECT_ROOT/android/app/build/outputs/apk" -name '*.apk' -type f 2>/dev/null | sort | tail -n1 || true)"
if [ -n "$APK" ]; then
  ok "APK：$APK ($(du -h "$APK" | cut -f1))"
  if [ "$INSTALL" = "1" ] && need_cmd adb; then
    step "   安装到已连接的设备"
    adb install -r "$APK"
  else
    printf ' 安装命令： adb install -r %s\n' "$APK"
    printf ' 手机端验收： 打开 App → Settings → Local Network API Service（服务默认自动开启）\n'
    printf '            复制页面上的 Base URL，电脑上执行： curl -N http://<手机IP>:8080/v1/models\n'
  fi
else
  warn "没找到 APK，请查看日志：$LOG_DIR/gradle-build.log"
  exit 1
fi

printf '\n%s全部完成。日志目录：%s%s\n' "$C_OK" "$LOG_DIR" "$C_RESET"
