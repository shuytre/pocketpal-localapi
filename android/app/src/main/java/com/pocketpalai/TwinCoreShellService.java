package com.pocketpalai;

import android.util.Log;

import androidx.annotation.Keep;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;

/**
 * TwinCore —— 在 Shizuku 提供的 shell/root 身份下执行调频脚本。
 *
 * <p>这是 Shizuku 官方推荐的 UserService：本类实例会被 Shizuku 服务端加载并
 * 运行在一个独立进程中，其 Linux UID 为 2000（adb shell）或 0（root），因此
 * 可以直接写 /sys/devices/system/cpu/&#42;/cpufreq/&#42; 这类普通应用无法触碰的节点。
 *
 * <p>为什么不用 Shizuku#newProcess：13.1.1 起它已被改为 private 并计划移除。
 *
 * <p>本类不需要在 AndroidManifest 中注册 —— Shizuku 通过类名 + 进程后缀自行拉起。
 */
public class TwinCoreShellService extends ITwinCoreShell.Stub {

    private static final String TAG = "TwinCoreShell";

    private volatile String lastOut = "";
    private volatile String lastErr = "";

    /** 无参构造：Shizuku v13 之前的回退路径。 */
    public TwinCoreShellService() {
        Log.i(TAG, "init");
    }

    /**
     * 带 Context 的构造：Shizuku v13+ 优先使用它。
     * 必须标注 @Keep，防止 R8 在 release 构建里把它裁掉。
     */
    @Keep
    public TwinCoreShellService(android.content.Context context) {
        Log.i(TAG, "init with context=" + context);
    }

    /**
     * Shizuku 约定的保留方法（transaction code 16777114）。
     * 解绑或版本不匹配时由服务端回调，必须在这里退出进程，否则会泄漏成一个常驻服务。
     */
    @Override
    public void destroy() {
        Log.i(TAG, "destroy");
        System.exit(0);
    }

    /**
     * 执行多行 shell 脚本。
     *
     * <p>直接 exec("sh") 并写 stdin，而不是 exec("sh -c script")：脚本里常有
     * 重定向和管道，走 -c 会被外层 shell 再解析一遍，容易出现「命令没跑但退出码为 0」
     * 的假成功。写 stdin 时脚本按行原样交给内层 sh，行为可预期。
     */
    @Override
    public int exec(String script) {
        lastOut = "";
        lastErr = "";
        Process process = null;
        try {
            process = Runtime.getRuntime().exec("sh");
            OutputStream os = process.getOutputStream();
            os.write(script.getBytes("UTF-8"));
            os.flush();
            os.close();

            lastOut = drain(process.getInputStream());
            lastErr = drain(process.getErrorStream());
            int code = process.waitFor();
            Log.d(TAG, "exec exit=" + code + " out=" + truncate(lastOut));
            return code;
        } catch (Throwable t) {
            // 不允许把异常穿过 AIDL 边界 —— 调用侧只看到 RemoteException，
            // 信息量远不如在这里记全。
            lastErr = String.valueOf(t.getMessage());
            Log.e(TAG, "exec failed", t);
            return -1;
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    @Override
    public String execOut() {
        return lastOut;
    }

    @Override
    public String execErr() {
        return lastErr;
    }

    private static String drain(java.io.InputStream stream) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    private static String truncate(String s) {
        if (s == null) {
            return "null";
        }
        return s.length() <= 2000 ? s : s.substring(0, 2000);
    }
}
