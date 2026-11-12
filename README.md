# 年会互动现场

约 1000 人年会现场的统一互动系统：统一入场、手机端摇一摇/红包雨/答题、只读大屏、3D 抽奖、主持台和 Excel 汇总。

## 快速启动

```bash
npm install
cp .env.example .env
# 至少修改 .env 中的 ADMIN_PASSWORD、SCREEN_TOKEN、JOIN_CODE、PUBLIC_ORIGIN
npm run dev
```

- 手机入场：`http://localhost:5173/join`
- 大屏：`http://localhost:5173/screen?token=<SCREEN_TOKEN>`
- 主持台：`http://localhost:5173/admin`

生产构建：

```bash
npm run build
npm start
```

生产环境必须提供 `ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH` 以及 `SCREEN_TOKEN`，否则服务会拒绝启动。

## Docker + HTTPS

修改 `.env` 后执行：

```bash
docker compose up -d --build
```

`Caddyfile` 使用 `DOMAIN` 自动申请 HTTPS 证书，并反向代理到 Node 服务。会场大屏与手机使用同一个 `PUBLIC_ORIGIN`，二维码会自动带上入场码。

## 主持台操作

1. 在“参与者”中导入 Excel/CSV（工号、姓名、部门），或开放扫码自助登记。
2. 在“规则配置”中设定奖池、时长、红包预算、资格策略和抽奖奖项。
3. 在“题库”中导入/新增题目，列格式为：题目、A、B、C、D、正确答案、时长、分值。
4. 在“控场台”切换大屏、开始/结束每个玩法。
5. 抽奖由服务端加密随机生成，结果写入结果台账；中奖人不在场可作废后重抽。
6. 在“结果与兑付”导出工作簿，红包按兑付码人工核销。

未设置 `ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH` 时主持台无法登录；生产环境会拒绝启动。

## 模块边界

| 模块 | 文件边界 | 责任 |
|---|---|---|
| 核心身份与实时 | `server/db.ts`、`server/auth.ts`、`server/index.ts` | 工号唯一身份、会话 Cookie、Socket.IO 房间、主持台 API |
| 业务状态机 | `server/state.ts` | 四玩法状态、发奖、排名、资格策略、抽奖随机 |
| 纯规则 | `server/domain.ts` | 红包预算分配、加密洗牌、姓名脱敏、速度分 |
| 数据导入导出 | `server/transfer.ts` | Excel/CSV 名单和题库导入，工作簿导出 |
| 手机端 | `web/src/views/PlayView.vue` 与三个游戏组件 | 摇动授权/点击降级、Canvas 红包雨、答题 |
| 大屏 | `web/src/views/ScreenView.vue`、`LotteryDisplay.vue` | 扫码、排行榜、答题分布、3D 抽奖 |
| 主持台 | `web/src/views/AdminView.vue` | 名单、配置、题库、控场、作废、兑付、导出 |

## 主要接口

- `POST /api/join`：名单校验或自助登记，绑定 HttpOnly 会话。
- `GET /api/me`：当前玩家的积分、红包、答题和抽奖状态。
- `GET /api/screen/snapshot?token=`：大屏初始状态。
- `POST /api/admin/login`：主持台登录。
- `PATCH /api/admin/settings`：活动规则。
- `POST /api/admin/games/:game/action`：开始、结束、锁题、揭晓、重置。
- `POST /api/admin/lottery/draw`：服务端抽奖。
- `GET /api/admin/export`：下载结果工作簿。

Socket.IO 使用 `/live` 默认命名空间：玩家发送 `shake:batch`、`packet:claim`、`quiz:answer`，服务端广播 `state:snapshot` 和 `player:summary`。屏幕更新被节流到约 800ms；玩家高频事件只返回个人 ack，不向 1000 个连接广播大对象。

## 千人现场检查

1. 使用有公网 HTTPS 域名的主机；iOS 运动权限需要安全上下文。
2. 在目标云主机执行 `LOAD_INTERVAL_MS=500 LOAD_SECONDS=20 npm run loadtest -- https://your-domain.example 1000`，先确认连接成功率和 p95 ack。
3. 用 20–50 台真机做彩排，覆盖 iOS Safari 与 Android Chrome，实际摇动、滑动和答题。
4. 活动前导出一次名单并备份 `data/gala.db`；活动中不要修改正在进行的红包预算。
5. 现场 Wi-Fi、AP 数量和公网出口不是应用能修复的部分，需单独验收。

本机验收记录（WSL，单机同时运行服务端与 1000 个 Socket 客户端，500ms 上报、5 秒）：连接 `1000/1000`、ack `9000`、错误 `0`、p95 `363ms`。这证明应用热路径和内存聚合可用，但不能替代目标云主机、真实运营商网络和手机传感器彩排。

## 配置项

| 配置 | 说明 |
|---|---|
| `PORT` | Node 监听端口 |
| `PUBLIC_ORIGIN` | 用于二维码和 Cookie 安全判断的公网 HTTPS 地址 |
| `DOMAIN` | Caddy 自动 HTTPS 域名 |
| `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` | 主持台凭证；哈希可用 `npm run hash-password -- '密码'` 生成 |
| `SCREEN_TOKEN` | 大屏只读凭证 |
| `JOIN_CODE` | 首次初始化的入场码，后台可修改 |
| `DB_PATH` | SQLite 文件路径 |

后台可配置：活动名称、公司、入场模式、自助审核、资格策略、大屏姓名脱敏、摇一摇时长/获奖数/奖品名、红包时长/预算/包数/金额模式/每人上限、答题获奖数/基础分/速度分、抽奖奖项 JSON。

## 已知边界

- 不接微信支付；红包金额只形成领取台账和兑付码，线下核销。
- 单 Node 进程 + SQLite；1000 人目标需要目标环境压测，不声称候选开源项目或本环境已经完成千人实测。
- 摇一摇是娱乐级反作弊：服务端限幅、限频，但无法识破被篡改的客户端或自动化设备。
- 3D 抽奖只展示采样卡片；候选池和最终中奖由服务端完整名单计算。
- 大屏和主持台当前按单主屏、单主持设计；多屏可打开多个只读 `/screen` 页面。

## 后续开发任务

1. 在目标云主机和现场网络复跑 1000 客户端压测，记录连接成功率、p95、p99 与断线重连结果。
2. 用 20–50 台 iOS/Android 真机彩排，验收运动权限、滑动命中率、锁屏恢复和现场 Wi-Fi。
3. 增加 SQLite 定时备份、恢复演练和活动后数据归档，避免单文件故障导致结果丢失。
4. 如需要多主持、多操作员或分区域大屏，再引入角色权限和屏幕分组；当前不做多租户。
5. 如需红包资金自动发放或财务系统对账，需要另行评估微信支付/财务接口与合规要求。

## 测试

```bash
npm test
npm run build
# 如需浏览器烟测：
npx playwright install chromium
UI_BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... SCREEN_TOKEN=... JOIN_CODE=... npm run test:ui
```

浏览器烟测会写入测试参与者、游戏轮次和一条抽奖结果，只能对专用测试库运行，不要指向正式活动数据库。

测试覆盖红包金额守恒与上下限、加密洗牌、姓名脱敏、速度分、玩法落库、重复领取、抽奖候选去重，以及 Excel 工作簿生成与重新读取。浏览器烟测覆盖入口、入场、主持台、大屏、四个玩法视图和抽奖结果。Docker 镜像已在本地完成构建与生产模式启动验证；目标云主机 HTTPS 和真机彩排仍需现场验收。

## 许可证与归属

项目自身代码用于本次年会项目。抽奖视觉与红包雨视觉参考了 MIT 项目的实现思路，详见 `THIRD_PARTY_NOTICES.md` 和 `docs/OPEN_SOURCE_REVIEW.md`。
