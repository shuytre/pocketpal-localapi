<#
.SYNOPSIS
    PocketPal · 局域网 API 服务 + 调度调优版 —— Windows 一键编译脚本

.DESCRIPTION
    检查依赖 → 用国内镜像安装缺失项 → 编译出可安装的 APK（默认 release / arm64-v8a）。

    依赖与镜像：
      JDK 17        → 清华 Adoptium 镜像（自动挑最新 17.x）
      Node ≥22.21   → npmmirror 二进制镜像
      yarn / npm 包 → npmmirror registry
      Gradle 分发   → 腾讯云镜像（官方 services.gradle.org 在国内常超时）
      Maven 构件    → 可选（-UseMavenMirror 走阿里云，默认直连 google/central）
      Android SDK   → dl.google.com（国内可直连），组件版本与 android/build.gradle 严格一致

.PARAMETER SkipDeps
    跳过 Node / yarn / npm 依赖安装
.PARAMETER SkipSdk
    跳过 Android SDK / NDK / CMake 安装
.PARAMETER SkipBuild
    跳过编译（只做检查与配置，适合先验证环境）
.PARAMETER Abi
    目标 ABI，默认 arm64-v8a（红米 K20 等真机）。多个用逗号：arm64-v8a,x86_64
.PARAMETER Variant
    release（默认，可独立安装）或 debug（需要 Metro 服务器才能跑）
.PARAMETER Install
    编完自动 adb install（手机会被要求先卸载旧包，见下方说明）
.PARAMETER UseMavenMirror
    给 Gradle 注入阿里云 Maven 镜像（国内加速，默认关闭）
.PARAMETER SdkRoot
    指定 Android SDK 目录；不填则依次尝试 local.properties / 环境变量 / %LOCALAPPDATA%\Android\Sdk
.PARAMETER ForceContinue
    即使检测到「Windows 长路径未开启」也继续（构建大概会在 ninja 阶段失败）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\one-click-windows-build.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\one-click-windows-build.ps1 -SkipDeps -Install

.NOTES
    仅用于学术研究，禁止用于非法用途。
#>
[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [switch]$SkipSdk,
    [switch]$SkipBuild,
    [string]$Abi = 'arm64-v8a',
    [ValidateSet('release', 'debug')]
    [string]$Variant = 'release',
    [switch]$Install,
    [switch]$UseMavenMirror,
    [string]$SdkRoot = '',
    [string]$NodeVersion = '22.21.0',
    [switch]$ForceContinue
)

# 这里刻意用 Continue 而不是 Stop：java -version / sdkmanager / yarn / gradlew / adb
# 都会往 stderr 写正常信息，在 Stop 模式下 PowerShell 会把它当成终止错误，
# 脚本会在「检查 JDK」这一步直接死掉（本机实测踩过）。致命条件一律用 Stop-Script 显式退出。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ───────────────────────── 常量：与 android/build.gradle 必须一致 ────────────
$NDK_VERSION          = '27.3.13750724'
$PLATFORM_VERSION     = 'android-36'
$BUILD_TOOLS_VERSION  = '36.0.0'
$CMAKE_VERSION        = '3.22.1'
$CMDLINE_TOOLS_BUILD  = '13114758'
$CMDLINE_TOOLS_ALT    = @('12266719', '11076708')

$NPM_REGISTRY     = 'https://registry.npmmirror.com'
$NODE_MIRROR      = 'https://cdn.npmmirror.com/binaries/node'
$ADOPTIUM_MIRROR  = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk'
$GRADLE_MIRROR    = 'https://mirrors.cloud.tencent.com/gradle'

$ProjectRoot = $PSScriptRoot
$LogDir      = Join-Path $ProjectRoot 'build-logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$CurlExe = Join-Path $env:SystemRoot 'System32\curl.exe'

# ───────────────────────── 输出工具 ─────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "   [!]  $msg" -ForegroundColor Yellow }
function Write-Err2($msg)  { Write-Host "   [X]  $msg" -ForegroundColor Red }
function Stop-Script($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Download($url, $dest) {
    # 注意不要用 $args 当变量名：它是 PowerShell 的自动变量。
    $curlArgs = @('-fL', '--retry', '3', '--connect-timeout', '20', '-o', $dest, $url)
    if (Test-Path $CurlExe) {
        & $CurlExe @curlArgs
        return ($LASTEXITCODE -eq 0) -and (Test-Path $dest)
    }
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return (Test-Path $dest) }
    catch { return $false }
}

function Expand-ZipFast($zip, $dest) {
    # Windows 10 1803+ 自带 bsdtar，比 Expand-Archive 快得多（190MB 的 JDK 差距很明显）
    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        & $tar.Source -xf $zip -C $dest
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    try { Expand-Archive -Path $zip -DestinationPath $dest -Force; return $true }
    catch { return $false }
}

function Get-JavaMajor($javaExe) {
    if (-not $javaExe -or -not (Test-Path $javaExe)) { return 0 }
    $out = & $javaExe -version 2>&1 | Out-String
    $m = [regex]::Match($out, 'version "(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return 0
}

function Get-CommandPath($name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

# ───────────────────────── 0. 环境检查 ──────────────────────────────────────
Write-Step '0/9 环境检查'

if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
    Stop-Script "当前目录不像工程根目录（找不到 package.json）：$ProjectRoot"
}
if (-not (Test-Path (Join-Path $ProjectRoot 'android'))) {
    Stop-Script '找不到 android/ 目录'
}
Write-Ok "工程根目录：$ProjectRoot"

if ($ProjectRoot.Length -gt 60) {
    Write-Warn2 "工程路径偏长（$($ProjectRoot.Length) 字符）。Windows 的 260 字符限制是按完整路径算的，"
    Write-Warn2 '  建议把工程挪到更短的根目录（例如 C:\p\PocketPal），能显著降低踩坑概率。'
}
if ($ProjectRoot -match '\s') {
    Write-Warn2 '工程路径包含空格，个别工具会出问题，建议改成无空格的路径。'
}

# Windows 长路径：这是本机唯一无法绕过的硬阻塞（实测对象路径 376 字符 > 260，
# ninja 直接报 "Filename longer than 260 characters"）。
$longPaths = 0
try {
    $longPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
        -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled
} catch { $longPaths = 0 }

if ($longPaths -ne 1) {
    Write-Warn2 'Windows 长路径支持未开启（LongPathsEnabled = 0）'
    if (Test-IsAdmin) {
        try {
            Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
                -Name LongPathsEnabled -Value 1 -Type DWord -ErrorAction Stop
            Write-Ok '已自动开启长路径（建议重启终端后重新运行本脚本以确保生效）'
            $longPaths = 1
        } catch {
            Write-Warn2 "自动开启失败：$($_.Exception.Message)"
        }
    }
    if ($longPaths -ne 1) {
        Write-Host ''
        Write-Host '   请用【管理员】PowerShell 执行下面这行，然后重开终端再跑本脚本：' -ForegroundColor Yellow
        Write-Host '     Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -Type DWord' -ForegroundColor White
        Write-Host ''
        Write-Warn2 '不开也不是立刻失败，但会在 CMake/ninja 编译原生库那一步报错（本机实测就是卡在这）。'
        if (-not $ForceContinue) {
            Stop-Script '已提前退出。确实想硬试：加 -ForceContinue'
        }
        Write-Warn2 '按 -ForceContinue 继续（预期会在 ninja 阶段失败）'
    }
} else {
    Write-Ok 'Windows 长路径支持已开启'
}

$osRamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Write-Ok "内存 ${osRamGB}GB / CPU $env:NUMBER_OF_PROCESSORS 核"

# ───────────────────────── 1. JDK 17 ────────────────────────────────────────
Write-Step '1/9 检查 JDK 17'

$javaHome = $env:JAVA_HOME
$javaExe = $null
if ($javaHome -and (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    $javaExe = Join-Path $javaHome 'bin\java.exe'
} else {
    $onPath = Get-CommandPath 'java'
    if ($onPath) { $javaExe = $onPath }
}

$javaMajor = Get-JavaMajor $javaExe
if ($javaMajor -eq 17) {
    $env:JAVA_HOME = (Split-Path (Split-Path $javaExe))
    Write-Ok "已有 JDK 17：$javaExe"
} else {
    if ($javaMajor -gt 0) {
        Write-Warn2 "当前 java 是 $javaMajor 版，AGP/Kotlin 需要 17（21/26 容易出兼容问题），改用 JDK 17"
    }
    $jdkDir = Join-Path $env:LOCALAPPDATA 'pocketpal-jdk17'
    $jdkExe = Join-Path $jdkDir 'bin\java.exe'
    $existing = Get-ChildItem $jdkDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
        Select-Object -First 1
    if ($existing) {
        $env:JAVA_HOME = $existing.FullName
        Write-Ok "复用已下载的 JDK 17：$($existing.FullName)"
    } else {
        if ($SkipDeps) { Stop-Script '缺少 JDK 17，而当前指定了 -SkipDeps（请先手动装好 JDK 17）' }
        $arch = 'x64'
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'aarch64' }
        $archUrl = "$ADOPTIUM_MIRROR/$arch/windows/"
        Write-Ok "从清华 Adoptium 镜像查询最新 17.x：$archUrl"
        $listing = & $CurlExe -s --max-time 60 $archUrl
        $zips = [regex]::Matches($listing, 'OpenJDK17U-jdk_' + $arch + '_windows_hotspot_[0-9._]+\.zip') |
            ForEach-Object { $_.Value } | Sort-Object -Unique
        $zipName = $zips | Select-Object -Last 1
        if (-not $zipName) { Stop-Script "镜像上找不到 JDK 17 包，请手动安装 JDK 17 并设置 JAVA_HOME" }
        $zipPath = Join-Path $env:TEMP $zipName
        Write-Ok "下载 $zipName（约 190MB）"
        if (-not (Invoke-Download "$archUrl$zipName" $zipPath)) {
            Stop-Script 'JDK 下载失败。可手动装 JDK 17 后重跑本脚本。'
        }
        if (-not (Expand-ZipFast $zipPath $jdkDir)) { Stop-Script 'JDK 解压失败' }
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        $existing = Get-ChildItem $jdkDir -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
            Select-Object -First 1
        if (-not $existing) { Stop-Script '解压后找不到 bin\java.exe' }
        $env:JAVA_HOME = $existing.FullName
        Write-Ok "JDK 17 就绪：$($env:JAVA_HOME)"
    }
}
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
Write-Ok "JAVA_HOME=$env:JAVA_HOME"

# ───────────────────────── 2. Node + yarn ───────────────────────────────────
Write-Step '2/9 检查 Node.js（需 ≥22.21）与 yarn'

function Get-NodeOk {
    $nodeExe = Get-CommandPath 'node'
    if (-not $nodeExe) { return $null }
    $v = (& $nodeExe -v) -replace '^v', ''
    $parts = $v.Split('.')
    if ([int]$parts[0] -gt 22) { return $nodeExe }
    if ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 21) { return $nodeExe }
    return $null
}

$nodeExe = Get-NodeOk
if ($nodeExe) {
    Write-Ok "已有 Node $(& $nodeExe -v)"
} else {
    if ($SkipDeps) { Stop-Script '缺少 Node ≥22.21，而当前指定了 -SkipDeps' }
    $nodeArch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $nodeArch = 'arm64' }
    $nodeDir = Join-Path $env:LOCALAPPDATA "pocketpal-node-$NodeVersion-$nodeArch"
    $nodeExe = Join-Path $nodeDir "node-v$NodeVersion-win-$nodeArch\node.exe"
    if (-not (Test-Path $nodeExe)) {
        $url = "$NODE_MIRROR/v$NodeVersion/node-v$NodeVersion-win-$nodeArch.zip"
        $zip = Join-Path $env:TEMP "node-v$NodeVersion-win-$nodeArch.zip"
        Write-Ok "从 npmmirror 下载 Node：$url"
        if (-not (Invoke-Download $url $zip)) {
            Stop-Script 'Node 下载失败。可手动装 Node 22 后重跑（或加 -SkipDeps）。'
        }
        if (-not (Expand-ZipFast $zip $nodeDir)) { Stop-Script 'Node 解压失败' }
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $nodeExe)) { Stop-Script "解压后找不到 node.exe：$nodeExe" }
    Write-Ok "Node 就绪：$(& $nodeExe -v)"
}
$env:Path = "$(Split-Path $nodeExe);$env:Path"

# npm 在 PowerShell 里会被执行策略拦住（npm.ps1 禁止运行），一律走 npm.cmd
$npmCmd = Join-Path (Split-Path $nodeExe) 'npm.cmd'
if (-not (Test-Path $npmCmd)) { Stop-Script "找不到 npm.cmd：$npmCmd" }
& $npmCmd config set registry $NPM_REGISTRY | Out-Null
Write-Ok "npm registry = $(& $npmCmd config get registry)"

$yarnCmd = Get-CommandPath 'yarn'
if ($yarnCmd) {
    Write-Ok "已有 yarn $(& $yarnCmd -v)"
} else {
    if ($SkipDeps) { Stop-Script '缺少 yarn，而当前指定了 -SkipDeps' }
    Write-Ok "安装 yarn 1.x（走 npmmirror）"
    & $npmCmd install -g yarn@1.22.22 --registry=$NPM_REGISTRY | Out-Null
    $candidate = Join-Path $env:APPDATA 'npm\yarn.cmd'
    if (Test-Path $candidate) {
        $yarnCmd = $candidate
        $env:Path = "$(Split-Path $candidate);$env:Path"
    } else {
        $yarnCmd = Get-CommandPath 'yarn'
    }
    if (-not $yarnCmd) { Stop-Script 'yarn 安装后仍找不到，请手动 npm i -g yarn' }
    Write-Ok "yarn $(& $yarnCmd -v) 就绪"
}

# ───────────────────────── 3. Android SDK / NDK ─────────────────────────────
Write-Step '3/9 检查 Android SDK / NDK / CMake'

# 解析 SDK 目录：参数 > local.properties > 环境变量 > 默认位置
if (-not $SdkRoot) {
    $lpPath = Join-Path $ProjectRoot 'android\local.properties'
    if (Test-Path $lpPath) {
        $m = [regex]::Match((Get-Content $lpPath -Raw), 'sdk\.dir\s*=\s*(.+)')
        if ($m.Success) {
            # properties 里的路径是转义过的（D\:\\Android\\sdk）。这里连续做两轮
            # 「双反斜杠 -> 单反斜杠」，好让被重复转义过的文件也能纠回来。
            # 注意：PowerShell 的 -replace 替换串中反斜杠是**字面量**（只有 $ 有特殊含义），
            # 所以这里写 '\\' 就是「两个反斜杠」，不是「一个」。
            $candidate = $m.Groups[1].Value.Trim()
            $candidate = $candidate -replace '\\\\', '\'
            $candidate = $candidate -replace '\\\\', '\'
            $candidate = $candidate -replace '\\:', ':'
            if (Test-Path $candidate) { $SdkRoot = $candidate }
        }
    }
}
if (-not $SdkRoot -and $env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) { $SdkRoot = $env:ANDROID_HOME }
if (-not $SdkRoot -and $env:ANDROID_SDK_ROOT -and (Test-Path $env:ANDROID_SDK_ROOT)) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
Write-Ok "SDK 目录：$SdkRoot"

$sdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkManager)) {
    if ($SkipSdk) { Stop-Script '缺少 cmdline-tools，而当前指定了 -SkipSdk' }
    Write-Ok '下载 cmdline-tools（Windows 版）'
    $ok = $false
    foreach ($build in @($CMDLINE_TOOLS_BUILD) + $CMDLINE_TOOLS_ALT) {
        $url = "https://dl.google.com/android/repository/commandlinetools-win-${build}_latest.zip"
        $zip = Join-Path $env:TEMP 'cmdline-tools.zip'
        Write-Ok "  尝试 $url"
        if (Invoke-Download $url $zip) { $ok = $true; break }
        Write-Warn2 '  该版本失败，换下一个候选'
    }
    if (-not $ok) { Stop-Script 'cmdline-tools 下载失败：请确认能访问 dl.google.com' }
    $tmp = Join-Path $env:TEMP 'cmdline-tools-x'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Expand-ZipFast (Join-Path $env:TEMP 'cmdline-tools.zip') $tmp)) { Stop-Script 'cmdline-tools 解压失败' }
    $latestDir = Join-Path $SdkRoot 'cmdline-tools\latest'
    Remove-Item $latestDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Split-Path $latestDir) -Force | Out-Null
    Move-Item (Join-Path $tmp 'cmdline-tools') $latestDir
    Write-Ok 'cmdline-tools 就绪'
} else {
    Write-Ok '已有 cmdline-tools'
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:ANDROID_NDK_HOME = Join-Path $SdkRoot "ndk\$NDK_VERSION"
$env:Path = "$SdkRoot\platform-tools;$SdkRoot\cmdline-tools\latest\bin;$env:Path"

if (-not $SkipSdk) {
    Write-Ok '接受 SDK 许可协议'
    $yes = 1..60 | ForEach-Object { 'y' }
    $yes | & $sdkManager --sdk_root="$SdkRoot" --licenses 2>&1 | Out-Null

    Write-Ok '安装/校验 SDK 组件（versions 与 android/build.gradle 一致）'
    & $sdkManager --sdk_root="$SdkRoot" `
        'platform-tools' `
        "platforms;$PLATFORM_VERSION" `
        "build-tools;$BUILD_TOOLS_VERSION" `
        "ndk;$NDK_VERSION" `
        "cmake;$CMAKE_VERSION"
    if ($LASTEXITCODE -ne 0) { Stop-Script 'SDK 组件安装失败，请看上面的 sdkmanager 输出' }
    Write-Ok 'SDK 组件就绪'
}

# ───────────────────────── 4. 工程配置文件 ──────────────────────────────────
Write-Step '4/9 写入工程配置'

$lpPath = Join-Path $ProjectRoot 'android\local.properties'
# AGP 优先读 local.properties，路径不对会直接构建失败，所以每次覆盖写。
# 用 .NET 的 String.Replace（纯字面替换）：-replace 是正则替换，反斜杠行为容易搞错，
# 本机实测就被它坑过一次（1 个反斜杠变成 4 个，导致 AGP 找不到 SDK）。
$escapedSdk = $SdkRoot.Replace('\', '\\').Replace(':', '\:')
Set-Content -Path $lpPath -Value "sdk.dir=$escapedSdk" -Encoding ASCII
Write-Ok "local.properties：sdk.dir=$escapedSdk"

$gsPath = Join-Path $ProjectRoot 'android\app\google-services.json'
if (-not (Test-Path $gsPath)) {
    Write-Warn2 '缺少 google-services.json，写入占位文件（构建能过；Firebase 可选功能会静默失效）'
    $placeholder = @'
{"project_info":{"project_number":"000000000000","project_id":"pocketpal-local","storage_bucket":"pocketpal-local.appspot.com"},
"client":[{"client_info":{"mobilesdk_app_id":"1:000000000000:android:0000000000000000","android_client_info":{"package_name":"com.pocketpalai"}},
"oauth_client":[],"api_key":[{"current_key":"AIzaSyLocalBuildPlaceholderKey000000000000000"}],
"services":{"analytics_service":{"status":1},"appinvite_service":{"status":1,"other_platform_oauth_client":[]},"ads_service":{"status":2}}}],
"configuration_version":"1"}
'@
    Set-Content -Path $gsPath -Value $placeholder -Encoding UTF8
} else {
    Write-Ok 'google-services.json 已存在（占位文件的话，发布前请换成真实配置）'
}

# ───────────────────────── 5. JS 依赖 ──────────────────────────────────────
Write-Step '5/9 安装 JS 依赖'
if ($SkipDeps) {
    Write-Ok '跳过（-SkipDeps）'
} elseif (Test-Path (Join-Path $ProjectRoot 'node_modules\.yarn-integrity')) {
    Write-Ok 'node_modules 已完整（存在 .yarn-integrity），跳过 yarn install'
} else {
    Write-Ok 'yarn install（必须用 yarn：npm 会因 react-native-windows 的 peer 冲突 ERESOLVE 失败）'
    Push-Location $ProjectRoot
    try {
        & $yarnCmd install --non-interactive --network-timeout 600000 --registry $NPM_REGISTRY 2>&1 |
            Tee-Object -FilePath (Join-Path $LogDir 'yarn-install.log')
        if ($LASTEXITCODE -ne 0) { Stop-Script 'yarn install 失败，见 build-logs\yarn-install.log' }
        Write-Ok '依赖安装完成'
        $pp = Join-Path $ProjectRoot 'node_modules\.bin\patch-package.cmd'
        if (Test-Path $pp) {
            Write-Ok '应用 patches/ 补丁（patch-package）'
            & $pp 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'patch-package.log') -Append
        }
    } finally { Pop-Location }
}

# ───────────────────────── 6. Gradle 分发镜像 ───────────────────────────────
Write-Step '6/9 检查 Gradle 分发'
$wrapperProps = Join-Path $ProjectRoot 'android\gradle\wrapper\gradle-wrapper.properties'
if (-not (Test-Path $wrapperProps)) { Stop-Script "找不到 $wrapperProps" }
$wrapperText = Get-Content $wrapperProps -Raw
$distVersion = '9.0.0'
$mv = [regex]::Match($wrapperText, 'gradle-([\d.]+)-bin\.zip')
if ($mv.Success) { $distVersion = $mv.Groups[1].Value }

$officialOk = $false
if (Test-Path $CurlExe) {
    # 只做 HEAD 不够：services.gradle.org 会 307 跳转，而真正的下载域名在国内常超时。
    # 这里跟跳转、并且真的开一个 1 字节的范围请求，才算「可达」。
    $probe = & $CurlExe -s -o NUL -w '%{http_code}' --max-time 12 -L `
        "https://services.gradle.org/distributions/gradle-$distVersion-bin.zip" -r 0-0 2>$null
    if ($probe -eq '200' -or $probe -eq '206') { $officialOk = $true }
    else { Write-Warn2 "官方 Gradle 源探测返回：$probe" }
}
if ($officialOk) {
    Write-Ok "官方源可达，沿用现有 distributionUrl（Gradle $distVersion）"
} else {
    $mirrorUrl = "$GRADLE_MIRROR/gradle-$distVersion-bin.zip"
    Write-Warn2 "官方源 services.gradle.org 不可达（国内常见），改用腾讯云镜像：$mirrorUrl"
    $backup = "$wrapperProps.orig"
    if (-not (Test-Path $backup)) { Copy-Item $wrapperProps $backup }
    $newText = [regex]::Replace($wrapperText, '(?m)^distributionUrl=.*$', "distributionUrl=$mirrorUrl")
    # 换了镜像就别再校验官方 sha256，否则必然失败
    $newText = [regex]::Replace($newText, '(?m)^distributionSha256Sum=.*\r?\n?', '')
    Set-Content -Path $wrapperProps -Value $newText -Encoding ASCII
    Write-Ok "已改写 distributionUrl（原文件备份在 gradle-wrapper.properties.orig）"
}

$mavenInitArgs = @()
if ($UseMavenMirror) {
    $initPath = Join-Path $LogDir 'maven-mirror.init.gradle'
    @'
// 阿里云 Maven 镜像（国内加速）。放在官方仓库之前，命中不了会自动回落到 google()/mavenCentral()。
allprojects {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/public' }
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
        google()
        mavenCentral()
    }
}
settingsEvaluated { settings ->
    settings.pluginManagement.repositories {
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/public' }
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}
'@ | Set-Content -Path $initPath -Encoding ASCII
    $mavenInitArgs = @('--init-script', $initPath)
    Write-Ok "已启用阿里云 Maven 镜像：$initPath"
}

# ───────────────────────── 7. 编译 ─────────────────────────────────────────
$taskName = "assembleProdRelease"
if ($Variant -eq 'debug') { $taskName = 'assembleProdDebug' }

if ($SkipBuild) {
    Write-Step '7/9 跳过编译（-SkipBuild）'
} else {
    Write-Step "7/9 编译（$taskName，ABI=$Abi）"
    # Metro 打包默认堆约 2GB，在 8GB 以下的机器上会在 createBundle*JsAndAssets 阶段 OOM。
    if ($osRamGB -lt 8) {
        $nodeHeap = 3072
        $gradleHeap = 1536
        Write-Warn2 "内存 ${osRamGB}GB 偏小：Node 堆设 ${nodeHeap}MB、Gradle 堆设 ${gradleHeap}MB（会走页面文件，慢但不至于失败）"
    } else {
        $nodeHeap = 6144
        $gradleHeap = 4096
    }
    $env:NODE_OPTIONS = "--max-old-space-size=$nodeHeap"
    $env:GRADLE_OPTS = "-Dorg.gradle.jvmargs=-Xmx${gradleHeap}m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8"
    Write-Ok "NODE_OPTIONS=$env:NODE_OPTIONS"
    Write-Ok "GRADLE_OPTS=$env:GRADLE_OPTS"

    Push-Location (Join-Path $ProjectRoot 'android')
    try {
        $gradleArgs = @($taskName, "-PreactNativeArchitectures=$Abi", '--console=plain') + $mavenInitArgs
        & '.\gradlew.bat' @gradleArgs 2>&1 |
            Tee-Object -FilePath (Join-Path $LogDir 'gradle-build.log')
        if ($LASTEXITCODE -ne 0) {
            Write-Err2 "构建失败，完整日志：$LogDir\gradle-build.log"
            Write-Err2 '常见原因：① 长路径未开启（ninja: Filename longer than 260 characters）'
            Write-Err2 '          ② 内存不足（JavaScript heap out of memory）→ 关掉占内存的程序重跑'
            exit 1
        }
        Write-Ok '构建完成'
    } finally { Pop-Location }
}

# ───────────────────────── 8. 产物 ─────────────────────────────────────────
Write-Step '8/9 产物'
$apkRoot = Join-Path $ProjectRoot 'android\app\build\outputs\apk'
$apk = $null
if (-not $SkipBuild -and (Test-Path $apkRoot)) {
    $apk = Get-ChildItem $apkRoot -Recurse -Filter '*.apk' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
}
if ($SkipBuild) {
    Write-Ok '本次是 -SkipBuild，只做了检查/配置，没有产出 APK（这是预期的）'
    Write-Ok '环境没问题的话，去掉 -SkipBuild 重跑即可开始编译。'
} elseif ($apk) {
    Write-Ok ("APK：{0} ({1:N1} MB)" -f $apk.FullName, ($apk.Length / 1MB))
    $adb = Join-Path $SdkRoot 'platform-tools\adb.exe'
    if ($Install -and (Test-Path $adb)) {
        Write-Step '9/9 安装到已连接设备'
        & $adb install -r $apk.FullName
    } else {
        Write-Host ''
        Write-Host '   安装：' -NoNewline
        Write-Host ("`"$adb`" install -r `"$($apk.FullName)`"") -ForegroundColor White
        Write-Host '   注意：换机器编译 = 换 debug 签名，覆盖安装会报 INSTALL_FAILED_UPDATE_INCOMPATIBLE，' -ForegroundColor Yellow
        Write-Host '         先执行 adb uninstall com.pocketpalai 再装（或自己配一个固定的 release keystore）。' -ForegroundColor Yellow
    }
} else {
    Write-Warn2 "没找到 APK，请查看 $LogDir\gradle-build.log"
}

Write-Host ''
Write-Host '完成。手机端：打开 App → Settings → Local Network API Service（服务默认自动开启），' -ForegroundColor Green
Write-Host '复制页面上的 Base URL，电脑上执行：curl -N http://<手机IP>:8080/v1/models' -ForegroundColor Green
Write-Host "日志目录：$LogDir" -ForegroundColor Green
