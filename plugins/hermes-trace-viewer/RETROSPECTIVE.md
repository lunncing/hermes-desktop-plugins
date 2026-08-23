# Hermes Trace Viewer：开发复盘与经验总结

## 一、项目目标

目标是在不修改 Hermes 核心源码的前提下，通过 Desktop Plugin SDK 实现接近 DSH Trace Inspector 的可视化轨迹页：Session 选择、Input/Model/Tools 三泳道时间线、按 Turn 分组的节点列表、详情面板、搜索与筛选，并为未来结构化 `trace.*` 后端接口预留 adapter 边界。

项目最终形成了一个只读插件。它最多读取 500 条消息、100 个 Session，并将实时事件队列限制为 1,000 条；Preview/Raw 对常见敏感键进行递归脱敏。当前后端没有提供逐轮 Context 来源和精确耗时，因此插件明确标记这些能力不可用，而不伪造数据。

## 二、错误演进

### 1. 首版：功能完成不等于真实界面可用

最初版本在 Node 测试中通过了数据归一化、Session 读取、事件清理和注册契约，但真实 Desktop 出现大面积重叠。原因是运行时插件不会被 Hermes 的 Tailwind 构建扫描，`h-[min(...)]`、`grid-cols-[...]` 等任意值类没有进入打包 CSS。测试环境只检查了 class 字符串存在，没有验证打包后是否真的有对应规则。

### 2. V3：修复了类名，却仍然错误建模宿主组件

V3 将关键高度和网格列改为 inline style，18 个测试全部通过。但实景复验仍发现：

- 未选择节点时，`选择轨迹节点` 覆盖 REASONING 行；
- 选择节点后，状态、时间戳等详情字段覆盖列表；
- TraceList 边框结束后，Assistant/Reasoning 行仍继续绘制。

进一步检查发现两个问题：`DetailPanel` 的无节点分支直接返回裸 `EmptyState`，绕过了详情面板外框和约束；测试又把 `ScrollArea` 当作普通字符串组件，无法模拟真实 Radix Viewport 的滚动和溢出行为。

### 3. V4：减少宿主魔法，拥有自己的布局边界

V4 不再让两个关键面板依赖 Radix `ScrollArea`。TraceList 与 DetailPanel 使用有边框、定高、`overflow:hidden` 的 flex-column 外壳；内容进入普通滚动 `div`；空状态和选中状态始终使用同一个 `aside`；宽窄分栏使用明确的 inline grid；页头增加 `布局 V4 / Layout V4` 标记。

测试从“查源码字符串”升级为“遍历渲染元素树并验证父子关系和 style props”。最终为 25 个测试，连续运行 10 轮，共 250 次通过。

## 三、审查流程的教训

V3 按临时分工只由 Hermes 审查，真实 GUI 仍暴露问题。V4 恢复 DSH 编写、Codex 独立审查、Hermes 最终验收。

Codex 第一轮虽给出 `PASS`，但没有具体代码行号，被判定为降级审查并拒绝。第二轮要求完整读取 5/5 变更文件，核对基线 diff、SHA-256、测试和截图，即使无缺陷也必须引用关键实现和测试行号，并证明审查前后 Git 状态一致。第二轮才作为正式 `PASS`。

经验是：**审查结论必须可复核，不能只看 verdict。**

## 四、自动化与实景验收的边界

| 证据 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 源码检查 | 代码写了什么 | 打包 CSS 是否包含该规则 |
| Node 测试 | 数据、元素树和生命周期契约 | Electron/Radix 的真实像素行为 |
| Codex 审查 | 独立发现代码和测试缺陷 | 用户是否觉得界面清晰 |
| Packaged Desktop | 实际加载、滚动、边框和重叠 | 长期回归不会发生 |
| 用户截图 | 真实失败位置和视觉结果 | 根因与最小修复 |

以后必须分层报告，不再把“测试通过”或“插件已加载”写成“真实 GUI 已验收”。

## 五、工具与工作区纪律

DSH 曾为了从 WSL 使用 Git 而改写 worktree `.git` 指针并规范化 `.gitignore`，导致 Windows Git 失效。之后的规格明确禁止修改这两个文件，Hermes 恢复元数据并验证最终只有允许的交付文件变化。

模型路由必须现场核验。本项目后期 DSH 使用 `qwen-token-plan-cn/qwen3.8-max-preview`；因为不是 `deepseek-v4-pro`，没有运行只为 V4 Pro 校准的 `let me` 轨迹判定，但保留以后切回时恢复监控的能力。

## 六、今后的强制规则

1. 运行时插件的关键几何使用 inline style 或确定加载的 CSS，不依赖未验证的 Tailwind 任意值类。
2. 宿主组件 mock 必须模拟真实结构；无法可靠模拟时，减少依赖并使用原生 DOM。
3. 条件分支保持相同外框和约束，空状态不得绕过布局容器。
4. 每个候选版本提供可见 revision marker。
5. UI 修复按“失败截图 → RED → DSH → Codex → Hermes → Packaged Desktop → 用户确认”执行。
6. Codex 审查必须有基线、完整 diff、测试、文件清单、具体行号和只读证明。
7. DSH 不得修改 worktree 元数据、配置或安装目录；部署由 Hermes 完成。
8. 安全脱敏、容器上限、监听器清理和无轮询保持为回归测试。
9. 公共仓库不上传个人截图、内部审查包、本机绝对路径或凭据。

## 七、后端扩展边界

插件层无法完整复刻 DSH 的 Context、模型请求、工具起止、retry、fallback 和 compression 事件。UI 只依赖标准化 adapter，未来可增加 `trace.list`、`trace.get`、`trace.subscribe`，无需重做页面信息架构。

## 八、发布状态

V4 已通过 25 个自动测试、10 轮重复测试和 Codex 全代码审查。上传时，最终 Packaged Desktop 像素验收仍应由用户完成，因此不能描述为已经完成人工视觉确认。真正关闭问题的标准是：V4 标记可见，空状态、选中详情、长列表边框和窄屏堆叠均由用户确认无重叠。
