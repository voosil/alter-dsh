/**
 * jsdom 层的全局测试配置。
 *
 * testing-library 的异步查询默认只等 1s（`asyncUtilTimeout`）。ui 层每个文件都
 * 要创建一个完整 DOM 环境，`pnpm check` 还会与 integration 项目并行跑真 SQLite，
 * 于是「行为正确但 React 提交与一次 RPC 往返的排队超过 1s」会变成假失败——这属于
 * 时序类缺陷，但缺陷在断言的绝对时限，不在被测行为。这里统一给 5s 窗口：
 * 行为错了照样失败，只是不再把排队时间算成错误。
 *
 * 只放宽超时，不加重试、不放宽断言。
 */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
