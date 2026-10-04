# 门店叫号全栈系统

三个终端 + 关系数据库队列：

| 终端 | 地址 | 职责 |
|---|---|---|
| C 展示窗 | `/display.html` | 海报背景大屏，语音播报，待核对播报人工处理 |
| 柜台端 | `/counter.html` | 领号、叫下一号、重播、完成服务、暂停/恢复窗口 |
| 管理台 | `/admin.html` | 队列总览，指令三态（已保存/终端已接收/现场已确认），待核对与人工重播 |

```bash
npm start          # http://localhost:3000
npm test           # 8 项验收测试
```

## 数据模型（SQLite，server/db.js）

- `tickets.id` = UUIDv4 —— **跨日稳定票据身份**；`seq` 仅在 `biz_date` 内唯一（`UNIQUE(biz_date, seq)`），由 `daily_seq` 表在事务内原子递增，**号码按日期重置**。
- `tickets.status`：`waiting → called → serving → done`。
- `counters.status`：`open / paused / closed`，`current_ticket_id` 指向当前服务对象。
- `commands`：每条指令带**幂等键**（`idem_key` 唯一索引）与生命周期
  `SAVED(已保存) → DELIVERED(终端已接收) → CONFIRMED(现场已确认)`。
- `events`：审计日志。

## 多柜台不会同时领走同一顾客

`callNext`（server/queue.js）在**单个事务**内完成「选号 → 认领 → 落指令」：

1. `UPDATE tickets ... WHERE id=? AND status='waiting'` 乐观认领，`changes !== 1` 即失败回滚；
2. SQLite 写事务串行化天然互斥；迁移 PostgreSQL 时选号换 `SELECT ... FOR UPDATE SKIP LOCKED`，语义不变；
3. 柜台有未办结顾客时拒绝叫下一位（`ALREADY_SERVING`）。

验收：两柜台并发竞争最后一张票 → 恰好一个 200、一个 409 `QUEUE_EMPTY`，票据归属唯一。

## 集中分配 vs 终端持租约取号（方案对比）

| 维度 | 服务器集中分配（本系统采用） | 终端持租约取号（号段预借） |
|---|---|---|
| 号码唯一性 | 数据库事务保证，无重复无空洞之外的竞争 | 租约内安全；租约过期/续约处理不当会重号或跳号 |
| 断网发号 | **不允许**（无法保证唯一） | 允许，在租约号段内继续发号 |
| 崩溃恢复 | 无状态，重启即用 | 需围栏令牌(fencing)防止旧租约持有者复活后继续发号 |
| 可预测性 | 号码连续，顾客体验好 | 租约作废产生空洞号段 |
| 复杂度 | 低 | 高（租约时长、续约、 fencing、跨日租约清算） |

**结论**：门店局域网场景服务器集中式足够且最不易错；断网时发号终端降级为不可用并明确提示，优于引入租约 fencing 的复杂度。取号侧若未来必须离线发号，可仅对「离线票」发临时标识、联网后换正式号，而不动主队列。

## 断网时允许继续的动作（已实现）

| 动作 | 断网时 | 实现 |
|---|---|---|
| 领号（发新票） | ❌ 禁止 | 集中分配要求在线；界面禁用并提示原因 |
| 叫下一号 | ❌ 禁止 | 认领必须服务端原子完成；界面禁用 |
| 重播叫号 | ❌ 禁止（指令需落库） | 界面禁用 |
| 完成服务 | ✅ 暂存 | 带幂等键入 localStorage 队列，联网自动按序同步 |
| 暂停/恢复窗口 | ✅ 暂存 | 同上；只影响本柜台状态，后应用不破坏他人 |
| 展示窗展示 | ✅ 继续 | 渲染最后快照（localStorage），显示离线徽标 |
| 展示窗语音重播 | ✅ 继续 | 语音合成在终端本地，缓存文本可离线重播 |

所有暂存动作在**点击时生成幂等键、重放时键不变**，服务端按唯一索引去重——断网重传、双击、刷新重试都不会重复改变排队状态（验收测试 2、7）。

## 「物理播报恰好一次」的诚实答案

屏幕亮起/声音播出是物理副作用，设备可能在「已播出、回执未达」之间崩溃——**没有任何服务端回执机制能保证物理恰好一次**（两将军问题）。本系统的做法：

1. 指令三态显式化：`SAVED → DELIVERED → CONFIRMED`，管理台分列展示；
2. 终端播放到 `onend` 才 confirm；崩溃则指令永远停在 `DELIVERED`；
3. 重启后终端对 `DELIVERED` 指令**不自动重播**（可能已播出过），进入「待核对」面板；
4. 提供两个人工入口：**人工重播**（生成 `REPLAY` 指令，关联原指令、自身也幂等）与**标记已播**；
5. 现场确认后票据进入 `serving` —— 管理台据此区分「指令已保存 / 终端已接收 / 现场已确认服务」。

## 跨日设计

号码按 `biz_date` 重置（每日从 1 开始）；票据 UUID 终身不变。午夜仍有等待者时：等待队列跨日保留，叫号按 `(biz_date, seq)` 排序——**昨日等待者优先**，界面以「跨日」标签区分。测试通过 `QUEUE_TEST_HOOKS=1` 的 `/api/_test/clock` 钩子拨动业务时钟（仅测试模式挂载）。

## 海报解码失败与可读性

展示窗用 `img.decode()` 检测海报解码，失败即切换 `.bg-fallback`（纯 CSS 渐变，无图片依赖）。号码面板 `.contrast-panel` 自带深色半透明衬底 + 文字阴影，**可读性与背景完全解耦**——无论海报花哨、缺失还是降级，号码都清晰可读。可用 `?poster=/api/_test/corrupt-poster` 现场验证降级。

## 验收场景 → 测试映射（tests/acceptance.test.js）

| 验收场景 | 测试 |
|---|---|
| 两柜台竞争最后一张票 | #1 恰好一个成功 + 归属唯一 + 再发两票各叫各的 |
| 午夜仍有人等待 | #3 号码重置、UUID 稳定、跨日优先 |
| 暂停与叫号同时提交 | #4 二十轮并发只出现两种合法终态 + 顺序语义确定 |
| 海报解码失败 | #5 损坏字节 → 降级类生效 + 可读性样式断言 |
| 设备重启 | #6 DELIVERED 待核对、不自动重播、人工重播/确认 |
| 叫号指令重发 | #2 同键重发/并发重发只落一条指令、状态只变一次 |
| 断网策略 | #7 离线队列暂存/保留/按序同步/拒单丢弃 |

## API 摘要

```
POST /api/tickets                        领号 {idemKey}
POST /api/counters/:id/call-next         叫下一号 {idemKey}
POST /api/counters/:id/pause | /resume   暂停/恢复 {idemKey}
POST /api/counters/:id/complete          完成服务 {idemKey}
POST /api/counters/:id/recall            重播叫号 {idemKey}
GET  /api/display/state                  展示窗状态（含待播报/待核对指令）
POST /api/commands/:id/ack               终端已接收
POST /api/commands/:id/confirm           现场已确认
POST /api/commands/:id/replay            人工重播 {idemKey}
GET  /api/admin/overview | /commands     管理台（?status= / ?pending=1）
```
