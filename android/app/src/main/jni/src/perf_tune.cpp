// perf_tune.cpp — 调度与内存驻留调优的 JNI 实现。
//
// 这些调用全部落在「同一个进程的线程」上，因此大部分不需要任何特权：
//
//   * sched_setaffinity   —— 内核只校验 pid 是否属于调用者。这是未 root 的
//                            Android 上唯一能真正改变线程跑在哪个核上的机制。
//   * 抬升 rlimit 软限      —— 软限 ≤ 硬限的抬升永远允许（唯一的例外是反过来降）。
//   * 上调 nice（让路）    —— 把自己变差永远允许；变好才要 CAP_SYS_NICE。
//   * sched_setscheduler  —— 需要 CAP_SYS_NICE，未 root 必然失败；做成显式开关，
//                            默认关闭（RT 线程会抢占整个核，网络+UI 并发下反而更糟）。
//
// 设计准则（对应需求「必须区分请求值和实际生效值」）：
// 每个 setter 之后都由调用方回读，Java 侧把「请求值 / 下探到哪一级 / 实际值」
// 一并返回给 UI。这里只做「尝试」，绝不假设成功。

#include <jni.h>

#include <android/log.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <map>
#include <string>
#include <vector>

#ifndef RLIMIT_NICE
#define RLIMIT_NICE 13
#endif
#ifndef RLIMIT_MEMLOCK
#define RLIMIT_MEMLOCK 8
#endif
// 失败哨兵：合法的 nice 在 [-20,19]、亲和掩码索引 >=0，所以负数可安全用作信号。
#define PT_ERR (-1000)

#define PT_LOG_TAG "PocketPalPerfTune"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, PT_LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, PT_LOG_TAG, __VA_ARGS__)

namespace {

struct Mapping {
  void *addr = nullptr;   // mmap 返回的地址
  size_t length = 0;      // 映射长度
  bool valid = false;     // mmap 是否成功
};

// 已 lock 的模型文件映射。
//
// 为什么要长期持有：munmap 会同时释放这块地址上的 mlock 计数。若为了「省内存」
// 在 lock 之后立刻 munmap，锁定会被内核撤销 —— 页面上会立刻又被换出，等于什么
// 都没做。所以必须按路径登记，卸载模型时再显式释放。
std::map<std::string, Mapping> g_lockedFiles;

// tid 取 gettid。Android 的 gettid() 直到较新 API 才导出，直接走 syscall 最稳。
int currentTid() {
  return static_cast<int>(syscall(__NR_gettid));
}

int resolveTid(jint targetTid) {
  return targetTid > 0 ? targetTid : 0;
}

int writeFile(const char *path, const std::string &content) {
  int fd = ::open(path, O_WRONLY);
  if (fd < 0) {
    return -errno;
  }
  const char *buf = content.c_str();
  size_t left = content.size();
  while (left > 0) {
    ssize_t n = ::write(fd, buf, left);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      int err = -errno;
      ::close(fd);
      return err;
    }
    buf += n;
    left -= static_cast<size_t>(n);
  }
  ::close(fd);
  return 0;
}

std::string readTrimmedFile(const char *path) {
  int fd = ::open(path, O_RDONLY);
  if (fd < 0) {
    return std::string();
  }
  std::string out;
  char tmp[64];
  while (true) {
    ssize_t n = ::read(fd, tmp, sizeof(tmp));
    if (n > 0) {
      out.append(tmp, static_cast<size_t>(n));
      continue;
    }
    if (n < 0 && errno == EINTR) {
      continue;
    }
    break;
  }
  ::close(fd);
  size_t end = out.find_last_not_of(" \t\r\n");
  if (end == std::string::npos) {
    return std::string();
  }
  return out.substr(0, end + 1);
}

void fillCpuSet(cpu_set_t *set, const std::vector<int> &cpus) {
  CPU_ZERO(set);
  for (int cpu : cpus) {
    if (cpu >= 0 && cpu < CPU_SETSIZE) {
      CPU_SET(static_cast<size_t>(cpu), set);
    }
  }
}

std::vector<int> readCpuSet(const cpu_set_t *set) {
  std::vector<int> out;
  for (int i = 0; i < CPU_SETSIZE; i++) {
    if (CPU_ISSET(static_cast<size_t>(i), set)) {
      out.push_back(i);
    }
  }
  return out;
}

std::vector<std::string> javaStringArray(JNIEnv *env, jobjectArray arr) {
  std::vector<std::string> out;
  if (arr == nullptr) {
    return out;
  }
  jsize len = env->GetArrayLength(arr);
  for (jsize i = 0; i < len; i++) {
    jstring str = reinterpret_cast<jstring>(env->GetObjectArrayElement(arr, i));
    if (str == nullptr) {
      continue;
    }
    const char *chars = env->GetStringUTFChars(str, nullptr);
    if (chars != nullptr) {
      out.emplace_back(chars);
      env->ReleaseStringUTFChars(str, chars);
    }
    env->DeleteLocalRef(str);
  }
  return out;
}

std::vector<int> javaIntArray(JNIEnv *env, jintArray arr) {
  std::vector<int> out;
  if (arr == nullptr) {
    return out;
  }
  jsize len = env->GetArrayLength(arr);
  jint *values = env->GetIntArrayElements(arr, nullptr);
  if (values != nullptr) {
    for (jsize i = 0; i < len; i++) {
      out.push_back(values[i]);
    }
    env->ReleaseIntArrayElements(arr, values, JNI_ABORT);
  }
  return out;
}

jdoubleArray toDoubleArray(JNIEnv *env, const std::vector<double> &values) {
  jsize len = static_cast<jsize>(values.size());
  jdoubleArray out = env->NewDoubleArray(len);
  if (out == nullptr || len == 0) {
    return out;
  }
  env->SetDoubleArrayRegion(out, 0, len, values.data());
  return out;
}

jintArray toIntArray(JNIEnv *env, const std::vector<int> &values) {
  jsize len = static_cast<jsize>(values.size());
  jintArray out = env->NewIntArray(len);
  if (out == nullptr || len == 0) {
    return out;
  }
  env->SetIntArrayRegion(out, 0, len, values.data());
  return out;
}

int setThreadAffinity(int tid, const std::vector<int> &cpus) {
  if (cpus.empty()) {
    return -EINVAL;
  }
  cpu_set_t set;
  fillCpuSet(&set, cpus);
  return ::sched_setaffinity(static_cast<pid_t>(tid), sizeof(cpu_set_t), &set);
}

std::vector<int> getThreadAffinity(int tid) {
  cpu_set_t set;
  CPU_ZERO(&set);
  if (::sched_getaffinity(static_cast<pid_t>(tid), sizeof(cpu_set_t), &set) < 0) {
    LOGE("sched_getaffinity(%d) failed errno=%d", tid, errno);
    return std::vector<int>();
  }
  return readCpuSet(&set);
}

int setThreadNice(int tid, int niceValue) {
  // PRIO_PROCESS + tid 组合在系统调用层面等价于「按线程设置」。
  long rc = ::syscall(__NR_setpriority, PRIO_PROCESS, tid, niceValue);
  return rc < 0 ? static_cast<int>(-errno) : 0;
}

int getThreadNice(int tid) {
  errno = 0;
  int val = ::getpriority(PRIO_PROCESS, static_cast<id_t>(tid));
  if (val == -1 && errno != 0) {
    LOGE("getpriority(%d) failed errno=%d", tid, errno);
    return PT_ERR;
  }
  return val;
}

struct ThreadEntry {
  int tid = 0;
  std::string name;
};

std::vector<ThreadEntry> listProcessThreads() {
  std::vector<ThreadEntry> out;
  DIR *dir = ::opendir("/proc/self/task");
  if (dir == nullptr) {
    LOGE("opendir(/proc/self/task) failed errno=%d", errno);
    return out;
  }
  while (true) {
    struct dirent *entry = ::readdir(dir);
    if (entry == nullptr) {
      break;
    }
    if (entry->d_type != DT_DIR) {
      // 兼容某些不肯填 d_type 的 /proc 实现。
      if (entry->d_type != DT_UNKNOWN) {
        continue;
      }
    }
    int tid = ::atoi(entry->d_name);
    if (tid <= 0) {
      continue;
    }
    std::string path = std::string("/proc/self/task/") + entry->d_name + "/comm";
    std::string name = readTrimmedFile(path.c_str());
    out.push_back({tid, name});
  }
  ::closedir(dir);
  return out;
}

bool prefixMatches(const std::string &name, const std::vector<std::string> &prefixes) {
  for (const std::string &prefix : prefixes) {
    if (name.rfind(prefix, 0) == 0) {
      return true;
    }
  }
  return false;
}

}  // namespace

extern "C" {

// ── CPU 亲和性 ───────────────────────────────────────────────────────────
//
// tid <= 0 表示「调用线程自身」。这里保留两级请求形态：
//   1) 先用 pid=0 请求；
//   2) 失败后用显式 gettid() 再请求一次。
// 两者失败的含义完全不同：前者可能是厂商内核对 pid=0 形态不兼容，
// 后者才是「内核真的不允许」。不区分会让排查方向整体跑偏。
JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeSetThreadAffinity(
    JNIEnv *env, jobject /* thiz */, jintArray cpuArray, jint targetTid) {
  std::vector<int> cpus = javaIntArray(env, cpuArray);
  if (cpus.empty()) {
    return PT_ERR;
  }
  int tid = resolveTid(targetTid);
  int rc = setThreadAffinity(tid, cpus);
  if (rc < 0 && tid == 0) {
    int err = -errno;
    // 兜底路径：显式 tid 再试一次。
    rc = setThreadAffinity(currentTid(), cpus);
    if (rc < 0) {
      LOGE("setaffinity failed both forms, first errno=%d", err);
      return -errno;
    }
    return 0;
  }
  return rc < 0 ? -errno : 0;
}

// 回读亲和掩码 —— UI 上显示的必须是「内核现在给的值」，不是我们请求的值。
JNIEXPORT jintArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeGetThreadAffinity(
    JNIEnv *env, jobject /* thiz */, jint targetTid) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  return toIntArray(env, getThreadAffinity(tid));
}

// ── nice / 调度策略 ──────────────────────────────────────────────────────
JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeSetThreadNice(
    JNIEnv * /* env */, jobject /* thiz */, jint targetTid, jint niceValue) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  return setThreadNice(tid, niceValue);
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeGetThreadNice(
    JNIEnv * /* env */, jobject /* thiz */, jint targetTid) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  return getThreadNice(tid);
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeSetThreadScheduler(
    JNIEnv * /* env */, jobject /* thiz */, jint targetTid, jint policy,
    jint priority) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  struct sched_param param;
  memset(&param, 0, sizeof(param));
  param.sched_priority = priority;
  if (::sched_setscheduler(static_cast<pid_t>(tid), policy, &param) < 0) {
    int err = -errno;
    LOGE("sched_setscheduler policy=%d failed errno=%d", policy, errno);
    return err;
  }
  return 0;
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeGetThreadScheduler(
    JNIEnv * /* env */, jobject /* thiz */, jint targetTid) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  int policy = ::sched_getscheduler(static_cast<pid_t>(tid));
  if (policy < 0) {
    return PT_ERR;
  }
  return policy;
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeGetThreadRtPriority(
    JNIEnv * /* env */, jobject /* thiz */, jint targetTid) {
  int tid = resolveTid(targetTid);
  if (tid == 0) {
    tid = currentTid();
  }
  struct sched_param param;
  memset(&param, 0, sizeof(param));
  if (::sched_getparam(static_cast<pid_t>(tid), &param) < 0) {
    return PT_ERR;
  }
  return param.sched_priority;
}

// ── rlimit ──────────────────────────────────────────────────────────────
//
// RLIMIT_NICE 的语义极易写错：
//   允许的最低 nice = 20 - cur
//   cur= 0 → 最低 nice 20（连默认的 0 都提不上去，Android 应用常态）
//   cur=20 → 最低 nice 0
//   cur=40 → 最低 nice -20
// 软限抬到硬限不需要特权，所以这一层必须先把 lifted-after 报出来。
JNIEXPORT jdoubleArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeGetRlimit(
    JNIEnv *env, jobject /* thiz */, jint resource) {
  struct rlimit limit;
  std::vector<double> out(3, 0.0);
  if (::getrlimit(resource, &limit) < 0) {
    out[0] = PT_ERR;
    out[1] = PT_ERR;
    out[2] = 0.0;
    return toDoubleArray(env, out);
  }
  out[0] = limit.rlim_cur == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_cur);
  out[1] = limit.rlim_max == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_max);
  out[2] = 1.0;
  return toDoubleArray(env, out);
}

// 返回 {beforeSoft, beforeHard, afterSoft, afterHard, ok}。
JNIEXPORT jdoubleArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeRaiseRlimit(
    JNIEnv *env, jobject /* thiz */, jint resource) {
  struct rlimit limit;
  std::vector<double> out{PT_ERR, PT_ERR, PT_ERR, PT_ERR, 0.0};
  if (::getrlimit(resource, &limit) < 0) {
    return toDoubleArray(env, out);
  }
  out[0] = limit.rlim_cur == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_cur);
  out[1] = limit.rlim_max == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_max);

  if (limit.rlim_cur < limit.rlim_max) {
    limit.rlim_cur = limit.rlim_max;
    if (::setrlimit(resource, &limit) < 0) {
      LOGE("setrlimit(%d) failed errno=%d", resource, errno);
      out[2] = out[0];
      out[3] = out[1];
      out[4] = 0.0;
      return toDoubleArray(env, out);
    }
  }
  if (::getrlimit(resource, &limit) < 0) {
    return toDoubleArray(env, out);
  }
  out[2] = limit.rlim_cur == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_cur);
  out[3] = limit.rlim_max == RLIM_INFINITY ? -1.0 : static_cast<double>(limit.rlim_max);
  out[4] = 1.0;
  return toDoubleArray(env, out);
}

// ── oom_score_adj ───────────────────────────────────────────────────────
//
// 非 root 进程通常只能「上调」（更早被杀），下调会被内核拒绝。
// 所以这里返回的是回读值：写成功也要回读再报，绝不假设。
JNIEXPORT jdoubleArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeSetOomScoreAdj(
    JNIEnv *env, jobject /* thiz */, jint adj) {
  const char *path = "/proc/self/oom_score_adj";
  std::vector<double> out{static_cast<double>(adj), PT_ERR, PT_ERR, 0.0};
  std::string before = readTrimmedFile(path);
  if (!before.empty()) {
    out[1] = static_cast<double>(::atoi(before.c_str()));
  }
  int rc = writeFile(path, std::to_string(adj));
  std::string after = readTrimmedFile(path);
  if (!after.empty()) {
    out[2] = static_cast<double>(::atoi(after.c_str()));
  }
  out[3] = (rc == 0 && out[2] == out[0]) ? 1.0 : 0.0;
  if (rc != 0) {
    LOGE("write oom_score_adj failed rc=%d (expected: non-root cannot lower it)", rc);
  }
  return toDoubleArray(env, out);
}

// ── 线程清单与白名单绑定 ────────────────────────────────────────────────
//
// llama.cpp 各版本的线程命名并不一致（"ggml-graph"、"ggml_graph"、
// "llama-…"、甚至没有前缀）。所以我们同时提供：
//   * listThreads —— 纯观察，产出 "tid:name" 快照；排查「到底绑到了谁」时，
//     当前缀匹配不到任何东西时这是唯一依据。
//   * bindThreadsByPrefix —— 白名单绑定。
// 白名单而非黑名单的理由：把 RenderThread / mqt_js 之类拉到大核，它们会和推理
// 抢同一簇，结果比完全不绑更糟。宁可漏绑。
JNIEXPORT jobjectArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeListThreads(JNIEnv *env,
                                                         jobject /* thiz */) {
  std::vector<ThreadEntry> entries = listProcessThreads();
  jclass stringClass = env->FindClass("java/lang/String");
  jobjectArray out = env->NewObjectArray(static_cast<jsize>(entries.size()),
                                         stringClass, nullptr);
  for (size_t i = 0; i < entries.size(); i++) {
    std::string line = std::to_string(entries[i].tid) + ":" + entries[i].name;
    env->SetObjectArrayElement(out, static_cast<jsize>(i),
                               env->NewStringUTF(line.c_str()));
  }
  return out;
}

// 返回 {matched, bound, failed}。
JNIEXPORT jintArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeBindThreadsByPrefix(
    JNIEnv *env, jobject /* thiz */, jobjectArray prefixes,
    jintArray cpuArray) {
  std::vector<std::string> prefixList = javaStringArray(env, prefixes);
  std::vector<int> cpus = javaIntArray(env, cpuArray);
  std::vector<int> out{0, 0, 0};
  if (prefixList.empty() || cpus.empty()) {
    return toIntArray(env, out);
  }
  cpu_set_t set;
  fillCpuSet(&set, cpus);

  std::vector<ThreadEntry> entries = listProcessThreads();
  for (const ThreadEntry &entry : entries) {
    if (entry.name.empty() || !prefixMatches(entry.name, prefixList)) {
      continue;
    }
    out[0] += 1;
    if (::sched_setaffinity(static_cast<pid_t>(entry.tid), sizeof(cpu_set_t),
                            &set) < 0) {
      out[2] += 1;
      LOGE("bind tid=%d (%s) failed errno=%d", entry.tid, entry.name.c_str(),
           errno);
    } else {
      out[1] += 1;
    }
  }
  return toIntArray(env, out);
}

// 后台线程让路：给自己之外的线程加正 nice —— 把自己变差永远允许。
// 只对白名单前缀生效，绝不能碰 RN 线程：推理本身跑在 JS/原生线程上，
// 给它降优先级会直接拖慢推理。
JNIEXPORT jintArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeYieldThreadsByPrefix(
    JNIEnv *env, jobject /* thiz */, jobjectArray prefixes, jint niceValue) {
  std::vector<std::string> prefixList = javaStringArray(env, prefixes);
  std::vector<int> out{0, 0};
  if (prefixList.empty() || niceValue <= 0) {
    return toIntArray(env, out);
  }
  std::vector<ThreadEntry> entries = listProcessThreads();
  for (const ThreadEntry &entry : entries) {
    if (entry.name.empty() || !prefixMatches(entry.name, prefixList)) {
      continue;
    }
    out[0] += 1;
    if (setThreadNice(entry.tid, niceValue) == 0) {
      out[1] += 1;
    }
  }
  return toIntArray(env, out);
}

// ── 模型权重锁定 ────────────────────────────────────────────────────────
//
// 为什么这一半必须自己补：
//   llama.cpp 的 mlock 走的是进程级 RLIMIT_MEMLOCK，而 Android 应用默认软硬限
//   常常只有 64KB。于是它在几毫秒内因 ENOMEM 失败 —— 而它只往 stderr 打一行警告，
//   App 内完全看不见。这就是「看起来开了 mlock，实际一点没锁住」的根因。
//
// 为什么用 MAP_SHARED：
//   它映射的是页缓存里同一批物理页，llama.cpp 自己 mmap 的同一文件也指向这些页。
//   因此锁定「不额外占一份内存」，只是让这些页不会被回收 —— 换成 MAP_PRIVATE
//   会立刻多占一份模型大小的内存，在 8GB 机型上与目标完全相反。
//
// 为什么分片 mlock（默认 1MB）：
//   一次性 mlock 一大段，ENOMEM 时无从知道锁到了哪里；分片后可以精确报出
//   「锁住了多少 / 预取了多少」，而 UI 需要的是这两个具体数字，不是一个笼统的
//   「已开启常驻」。
//
// 返回 {fileSize, lockedBytes, prefetchedBytes, fullyLocked(0/1), mapped(0/1), errno}。
JNIEXPORT jdoubleArray JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeLockModelFile(
    JNIEnv *env, jobject /* thiz */, jstring jpath, jint chunkBytes) {
  std::vector<double> out{0, 0, 0, 0, 0, 0};
  const char *pathChars = env->GetStringUTFChars(jpath, nullptr);
  if (pathChars == nullptr) {
    return toDoubleArray(env, out);
  }
  std::string path(pathChars);
  env->ReleaseStringUTFChars(jpath, pathChars);

  // 已被当前进程锁定过 → 幂等返回既有结果，避免重复 mmap 累积地址空间。
  auto existing = g_lockedFiles.find(path);
  if (existing != g_lockedFiles.end() && existing->second.valid) {
    out[0] = static_cast<double>(existing->second.length);
    out[1] = static_cast<double>(existing->second.length);
    out[3] = 1.0;
    out[4] = 1.0;
    return toDoubleArray(env, out);
  }

  int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    out[5] = static_cast<double>(errno);
    LOGE("open model failed errno=%d path=%s", errno, path.c_str());
    return toDoubleArray(env, out);
  }

  struct stat st;
  if (::fstat(fd, &st) < 0 || st.st_size <= 0) {
    out[5] = static_cast<double>(errno);
    ::close(fd);
    return toDoubleArray(env, out);
  }
  const size_t fileSize = static_cast<size_t>(st.st_size);
  out[0] = static_cast<double>(fileSize);

  // 预热页缓存：冷文件直接 mlock 会让「调用线程」在 IO 上阻塞很久。
  ::posix_fadvise(fd, 0, static_cast<off_t>(fileSize), POSIX_FADV_WILLNEED);

  void *addr = ::mmap(nullptr, fileSize, PROT_READ, MAP_SHARED, fd, 0);
  ::close(fd);
  if (addr == MAP_FAILED) {
    out[5] = static_cast<double>(errno);
    LOGE("mmap model failed errno=%d", errno);
    return toDoubleArray(env, out);
  }
  out[4] = 1.0;

  const size_t chunk = chunkBytes > 0
                           ? static_cast<size_t>(chunkBytes)
                           : (1024 * 1024);  // 默认 1MB 分片
  size_t lockedBytes = 0;
  size_t prefetchedBytes = 0;
  int lastErrno = 0;

  for (size_t offset = 0; offset < fileSize; offset += chunk) {
    size_t len = fileSize - offset;
    if (len > chunk) {
      len = chunk;
    }
    void *chunkAddr = reinterpret_cast<char *>(addr) + offset;
    if (::mlock(chunkAddr, len) == 0) {
      lockedBytes += len;
      continue;
    }
    lastErrno = errno;
    // 锁不住退化为预取：不保证常驻，但能消掉推理过程中的大部分缺页，
    // 是权限受限下能拿到的最好结果。
    ::madvise(chunkAddr, len, MADV_WILLNEED);
    prefetchedBytes += len;
  }

  Mapping mapping;
  mapping.addr = addr;
  mapping.length = fileSize;
  mapping.valid = true;
  g_lockedFiles[path] = mapping;

  out[1] = static_cast<double>(lockedBytes);
  out[2] = static_cast<double>(prefetchedBytes);
  out[3] = (lockedBytes == fileSize) ? 1.0 : 0.0;
  out[5] = static_cast<double>(lastErrno);
  LOGI("lockModel %s size=%zu locked=%zu prefetched=%zu errno=%d",
       path.c_str(), fileSize, lockedBytes, prefetchedBytes, lastErrno);
  return toDoubleArray(env, out);
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeUnlockModelFile(JNIEnv *env,
                                                             jobject /* thiz */,
                                                             jstring jpath) {
  const char *pathChars = env->GetStringUTFChars(jpath, nullptr);
  if (pathChars == nullptr) {
    return 0;
  }
  std::string path(pathChars);
  env->ReleaseStringUTFChars(jpath, pathChars);

  auto it = g_lockedFiles.find(path);
  if (it == g_lockedFiles.end()) {
    return 0;
  }
  if (it->second.valid && it->second.addr != nullptr) {
    ::munlock(it->second.addr, it->second.length);
    // munmap 同时释放这块地址上的 mlock 计数 —— 这正是「必须在卸载模型时
    // 显式释放」的原因：换模型后旧模型的页不该还被钉住。
    ::munmap(it->second.addr, it->second.length);
  }
  g_lockedFiles.erase(it);
  LOGI("unlockModel %s", path.c_str());
  return 1;
}

JNIEXPORT jint JNICALL
Java_com_pocketpal_perf_PerfTuneModule_nativeUnlockAllModelFiles(
    JNIEnv * /* env */, jobject /* thiz */) {
  int count = 0;
  for (auto &entry : g_lockedFiles) {
    if (entry.second.valid && entry.second.addr != nullptr) {
      ::munlock(entry.second.addr, entry.second.length);
      ::munmap(entry.second.addr, entry.second.length);
      count += 1;
    }
  }
  g_lockedFiles.clear();
  LOGI("unlockAllModelFiles count=%d", count);
  return count;
}

}  // extern "C"
