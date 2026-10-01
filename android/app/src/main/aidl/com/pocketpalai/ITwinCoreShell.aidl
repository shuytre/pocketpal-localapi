// TwinCore —— Shizuku UserService 的 AIDL 契约。
//
// 为什么需要它：Shizuku 13.1.1 起把 Shizuku#newProcess 标记为 private 并计划移除
// （官方公告："Prepare to remove Shizuku#newProcess, developers should have to
// use UserService instead"）。UserService 是在 root/shell 身份下运行我们自己代码的
// 唯一受支持路径，比 newProcess 的文本管道更快也更可靠。
//
// 注意 destroy 的 transaction code 必须是 16777114（Shizuku 服务端约定），
// 且不能改名 —— 否则 unbind 时旧服务不会被销毁。
package com.pocketpalai;

interface ITwinCoreShell {
    /** Shizuku 服务端约定：解绑/版本不匹配时回调，负责自毁。 */
    void destroy() = 16777114;

    /**
     * 以 shell(2000)/root(0) 身份执行多行脚本，返回退出码。
     * stdout/stderr 通过 execOut/execErr 带回，避免 AIDL 返回大字符串的限制。
     */
    int exec(String script) = 1;

    String execOut() = 2;

    String execErr() = 3;
}
