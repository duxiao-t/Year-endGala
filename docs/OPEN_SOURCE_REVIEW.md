# 开源候选核验

核验日期：2026-11-11。以下信息来自 GitHub API、仓库 README 和实际源码检查。没有把这些仓库描述成已经通过千人压测；并发能力需要本项目自行验证。

| 类别 | 候选仓库 | 功能匹配点 | 授权 | 维护状态 | 结论 |
|---|---|---|---|---|---|
| 抽奖 | [moshang-ax/lottery](https://github.com/moshang-ax/lottery) | Vue 3 + Three.js 3D 球体、奖品栏、Excel 工作流；仓库中中奖选择使用前端 `Math.random` | MIT | 2026-09-04 有推送 | 采用其视觉与交互思路。中奖选择改为服务端 `crypto.randomInt` 抽样，3D 卡片为采样展示 |
| 摇一摇 | [coolfishstudio/game-shake](https://github.com/coolfishstudio/game-shake) | JS DeviceMotion 摇动 Demo | 未提供许可证 | 2023-03-11 | 不直接复用 |
| 摇一摇 | [serglider/shake-detector](https://github.com/serglider/shake-detector) | 移动设备摇动检测库，不是完整玩法 | MIT | 2022-04-24 | 只作算法参考；本项目的计分、权限提示和点击降级为自研 |
| 红包雨 | [sangcz/RedPacketRain](https://github.com/sangcz/RedPacketRain) | 纯 JS H5 红包雨、下落与点击回调 | MIT | 2019-01-09 | 复用视觉方向；金额与领取改为服务端事务，交互改为 Pointer 滑动 |
| 红包雨 | [Orange-W/RedPackRain](https://github.com/Orange-W/RedPackRain) | iOS Swift 红包雨组件 | MIT | 2018-06-04 | 不适用于 Web，排除 |
| 答题 | [toddeTV/stage-flow-tools](https://github.com/toddeTV/stage-flow-tools) | 实时答题、主持流程、排行榜；Nuxt 4 + SQLite | Apache-2.0 | 2026-10-18 有推送 | 功能接近，但整仓并入会引入独立认证和数据库；不选为运行时依赖 |
| 答题 | [NAVEENKUMAR-T-GIT-28/QuizPulse](https://github.com/NAVEENKUMAR-T-GIT-28/QuizPulse) | 仓库描述称 MERN + Socket.IO、QR 加入、状态机和导出 | MIT | 2026-05-12 有推送 | 技术栈与统一后端不一致，未做代码级功能核验；不并入 |
| 答题 | [Improwised/jovVix](https://github.com/Improwised/jovVix) | Vue 实时答题与排行榜 | AGPL-3.0 | 2026-11-06 有推送 | 强 copyleft，排除 |

## 结论

- 抽奖有清晰授权且可直接借鉴的 3D 实现，已作为抽奖视觉基础。
- 摇一摇没有找到许可证清晰、维护中且可直接并入的完整年会玩法，因此只保留 DeviceMotion 逻辑自研。
- 红包雨有 MIT H5 示例，但其客户端金额与逐红包定时器不适合事件级公平发奖，已重写为服务端分配。
- 答题有多个候选，但都自带独立应用边界；为了统一入场、统一结果和单进程部署，答题状态机自研。
