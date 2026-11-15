# 脑端产线规划：实现与验收

2026-11-15。实现和验收已完成，待用户决定是否合并。开发分支 `feat/brain-production-planner`；本次验收的运行代码为 `450f1a6`。main / origin/main 保持 `3f9a4fd`，没有推送或部署规划器，没有更换身体或重启正式游戏服。

## 交付了什么

- 一个 `production_plan` 库函数，供两条线、查想子思维和沙箱程序调用。模型从本地配方取得原版 Recipe / Node / 机型配置，自己构造、修改原版英文 FactoryProject，再计算、保存和比较，不要求主人先画图。
- `describe / reference / solve / read / list / export`。reference按类型或字段查完整英文声明与注释，不只给一个简单示例；原图和结果不经过物品名中文化或未知字段删除。
- 原版 TypeScript 机器数学及配平器、HiGHS WASM在脑端worker运行，不依赖客户端、JVM、网页账号或在线下载。输入/图规模/实际LP矩阵有预算，取消、忙、超时、缺资产和失败均明确区分。
- 分开记录原版总值、实际平均电耗、整数机台满速电/汽需求、目标、短缺、强制补料/排料、外部供料和一次性准备条件。计算结果不能冒充库存足够或工厂已经运行。
- 不可变分析记录保存完整原图、当前绑定快照、原版报告、输入/运行文件hash和逐请求回执。目录只读紧凑元数据，详细内容分页和完整导出。
- 面板「知识 → 产线规划」只读查看机器、能耗、流量、目标、诊断、来源和原始数据，下载完整分析或原始计划；没有施工、发任务、修改既有方案的按钮。

来源、作者和MIT许可已在根README对应模块、NOTICE和vendor许可文件中注明。使用原版 [GTNH Factory Flow](https://github.com/jackwrichards/gtnh-factory-flow) `e493e36a`、[GTNH Planner](https://github.com/jackwrichards/gtnh-planner-mod) `69dd09fe` 的目录/参考及HiGHS 1.15.2；不依赖汉化发布。修改与输入/输出hash见 `brain/vendor/gtnh-planner/provenance.json`。vendor原始字节保持不变，Git把这些文件标为vendored/generated；原版留白不作格式化修改。

## 真正跑过的入口

| 入口 | 验证内容 | 结果与证据范围 |
|---|---|---|
| 原版计算器 | 31份存储输入及platline-x4/x10；完整solution、alternatives、spares，按上游1e-6规则比较 | 全部一致；不是只检查一个solved标记 |
| 机器数学 | 普通/完美超频LV/MV/HV、机器golden代表样本；与独立Java无MC探针结果对照 | 覆盖样本一致，不宣称本服每台特殊机器实机验证完毕 |
| 本地真实packdata→工具 | 黏土球→砖、两段黏土链、混凝土水量、概率副产物、EBF；describe→构图→solve→read→改目标再算 | 模具count0作为非消耗条件；流体按mB；概率明确为长周期期望；旧记录不被覆盖 |
| 真实Lines与Helpers | 脚本模型通过实际run_program/库函数入口构图；两条线、helper各自生成记录；工作轮停止后取消本次计算，下一轮可再算 | 真沙箱、真引擎和记录，模型/游戏边界是脚本；没有task.start等身体动作 |
| 独立脑进程＋HTTP模型适配器 | 新数据目录，无游戏口令；从面板发指令→本地脚本HTTP模型→查英文类型→查本地配方→自行拼原版图→求解→读取→面板导出 | 实际调用整套main装配及OpenAI兼容HTTP适配器，无真实模型key、无游戏客户端/身体连接 |
| 发布目录 | 按tools/live相同排除规则打包已提交brain，删除node_modules/test/packdata，从另一cwd启动；只读指向真实本地packdata | 上一行整进程流程在发布副本通过；WASM、机器目录、引用文档和许可完整，无JVM或运行时npm安装 |
| 面板浏览器 | 实际Chrome登录隔离面板；冲突状态、28节点分页尾部、能耗、完整分析/原始计划下载接口、393px窄屏 | 尾页26–28可读；两份下载均含28节点，分析另含完整报告；无页面横向溢出，表格自行横滚；HTML样式名称仅作文字，无脚本/图片执行 |
| 生命周期/限额/存储 | 活动/排队取消、deadline、busy、真正LP规模超限、缺WASM、worker恢复、异cwd；重启读取、非法ID/符号链接、损坏记录、完整分页、退出等待落盘 | 明确失败，不降级为假成功；主线程准备之前也受同一输入预算约束，准备时间计入总时限 |

### 发布副本的定量例子

最后的独立进程验收使用当次本地导出中的黏土球→砖配方（当次ref `114719`，不是跨导出稳定ID）。脚本模型读取实际工具返回值后构图，目标1砖/s，结果为：

- 持续供料：1黏土球/s；原版输入上限和产出目标均满足。
- LV配置下连续负载10台，建造数10台；平均20EU/t，整数设备满速20EU/t。
- 来源状态 `local-current`；报告仍为 `needs-external-supply`，没有说基地已经备齐原料/模具。
- 两次本地HTTP模型调用，实际HiGHS调用5次，simplex调用0、无fallback；结果留有输入、runtime和WASM的SHA-256。

这是对接口、计算和数据通路的验证。流程由脚本编排，**不是“真模型已经自主选出整条最优工艺并建厂成功”的验收**。

## 自审抓住并修复的问题

1. 原工具参数校验会丢掉原生对象字段，结果格式化又会改英文名：现在仅对显式原生载荷保留完整JSON，旧工具行为不变。
2. 上游schema漏掉kind/control字段，且parallel会round：验证不再悄悄改调用者原图，显式整数/必要字段在边界检查。
3. 原版仍可用forced补流满足产出，即使给定源已到上限：摘要必须读取forced/terminal/source而非只看deficit或目标数。
4. planning零seed能出现产量却报零功率；零pin连Exactly也可能被原版忽略：明确拒绝这些无效表达，不能伪称硬限制有效。
5. shared卡片缺省机型、运行档位、线圈或按配方解析的配置可能各不相同：现在验证实际解析配置一致；不自动替模型选最高档。显式未知机型也不能偷偷fallback。
6. GT导出省略的special是0，而非未知：恢复原版零热需求语义，同时保持原始快照；NBT实例、培养物、Fusion startup等确实缺项则明确限制。
7. Build保留名牌流量，Plan/Solve预缩放；蒸汽机的0EU不代表0能耗：实际量、平均与满速、蒸汽按原版规则分别报告。
8. Pool的负号、source默认Exactly、休眠product0不能按连线猜：直接复用原版role/target规则。
9. hatch-supply和共享section的内部ID空间可藏掉输入或覆盖结果：输入边界拒绝保留空间/冲突。
10. 资料被rename替换后旧RecipeBook仍持旧fd：检测加载源身份，要求重启，不给旧内容签新资料hash。
11. 准备工作曾发生在引擎限额/时限之前：现在先检查同一预算和取消，再建立有界快照，准备耗时从总deadline扣除。

上述核心经过独立只读审查、修复和定点复核；最终复核在其限定范围内无剩余阻塞。非消耗条件仍需按整数机台及实际配置准备；共享时间计算不替现场实现换配方/换模具调度，也不计真实物流和切换延迟。

## 总检与复跑

- `npm test`：951 passed，0 failed，0 skipped。
- `npm run typecheck`、面板JS语法检查、`git diff --check`通过。
- vendor在不同目录、以固定lock离线安装构建工具后重建，runtime/catalog/test-support/provenance字节一致。
- 常驻工具索引及两条线每轮工具预算未提高；单次未知工具报错的名字清单只增加新库函数名。
- 没改mod代码，不要求更换身体；不把已有Java/数学对照说成本次游戏实机工厂验收。

```sh
cd brain
npm run typecheck
npm test
# 任意已打包brain目录；无node_modules、无游戏连接亦可。
AIPLAYER_QA_BRAIN_ROOT=/path/to/release node --test test/planner-process.test.ts
# 可另只读指定当次本地资料和一个有效ref，走本地绑定路径：
AIPLAYER_QA_BRAIN_ROOT=/path/to/release \
AIPLAYER_QA_PACKDATA=/path/to/packdata AIPLAYER_QA_RECIPE_REF=114719 \
AIPLAYER_QA_RECEIPT=/tmp/planner-process-receipt.json \
node --test test/planner-process.test.ts
```

本机证据：`/tmp/aip/planner-acceptance-all.log`、`planner-final-packaged-process.log`、`planner-final-release-WmCoTM/receipt.json`、`planner-ui-qa/`。隔离UI服务已停止、测试标签页已关闭；没有使用正式模型key或派正式bot执行任务。

## 保留边界

- 算的是固定版本模型下的静态工艺图。现有库存不等于持续供料，循环可能需要启动料，实际电/汽/物流与机器成型必须另验。
- 缺NBT、培养物、启动能等必要事实时不假装精确；外部声明可按假设计算，但不能冒称匹配本服。
- 接受原版FactoryProject JSON，不解析gtnh1分享编码或网页链接；没有搬整个网站/客户端GUI，也没有一键施工。
- 下一步由用户决定是否合并。正式部署是另一个操作，本次未执行。
