// 可选运行时依赖的类型占位。
//
// 这两个包**不在本插件的 dependencies 里**，也不该在：它们由 DSH 的安装目录提供，
// 或者由用户自己装（QQ 官方协议才需要 qqbot-connector）。本插件对它们是「有就用、
// 没有就降级」的动态 import，所以只声明模块存在，不声明任何形状——
// 真给它们编类型，反而会和 DSH 那边实际导出的东西对不上。

declare module '@deepseek-ai/dsh-tools';
declare module '@tencent-connect/qqbot-connector';
