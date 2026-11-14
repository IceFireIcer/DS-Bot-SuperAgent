# Super-agent 实施记录

本记录对应用户在 2026-11-03 明确调用的 `implement-spec` 工作流。

- 规格：[v2.1](../spec.md)，总体 Issue #1；实施图：[T01—T60](../tickets.md)。
- 集成基线：`dev` 的 `14a692d`；集成分支：`feat/1-superagent-integration`。
- 逐票使用独立分支和工作树，以已确认的公开 Engine 命令/查询及适配器契约执行 TDD，再合入集成分支。
- 本次实施 frontier 以具体前置的实现已合入、必要验证通过且证据可查为依据。GitHub Issue 的 OPEN/CLOSED 仍表示仓库规定的发布状态；保留原生依赖，不将未发布误报为已关闭，也不因完成代码而创建发布。
- `maintainer` 限制、他人占用、设计决定、真实环境前提及各票验收仍然有效。实现证据不能代替真实模型、外部信道、第二设备或正式部署验收。
- 只有已完成范围有对应证据时才记录为完成；总体规格尚未实现。

## 当前进展

R5 新产品入口：[R5-01 / #93 连续 Main 主对话](r5-01.md)；[R5-02 / #94 Main 委托一项本地工作](r5-02.md)；[R5-03 / #95 复合请求分解与并行工作](r5-03.md)。双轴审查：[R5-01](reviews/r5-01.md)、[R5-02](reviews/r5-02.md)、[R5-03](reviews/r5-03.md)。以下 T 系列继续保留历史证据，不作为 R5 的全部验收。

| 实施票 | 实现状态 | 证据与边界 |
| --- | --- | --- |
| T01 / #29 | 已合入 dev；未发布 | `c7cfbaf`，集成提交 `e1322b7`；[验收记录](t01.md)：新核心 15/15，Windows Node 22.19 / 24 / 25；不启动 Worker |
| T02 / #30 | 已合入 dev；未发布 | `0d28b87`、审查修复 `1fb556c`；[验收记录](t02.md)：原生 DSH Router/Worker、独立 Session/Assignment/report、ready 依据与隔离统一聊天入口；39/39，双轴复审剩余 0/0 |
| T03 / #31 | 已合入 dev；未发布 | `6ccabff`、审查修复 `2676092` 及收尾修复；[验收记录](t03.md)：绑定本地 Environment、真实文件/search/command、setup retry、artifact/toolFacts；当前 Node 25 全量 48/48，双轴复审剩余 0/0 |
| T04 / #32 | 已合入 dev；未发布 | `aa2c645`、`c31aad2` 及旧 direct 兼容收尾；[验收记录](t04.md)：受信 source intake、版本投影、冲突/unknown、tombstone、接单隔离与 Thread 交付；Node 22/24.22/25 各 62/62，双轴复审剩余 0/0 |
| T05 / #33 | 已合入 dev；未发布 | `50d9ad2`、真实派发修复 `f6eff3c`；[验收记录](t05.md)与[复盘改进](retro-t05.md)：全量 91/91、脚本 7/7，真实 Effects 派发合并、逐项重试及双轴复审通过 |
| T06 / #34 | 已合入 dev；未发布 | `5a52400`；[验收记录](t06.md)：全量 96/96，Thread fan-out、稳定 Input、方向版本、自然结束恢复、同 Session 跟进、恢复与历史查询；双轴复审 0/0 |
| T07 / #35 | 已合入 dev；未发布 | `1354e13`；[验收记录](t07.md)：全量 106/106，多订阅、context-only、handback/重评、Worker 订阅管理、note 与 unavailable dismiss；双轴复审 0/0 |
| T08 / #36 | 已合入 dev；未发布 | `c5ff37e`；[验收记录](t08.md)：全量 112/112，结构化 Attention、waiting-human、授权回答、stale Outbox dropped 与 chat 回答入口；双轴复审 0/0 |
| T09 / #37 | 已合入 dev；未发布 | `a0436b6`；[验收记录](t09.md)：全量 116/116，持久 stop、取消确认、显式 resume、Assignment 换代与 UI；双轴复审 0/0 |
| T10 / #38 | 已合入 dev；未发布 | `85fd312`；[验收记录](t10.md)：全量 122/122，版本化 Policy、来源隔离、在途 Eval 重排、全局暂停与停止/等待状态区分；双轴复审 0/0 |
| T11 / #39 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t11.md)：全量 130/130，持久执行槽、人工优先的有界额外槽、按 lane 派发、受限状态命令与声明负载实测；双轴复审见 [t11](reviews/t11.md) |
| T12 / #40 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t12.md)：全量 142/142，后台 job 身份与有界输出、完成事件回原 Worker、占用槽预算与按归属清理、真实 Windows 长命令实测；双轴复审见 [t12](reviews/t12.md) |
| T13 / #41 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t13.md)：全量 152/152，DSH 公开 `parentAgent` 子 Agent、受限工具与环境继承、按 `turn/end` 判定成功/失败、完成事件回原 Worker、按归属清理与声明期限；双轴复审见 [t13](reviews/t13.md) |
| T14 / #42 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t14.md)：全量 165/165，显式托管预览与预算、ready/waiting-human 释放槽、普通 job/子 Agent 按归属清理、预览不占槽且退出不唤醒、未确认清理待确认并可解析、idle/draft/ready/Ticket-ended 分开查询；双轴复审见 [t14](reviews/t14.md) |
| T15 / #43 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t15.md)：全量 187/187，公开 SessionPersistence/SessionHandle 的 SQLite 实现、连续序列/事件数/格式校验、fork 血缘与继承 cut、writer epoch 守卫（失败不确认/不释放/不重获）、死 PID 崩溃接管、未物化创建不留残留而 flush 过的空 Session 保留、append 原子性、live 失败即停止、构造记录在 announce 前越过持久屏障、按 `stat()` 决定 resume、并发交错/取消/恢复/fork/服务替换实测；双轴复审见 [t15](reviews/t15.md) |
| T16 / #44 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t16.md)：全量 194/194，Input 的 claim/sent/persisted/completed 分开记录、稳定 messageId、flush 后才确认持久投递、验收事实与完成同事务、未入历史按原 messageId 恢复、已入历史不重复追加而用编号恢复说明继续、idle 不算承接、分页 pending 索引与启动扫描先定未读/已读边界、ownership 核验拒绝 re-attach、重试新建 Assignment 代次、3 次恢复/5 次投递上限、真实子进程在 claim 前后/append 后/provider flush 失败/回执前后退出实测；双轴复审见 [t16](reviews/t16.md) |
| T17 / #45 | 已合入 dev；未发布 | 按用户 `/implement` 在当前集成分支提交；[验收记录](t17.md)：显式事务扩展、提交对账、可靠副作用、relay/notice 顺序与 schema v2 |
| T18 / #46 | 已实现；未发布 | [验收记录](t18.md)：独立交付账本、用途依据、pending/sent/dropped 回执、可注入信道、回答绑定当前人类问题、确认先于结果 |
| T19 / #47 | 已实现；未发布 | [验收记录](t19.md)：显式 retry 新 Assignment 代次、保留 Session/目录、恢复核查说明、旧报告失效、unknown Effect/job 阻塞 |
| T20 / #48 | 已实现；未发布 | [验收记录](t20.md)：持久 Host 租约/epoch、显式过期接管、守卫存储、旧 Host 写入拒绝、两个真实进程竞争 |
| T21 / #49 | 已实现；未发布 | [验收记录](t21.md)：有界证据卡片、UTF-8 分页、Worker read_context、来源归属隔离、聊天同源入口 |
| T22 / #50 | 已实现；未发布 | [验收记录](t22.md)：max-tokens 触发 DSH fork、Session/Assignment 交接、旧历史可读、交接记录与启动恢复 |
| T23 / #51 | 已实现；未发布 | [验收记录](t23.md)：版本化角色/模型/指令/技能、CAS 冲突、请求边界生效、每 Session use 记录、提示词不扩权 |
| T24 / #52 | 已实现；未发布 | [验收记录](t24.md)：公开监督读模型、需要人处理优先排序、分项 health、回答/停止/恢复/setup/重试入口、同源刷新 |
| T25 / #53 | 已实现；真实信道验收完成；未发布 | [记录](t25.md)：真实 `gh api` 传输、Issue/PR/评审/CI 事件、404 与删除依据、复合 cursor 派生版本；隔离仓库 `SuperAgentTest` 的 Issue #13 / PR #14 / review / check run 实测，持久轮询 start→pass→stop |
| T28 / #56 | 已实现；真实隔离运行完成；未发布 | [记录](t28.md)：时区与 DST 边界、revisioned rule 与 occurrence 证据、持久游标、补发策略、暂停保留、Gate 接入；真实 3.4 s 计划运行 4 个连续 occurrence，重启 0 重复 |
| T30 / #58 | 代码完成；既有协议回归通过；真实信道未验收 | [记录](t30.md)、[审查](reviews/t30.md)：FeishuRuntime 组合 OpenAPI/poller/成员同步/Engine、精确 app+tenant+chat 来源、持久后确认分页、话题补读、未知版本原子转 unknown 并按原回执去重、成员 revision 冲突；真实群与权限未运行 |
| T31 / #59 | 代码完成；既有协议回归通过；真实信道未验收 | [记录](t31.md)、[审查](reviews/t31.md)：官方 reply 默认原位/话题语义、持久原生回执、uuid 重试、55 分钟安全窗口、transient/permanent/删除/未知分类、范围查询、问题→授权回答→结果链路；真实群未运行 |
| T26 / #54 | 已实现；真实仓库验收完成；未发布 | [记录](t26.md)：真实 PR #14 创建、评审、CI 完成、ready 保持 open、结果送达后合并结束；多 PR、draft 与承接延迟由单测覆盖 |
| T27 / #55 | 已实现；真实 owner 授权→GitHub 方向与 outbound 验收完成；未发布 | [记录](t27.md)、[审查](reviews/t27.md)：隔离 PR #14 的三类原生负例、合法 A→B、原 Ticket/Assignment/Session/Mandate 保留、方向版本 2、真实 GitHub POST/读回/回执对账；mock 模型，桌面 UI 与完整产品链仍由 T55 验收 |
| T29 / #57 | 已实现；真实模型样本完成；未发布 | [记录](t29.md)：版本化规则、当前来源事件证据、observe/auto、重复 bot/CI 回声抑制、slug 隔离目录、run/产物字节预算、SHA-256 核验；真实模型 4 次请求 + 真实调度组合，0 副作用 |
| T32 / #60 | 已实现；真实第二设备验收完成；未发布 | [记录](t32.md)：配对 pin、AEAD 加密 RPC、Instance/Environment/Actor 授权与撤销、设备侧 fs/search、相对结果、远端 Assignment 位置、无本地回退；Windows→Linux 云服务器真实跨机验收，Node 22/24 各 269/269 |
| T33 / #61 | 已实现；真实第二设备验收完成；未发布 | [记录](t33.md)：设备解析 executable、固定命名命令、稳定 Instance/Environment/incarnation 作业 ID、同 ID 异参拒绝、启动响应丢失按原 ID 对账、非消费字节偏移与 UTF-8 边界、同步公开 handle、断连续读、作业持久记录与 daemon 重启 unknown、取消重试确认；最终代码真实 Windows→Linux 设备 9/9（初验 10/10 另覆盖 quick 与两作业隔离），Windows 全量 283/283 |
| T34 / #62 | 已实现；真实第二设备 PTY/进程组验收完成；未发布 | [记录](t34.md)：真实 node-pty 终端流/写入/尺寸/终止、POSIX 进程组与 Windows taskkill 范围、root exit 与 settled 分离、pending-device-confirmation、离线 stop 不伪报 cancelled、原 job ID inspect/cancel 与 reconcileStop；真实 Windows→Linux 设备 2/2 |
| T35 / #63 | 已实现；真实第二设备 daemon 重启验收完成；未发布 | [记录](t35.md)：v2 设备作业记录保存 owner/incarnation/进程身份/deadline/输出/恢复证据；live-process、log-only、identity-changed、unverifiable 分类；Host 按稳定 ID 接管或提问；starting intent 覆盖后台与前台命令；离线 stop 的日志恢复确认；协议 v2；Windows 全量 295/296（1 项 POSIX-only skip），Ubuntu 恢复测试 8/8 + 1 skip，Windows→Ubuntu 跨机 26/26 |
| T36 / #64 | 已实现；实际本地+远端双模式闭环完成；未发布 | [记录](t36.md)：revisioned Instance execution policy、Ticket local-only/remote-only/auto、Assignment 一次固定、auto allowlist/online/能力/目录/version/fingerprint/capacity 证据、等待与幂等 retry、follow-up/retry 不绕过、fingerprint 重验、协议 v3；Windows 全量 302/303（1 项既有 skip），Ubuntu T36 7/7 |
| T37 / #65 | 已实现；真实第二设备附件/spill/技能验收完成；未发布 | [记录](t37.md)：环境绑定附件/artifact/spill/技能引用、按 Instance+Environment 命名空间的内容寻址存储、1 MiB 完整输出与字节分页、公开 `dsh-skill` provider 的本地/设备技能目录、Engine 能力查询与断连续查、未支持组合缺口；Windows 全量 311/312（1 项既有 skip），Ubuntu T37 9/9，Windows→Ubuntu 10/10 |
| T38 / #66 | 已实现；Windows 本地/远端位置界面证据完成；未发布 | [记录](t38.md)：Instance 能力目录、Host 浏览器/MCP 声明、Office 的 skills+命令条件、Ticket/intake 能力要求、selection 阻止远程未验证能力、Engine 与 chat 能力位置查询；Windows 全量 322/323（1 项既有 skip），Node 24 CI 绿 |
| T39 / #67 | 已实现；真实 Linux 第二设备验收完成；未发布 | [记录](t39.md)、[审查](reviews/t39.md)：Git worktree 预检、base commit + modified/untracked + patch 哈希、目标冲突/commit/预算 blocker、prepare/verify/get 公开查询、设备 `workcopy.inspect`；Windows Host → Ubuntu device 4/4，10.5 s；Windows 全量 331/332（1 项既有 skip） |
| T40 / #68 | 已实现；真实第二设备双向验收完成；未发布 | [记录](t40.md)、[审查](reviews/t40.md)：持久 handoff-requested/blocked/flushing/switching/completed、目标与副本复核、安全边界与 relay gate、Session flush、旧代结束和新代绑定、交接提示、旧回调隔离；Windows Host → Ubuntu device 2/2，11.6 s；Windows 全量 336/337（1 项既有 skip） |
| T41 / #69 | 已实现；中断交接恢复与 stop 优先验证完成；未发布 | [记录](t41.md)、[审查](reviews/t41.md)：requested/flushing/switching 重启先对账再继续、单条失败不阻塞其余、stop/暂停/waiting-human/unknown relay 优先、目标离线保持 blocked、blocker nextOwner 与聊天交接面板；Windows 全量 342/343（1 项既有 skip，--test-concurrency=2） |
| T42 / #70 | 已实现；真实隔离 PostgreSQL 契约与提交对账验证完成；未发布 | [记录](t42.md)、[审查](reviews/t42.md)：PostgreSQL 业务库、Instance 固定锁序、READ COMMITTED、有界重试、COMMIT 丢应答对账、锁内备份/升级/恢复、公开 Engine/Effects；Node 24 PostgreSQL 专项 22/22；全量对照 362 pass/1 fail/1 skip（ConPTY 就绪超时，未全绿） |
| T43 / #71 | 已实现；真实隔离 PostgreSQL 共享 Session 与公开 DSH loop 验证完成；未发布 | [记录](t43.md)、[审查](reviews/t43.md)：Storage 上的共享 Session provider、PostgreSQL advisory-lock writer 租约与 durable epoch、跨进程争用/崩溃接管、租约断开与旧 epoch 拒绝、真实服务器故障与 COMMIT 丢应答、provider 替换与构造记录 announce 屏障；Node 24.22.2 / Node 25.4.0 全量均 376 pass/0 fail/1 skip（既有 skip），T43 定向 12/12 |
| T44 / #72 | 已实现；真实两进程共享 PostgreSQL 的替换/复活校验完成；未发布 | [记录](t44.md)、[审查](reviews/t44.md)：epoch + 进程身份 fencing、pending takeover 与准入、旧 Assignment/Session/Environment 承接、live 设备作业按稳定 ID 改绑、stop/waiting/撤权优先、未知副作用转为人工问题；Node 24.22.2 全量 388 项 387 pass/0 fail/1 skip，接管定向 10/10 + 真实两进程 1/1 + 交接恢复 6/6 |
| T45 / #73 | 已实现；独立进程断连/补读与撤销验收完成；未发布 | [记录](t45.md)、[审查](reviews/t45.md)：一次性客户端凭据、按 Instance 的 read/command 授权、即时撤销、TLS 专用入口、持久事件游标与去重回执、Attention/result 历史补读、loopback 管理面；Node 24.22.2 全量 397 项 396 pass/0 fail/1 skip，T45 定向 9/9；真实桌面到隔离 Host 组合留待 T55 |
| T46 / #74 | 已实现；Windows 真实 App + 真实 DSH 常驻、关窗/二次启动/退出/强杀恢复验收完成；未发布 | [记录](t46.md)、[审查](reviews/t46.md)：托盘 Host 状态与关闭/退出区分、休眠/唤醒重连或替换、启动失败重试、Host 数据锁、升级保留 preset/用户配置且不改业务/Session；Windows 11 / Node 24.22.2 app 全量 244 项 243 pass/0 fail/1 skip，check-lifecycle 6/6，check-resident 5/5；真实 OS 休眠未运行 |
| T47 / #75 | 已实现；Windows 本机 + 共享 PostgreSQL Watchdog 恢复演练完成；未发布 | [记录](t47.md)、[审查](reviews/t47.md)：独立 Watchdog CLI/进程适配器、小时巡检、服务/组件/setup 分类、五分钟优雅停止、租约/接管恢复、观察/动作/结果/版本/预算与去重、通知失败重试；全量 418 项 417 pass/0 fail/1 skip，watchdog 16/16，process 3/3，CLI 2/2，两配方 epoch 1→2、takeover resumed；远程托管/真实设备/睡眠未运行 |
| T48 / #76 | 已实现；确定性正常等待/循环/偏离与独立 Session（mock 模型）验收完成；未发布 | [记录](t48.md)、[审查](reviews/t48.md)：目标/Mandate/报告/工具/交付进度、独立 Semantic Session、持久提案/证据/版本/预算/去重、unknown 先对账、原子批准/拒绝、pause→stop、correct→direction input、supervision 可见；串行全量 436 项 435 pass/0 fail/1 skip，supervisor 14/14、engine 2/2、session 2/2；真实模型/聊天 UI 未运行 |
| T49 / #77 | 已实现；受信指令、约束校验、revision/草稿/版本与独立 Session（mock 模型）验收完成；未发布 | [记录](t49.md)、[审查](reviews/t49.md)：authoringActorIds、提示词/skills 与 mode/rules 变更、模型/预算/allowlists/tools 固定、必需 placeholder/大小、instruction applying/幂等、config-draft、直接 settings 权限、Supervisor 无写入口；config 17/17、session 4/4，串行全量 457 项 456 pass/0 fail/1 skip；真实模型/UI 未运行 |
| T50 / #78 | 已实现；只读 archive staging/verify/publish、zstd Session、原引用读取与真实 app importer 演练完成；未发布 | [记录](t50.md)、[审查](reviews/t50.md)：source identity/profile、prepared staging、batch 幂等/冲突、Session 格式/缺失/副本校验、roles/sharedMemory 映射、review 项、无 old loop/Main Bot 权限；legacy-archive 9/9 + app importer 1/1，串行全量 467 项 466 pass/0 fail/1 skip；Engine 接入/切换/UI 未运行 |
| T51 / #79 | 已实现；持久 quiescing/quiesced、旧消费/重启入口停用、真实端口隔离、空窗输入缓冲与旧回执/游标对账、真实双进程演练完成；未发布 | [记录](t51.md)、[审查](reviews/t51.md)：Host lease epoch 复核、旧 home 锁只作证据、turns/jobs/outbound/cursor/receipt 两次 snapshot、实际 launcher 重命名与 loopback bind、gap 稳定 ID 的 held/legacy-accepted/quarantine、中断后恢复、无 Ticket/Effect/旧 accepted 重派；switchover 4/4 + process drill 1/1，串行全量 472 项 471 pass/0 fail/1 skip；激活/真实旧核心适配/UI 未运行 |
| T52 / #80 | 已实现；原子 activation manifest、当前入口 gate、gap 按原 ID 释放、真实退出/丢应答对账、隔离目录新 Session/stop/旧 review 验收完成；未发布 | [记录](t52.md)、[审查](reviews/t52.md)：quiesced 最终复核、Host lease owner/epoch、activation/command/history/gap ledger 同事务、`CORE_NOT_ACTIVE` gate 覆盖 receive/accept/Effect、held release + legacy/quarantine skipped、插件 gate 配置、真实旧 launcher/activation 子进程退出与 owner 拒绝、mock 新 Session 与人工 stop；activation 6/6 + process 1/1，串行全量 479 项 478 pass/0 fail/1 skip；跨进程 holder/真实 Electron/用户数据迁移未运行 |
| T53 / #81 | 已实现；激活前 abandon、激活后 reverse handoff、旧入口重启与真实中断/新 epoch 恢复、旧队列不重放完成；未发布 | [记录](t53.md)、[审查](reviews/t53.md)：held/quarantine 阻塞 abandon、batch-2 archive 保留、activation stopping gate、turns/jobs/outbound/unknown/receipt/compatibility blocker、final compatibility 复查、switchover 完成时 abandoned、真实 held gap 释放与旧 receipts 为空、新 Host epoch 恢复同一 reverse；reversal 8/8 + process 1/1，串行全量 488 项 487 pass/0 fail/1 skip；宿主 stop 适配器/真实 Electron/用户数据迁移未运行 |
| T54 / #82 | 已交付等负载 mock 比较与预算记录；真实部署对照未验收；未发布 | [记录](t54.md)、[审查](reviews/t54.md)、[结果](t54-bench.json)：三模式均处理 6 个初始 + 6 个跟进事件，全部 Worker turn 收敛后才计时；single 799.15 ms、Router/Worker 1727.01 ms、subscription direct 1622.33 ms，并记录 digest、outcome、持久序列、重复检查和 delivery ledger；真实模型 token、远端/托管 Host、unknown/proactive/supervisor 重跑和崩溃恢复未验证 |
| T55 / #83 | 已汇合证据与固定场景验证；完整产品未验收；未发布 | [记录](t55.md)、[审查](reviews/t55.md)、[54 票证据核验](t55-evidence.md)、[环境及缺口归属](t55-environments.md)、[第二设备](t55-second-device.md)、[既有回归](t55-regressions.md)：T27 真实 GitHub、T54 等负载、原 UI 后端 seam 和 Windows 回归已更新；生产 factory、产品 profile、真实模型/信道、托管 Host/第二设备组合由 T56–T60 承接，T55 只做最终汇合 |
| T56 / #90 | 已实现；未发布 | [记录](t56.md)、[审查](reviews/t56.md)：production factory、`botExecutionAdapter` 服务、`resolveAgent` facade、close 生命周期；真实子进程通过 `ds-bot` `install()/executionDispatch()` 完成 prompt/deliver/stop/resolveAgent，重启重放同一 Ticket 且不重复；UI 零 diff。真实模型/信道和 app 打包/托管组合仍归 T57/T58 |
| T57 / #91 | 已收口；真实模型、主动准备与 GitHub 通过；飞书由维护者暂缓 | [记录](t57.md)、[证据](t57-evidence.json)、[审查](reviews/t57.md)：公开 `LlmAdapter`、凭据安全环境检查、真实 Worker/Supervisor/配置解释器样本、真实 GitHub Issue/PR/review/check 与原生外发回执；飞书 tenant/群缺失，环境检查明确 `unverified`，维护者于 2026-11-13 明确暂缓并收口 |
| T58 / #92 | 部分验收；真实托管 Host/PostgreSQL/客户端/设备/Watchdog 已完成 | [记录](t58.md)、[证据](t58-evidence.json)、[审查](reviews/t58.md)：Ubuntu 真实 Host、PostgreSQL 业务与 Session、真实模型、SSH 隧道客户端、断连补读/即时撤销、Ubuntu 设备文件与命令、daemon 重启后重连、Watchdog epoch 4→5；T56 factory/T59/T60 远程 UI、离线 stop/resume、双向交接和飞书仍未完成 |
| T59 | 已实现；未发布 | [记录](t59.md)、[审查](reviews/t59.md)：独立 `ds-superagent` profile、`DSH_HOME` 隔离、`botExecutionAdapter` 服务、`executionAdapterRequired` fail-closed、stop/resume；真实 `runProfile` 启动与 profile 进程测试通过；不复制前端 |
| T60 | 部分实现；未达验收 | [记录](t60.md)、[审查](reviews/t60.md)：复制 `ds-bot` 聊天源码为 `ds-superagent-ui`，独立 build id 和生成检查通过；真实 profile 可发送并读取 Engine 请求/结果。仍使用 `/api/bot` 桥接旧 Host，窄接口、面板隐藏、主聊天投影和 Attention/stop/resume 未完成 |

上述已实现票的前置实现为 T01；实施状态与 GitHub 发布状态分别记录。2026-11-05 回查发现原 T02/T04/T17 工作树注册指向不存在的目录，不能用旧“实施中”记录证明实现进展。本轮 T17 交付共用的事务更新、删除、有界扫描与新连接契约；T04 已在该公开契约上恢复并完成。

集成 PR：[#86](https://github.com/IceFireIcer/DS-SuperAgent/pull/86) 已合并到 `dev`（merge commit `f512c3e`，2026-11-08），尚未发布。T01–T24 已实现；T25–T27 已完成隔离真实 GitHub 仓库的接收、交付条件与交付目标验收（模型仍为 mock）；T28 已完成真实隔离计划运行；T29 已完成真实模型小样本与调度组合验收；T30 已交付飞书 OpenAPI 传输与归属语义；T31 已交付飞书就地回答与可靠交付（T30/T31 的真实群运行由维护者暂缓）；T32 已交付远端设备配对、加密 fs/search，并在 Windows→Linux 临时云服务器上完成真实第二设备验收，Node 22/24 各 269/269；T33 已交付远端稳定身份命令、非消费输出续读、断连恢复和真实第二设备验收；T34 已交付远端 PTY/进程组停止、pending-device-confirmation 和原范围查询；T35 已交付 daemon 重启的 live/log-only 分类、原 ID 接管、starting intent 和一次带证据的问题，并完成 Windows→Ubuntu 跨机 26/26；T36 已交付 Instance/Ticket 目标策略、auto 证据、Assignment 固定和 v3 status，并完成实际 Local+Remote 双模式闭环；T37 已交付环境绑定附件/spill/技能引用、命名空间资产库和公开技能 provider，并完成 Windows→Ubuntu 跨机 10/10；T38 已交付能力位置目录、Ticket 能力要求和本地/远端阻止证据；T39 已交付 Git 工作副本预检/核验、配对设备 `workcopy.inspect` 和 Windows→Ubuntu 4/4；T40 已交付安全边界双向执行环境交接、目标与副本复核、旧代结束和新代绑定，并完成 Windows→Ubuntu 2/2；T41 已交付中断交接的重启对账、stop/暂停/unknown 优先、离线阻断和 blocker 责任人投影；T42 已交付 PostgreSQL 业务库后端、Instance 锁序、提交对账与版本化 schema 升级；T43 已交付共享 PostgreSQL Session provider、advisory-lock writer 租约、跨进程恢复与旧 epoch 拒绝；T44 已交付服务器 Host 的合法替换、对账与旧进程 fencing；T45 已交付认证客户端入口、断连游标补读、即时撤销与 loopback 管理面，真实桌面到隔离 Host 组合留待 T55；T46 已交付 Windows 常驻 Host 的窗口/服务状态、休眠恢复、启动重试与 Host 数据锁，并完成真实 App + 真实 DSH 常驻验收；T47 已交付独立 Watchdog CLI/进程适配器、分类恢复、预算/去重与 Windows 本机 + 共享 PostgreSQL 演练；T48 已交付语义 Supervisor、独立 Session、持久提案/预算/去重、unknown 先对账、原子批准与真实 direction input；T49 已交付受信行为配置指令、authoring 权限、prompt/trigger 约束、revision/草稿/版本、独立 Session interpreter 与硬限制；T50 已交付只读历史档案的 prepared staging、校验/发布、原引用读取、角色/共享记忆映射与真实 app importer 演练；T51 已交付 quiescing/quiesced 持久状态、Host epoch 复核、旧 launcher/重启入口停用、真实 loopback 入口隔离、空窗输入 held/legacy-accepted/quarantine 与旧回执/游标对账，并完成真实旧/新双进程演练；T52 已交付原子 activation manifest/当前入口 gate、held gap 按原 ID 释放、旧 accepted/quarantine 不重派、真实 activation 子进程退出与 owner 拒绝，并完成隔离目录 mock 新 Session/人工 stop/旧 review 验收；T53 已交付激活前 abandon、激活后 reverse handoff、旧入口重启、final compatibility 复查、真实中断/新 epoch 恢复与旧队列不重放；T54 已交付固定 mock 事件流三模式对照、p50/p95、Router/直通、重复/状态重开、预算表和未验证项；T55 已开始汇合证据与固定场景验证，完整产品仍未验收；当前真实 OS 休眠、远程托管、真实设备/真实模型与真实应用切换/UI 的缺项见 [T55](t55.md)。增量双轴审查见 [T01](reviews/t01.md)、[T17](reviews/t17.md)、[T02](reviews/t02.md)、[T03](reviews/t03.md)、[T04](reviews/t04.md)、[T05](reviews/t05.md)、[T06](reviews/t06.md)、[T07](reviews/t07.md)、[T08](reviews/t08.md)、[T09](reviews/t09.md)、[T10](reviews/t10.md)、[T34](reviews/t34.md)、[T35](reviews/t35.md)、[T36](reviews/t36.md)、[T37](reviews/t37.md)、[T38](reviews/t38.md)、[T39](reviews/t39.md)、[T40](reviews/t40.md)、[T41](reviews/t41.md)、[T42](reviews/t42.md)、[T43](reviews/t43.md)、[T44](reviews/t44.md)、[T45](reviews/t45.md)、[T46](reviews/t46.md)、[T47](reviews/t47.md)、[T48](reviews/t48.md)、[T49](reviews/t49.md)、[T50](reviews/t50.md)、[T51](reviews/t51.md)、[T52](reviews/t52.md)、[T53](reviews/t53.md)、[T54](reviews/t54.md)；这不是全部规格的最终审查。远程 CI 证据需以当前推送头为准。

Linux 实机复核覆盖 T01–T36 的平台差异、负载脚本、调度、T32 设备重启/授权变更、T33 远端命令/作业、T34 PTY/进程组、T35 daemon 恢复和 T36 目标选择，见 [Linux 实机验收审计](linux-acceptance.md)。

## 初始回归基线

在原有 `14a692d` 上运行：`ds-bot` 单测 1431 通过、2 跳过、0 失败；生成一致性通过；lint 退出 0（保留既有警告）；已跟踪文件的泄漏扫描退出 0。此基线不是新核心或总体规格的验收结果。

## 分支与工作树核查

开始或结束一张实施票时，在目标仓库内执行只读检查：

```sh
node scripts/branch-status.mjs
node scripts/branch-status.mjs --base dev
```

默认比较本集成分支，也可通过 `--base` 指定本地分支。JSON 输出包含比较基线的提交、当前分支（detached HEAD 时为 null）、工作目录是否干净、各本地分支相对基线的独有提交数、是否已经合入、关联工作树路径及其存在/prunable 状态。有上游时显示本地记录的 ahead/behind；上游引用缺失时显示 upstreamMissing，不把缺失误报为零。

该工具只读取本地 Git 事实，不 fetch、不清理、不删除。远程计数取决于最后一次 fetch；没有独有提交不证明票已完成，也不证明不存在其他目录中的未提交工作。验收状态仍以逐票实现与审查证据为准，main/dev 等保留分支不会因已合入就成为删除对象。

2026-11-05 清理已完成：逐一确认 T01/T02/T04/T17 的旧分支均为当前集成提交的祖先，且四个原工作树目录不存在后，使用 `git worktree prune` 清除失效注册，再用 `git branch -d` 删除这四个本地分支。保留 main、dev 和当前集成分支；未删除远程分支或实际工作目录。后续票从最新集成提交创建实际需要的工作分支。

测试入口为 `node --test scripts/*.test.mjs`，与扫描器既有回归测试一起进入 CI 的 scan job。CI 的 `changes` job 用 `scripts/change-scope.mjs` 按改动路径选择作业，`scripts/check-ci-result.mjs` 汇总必需的 Test result：本次改动需要的作业被跳过或未通过都会失败。新核心 CI 只验证 Windows Node 24。

需要复现并发竞态时，用 `npm run test:stress -- test/<file>.test.mjs --runs 80 --concurrency 8`。脚本只构建一次，为每次运行保留独立日志，并汇总失败率、失败测试、最后完成的测试节点和可选的 trace 行。日志写入 `.dsh-test-stress/`，不进入仓库。

等待 CI 时，用 `node scripts/ci-watch.mjs <run-id>`（可加 `--jobs test,scan`、`--timeout`、`--json`）。它拒绝 head 与当前 `HEAD` 不一致的 run，只在作业状态变化时输出；失败时列出失败步骤并抓取精简日志。令牌只从 `gh` 的环境读取，不写入仓库。

维护实施或审查记录时，运行 `node scripts/check-implementation-records.mjs --check-refs`。它校验提交占位、Markdown 相对链接、T01–T60 的票/实施/审查覆盖，并只把带十六进制字母的 7–40 位引用当作 commit；CI run ID 和普通数字不再误报。T57/T58 当前是计划中票，暂不要求实施/审查记录；T60 已有部分实现记录但尚未通过验收。历史审查与链接缺口在脚本的 `reviewDebt`/`linkDebt` 中显式列出，新增缺口直接失败。CI 使用不要求完整 Git 历史的检查。每轮审查标明实际目标版本；后续修复单独记录测试和复审结果，远端 CI 只为对应的推送 SHA 提供证据。跨模块验收应从实际调用入口覆盖相关模块；适配器测试只能证明该适配器的契约。
