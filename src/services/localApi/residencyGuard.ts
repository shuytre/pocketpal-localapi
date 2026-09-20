/**
 * 模型常驻的判定源。
 *
 * 为什么是一个独立的小模块而不是直接读 store：
 * ModelStore 是被引用的那一侧 —— 如果 ModelStore 反过来 import LocalApiStore，
 * 两个 store 会形成一个环，而 mobx + 循环 import 在 Hermes 下最常见的表现是
 * 「某个 observable 在第一次读取时是 undefined」，极难定位。
 *
 * 这里只有一个可变布尔位，ModelStore 只读它，LocalApiStore 只写它，方向单向。
 */
let keepResident = false;

export const setModelResident = (value: boolean): void => {
  keepResident = value;
};

export const shouldKeepModelResident = (): boolean => keepResident;
