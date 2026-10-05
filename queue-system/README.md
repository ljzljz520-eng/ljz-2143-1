# 门店叫号全栈系统

零外部依赖（Python 3 标准库 + SQLite + 原生 Web），一条命令启动：

```bash
python3 run.py --port 8000          # 生产
python3 run.py --port 8000 --test-mode   # 测试模式（开放 /api/test/clock 时钟注入）
python3 -m unittest discover tests -v    # 运行 12 项验收测试
```

| 入口 | 说明 |
|---|---|
| `/display` | C 展示窗（海报背景、语音播报、断线保最后画面） |
| `/counter?counter=1` | 柜台端：叫下一号（领号）、重播、暂停/恢复、办结、确认到场 |
| `/admin` | 管理台：队列、窗口、指令四级确认状态、待核对、人工重播 |
| `/kiosk` | 取号终端：在线集中分配 / 断网租约发号（含"模拟断网"开关） |

## 1. 数据模型与关键不变量

SQLite（WAL）关系库，不变量由数据库层兜底，而非仅靠应用代码：

- `tickets.ticket_id`（UUID 主键）= **跨日稳定票据身份**；`seq_no` 是当日序号，
  `UNIQUE(biz_date, seq_no)` 保证**号码按日期重置**且不撞号。跨天时两天的
  `number_label` 都是 `A001`，只有 `ticket_id` 能区分——这正是稳定身份存在的理由。
- `UNIQUE INDEX ... ON tickets(counter_id) WHERE status='serving'`（部分唯一索引）：
  一个柜台同一时刻至多一名当前服务对象。
- 领取动作为 `UPDATE ... WHERE status='waiting'` 条件更新 + `BEGIN IMMEDIATE`
  串行化写事务：**多个柜台不可能同时把同一顾客领为当前服务对象**。
- `call_commands.command_id` 主键 = 客户端生成的**幂等键**：叫号指令重发只读不写，
  绝不重复改变排队状态（响应带 `idempotent: true`）。
- `seq_counters`：每业务日一个计数器，集中发号（取 1 个号）与租约（取一段号）
  **共用同一计数器**，两种发号模式永不撞号。

## 2. 集中分配 vs 终端持租约取号

| 维度 | 服务器集中分配 | 终端持租约取号 |
|---|---|---|
| 一致性 | 服务端单点仲裁，天然防重 | 号段预分配，段内不冲突、跨终端不重 |
| 断网可用性 | 断网即停发号 | 租约内可继续离线发号 |
| 时延/吞吐 | 每次一次往返 | 本地即发，零往返 |
| 状态同步 | 无 | 恢复后回同步（`ticket_id` 幂等 + 号段唯一约束兜底） |
| 风险 | 单点、网络敏感 | 号段浪费、租约跨日过期、终端丢失导致号段空洞 |

**本系统的取舍**：发号（弱一致需求）两种都实现——在线走集中分配，取号终端
同时持有租约作为断网降级；**叫号/领号（强一致需求）一律集中仲裁**，断网不开放。

## 3. 断网时允许继续的动作（已实现）

| 动作 | 断网 | 实现 |
|---|---|---|
| 取号（持有效租约） | ✅ | kiosk 本地出票：本地生成 UUID 票据身份，恢复后 `/api/tickets/sync` 幂等回同步 |
| 取号（无租约） | ❌ | 页面明确提示"断网且无可用租约" |
| 叫号 / 领号 / 暂停 / 确认 | ❌ | 需服务端仲裁，柜台端断网时明确提示并禁用 |
| 展示窗 | 部分 | 保留最后已知画面，不播报新号，恢复后自动续播 |

## 4. 物理播报无法"恰好一次"——工程设计

服务端回执无法证明声音真的从喇叭里放出来（两将军问题）：终端可能在
**播放后、回执前**崩溃。因此不追求不可能的恰好一次，而是：

1. 指令状态机分级确认：`saved`（已保存）→ `delivered`（终端已接收）→
   `played`（终端已播报）→ `confirmed`（现场已确认服务，柜台人工点"确认到场"）。
   管理台四色徽章直接区分。
2. 终端把已播放集合持久化在 localStorage：崩溃重启后**已播的不自动重播**
   （宁人工核对，不多播一次），**未播的自动补播**。
3. 超时（默认 15s）未 `played` 的指令在管理台标红为**待核对**，并提供
   **人工重播**入口：生成 `kind=replay` 的新指令（`replay_of` 指向原指令），
   只触发重新播报，**绝不触碰票据与队列状态**。

## 5. 海报降级（背景失败不影响号码可读）

- CSS 多层背景：海报为第一层、深蓝渐变为兜底层——解码失败浏览器自动只渲染下层，零 JS 依赖；
- JS `Image` 探测 `onerror` → `body.poster-failed`：去掉海报层、面板不透明度升至 0.96、
  左上角提示运维；
- 号码永远在 `#000` 近实色底 + 纯白高对比文字上，与背景完全解耦；
- 演示：`/display?poster=/static/broken.jpg`。

## 6. 验收测试映射（`tests/test_acceptance.py`，12 项全绿）

| 验收项 | 测试 |
|---|---|
| 两柜台竞争最后一张票 | `TestRaceForLastTicket`：屏障对齐并发，恰好 200/409，唯一 serving |
| 午夜仍有人等待 | `TestMidnightWaiting`：注入时钟跨午夜，序号重置、双 A001 靠 ticket_id 区分、跨日 FIFO |
| 暂停与叫号同时提交 | `TestPauseAndCallSimultaneous`：结果确定性收敛，无中间态 |
| 海报解码失败 | `TestPosterDecodeFailure`：CSS 双层背景 + Node 单测降级纯函数 |
| 设备重启 | `TestDisplayDeviceRestart`：崩溃前未播→自动补播；播后丢回执→待核对→人工重播 |
| 幂等 | `TestIdempotency`：同 command_id 串行/并发重发、乱序回执不倒退 |
| 断网租约 | `TestLeaseOfflineIssue`：离线发号回同步幂等、越界拒绝、集中分配跳过租约段 |

## 7. API 一览

```
POST /api/tickets                     集中发号            POST /api/leases            申请租约
POST /api/tickets/sync                离线票回同步         GET  /api/queue             队列
POST /api/counters/{id}/serve-next    领号+叫号(幂等)      POST /api/counters/{id}/recall  重叫
POST /api/counters/{id}/done|pause|resume                 办结/暂停/恢复
GET  /api/display/state               展示窗状态(含待播)   POST /api/display/ack       终端回执
POST /api/commands/{id}/replay        人工重播            POST /api/commands/{id}/confirm 现场确认
GET  /api/admin/overview              管理台总览(含待核对)
```
