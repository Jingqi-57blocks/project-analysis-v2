# PI-110 前置验证：claim identity 稳定性

不写代码的可行性验证，输入是已归档的对照实验产物 `.analysis/skill-trial/{sonnet,opus}/overview.md` 与冻结知识库 `.analysis/kb.sqlite`。

## 判定

**设计成立，可以进入实现，但 identity 的构成必须改。**

原设想的三个候选之一——"identity 由引用的 factIds 集合决定"——不成立，理由是硬性的而非偏好性的：知识库中多数 fact 的 `record_key` 内嵌文件行号，因此 factIds 会随任何一次无关的行位移而改变。以它为 identity，claim 集合在两次分析之间不可比，一致性与增量重生成同时失效。

定稿的规则是**谓词 + 主体**，factIds 降级为支撑而非身份。按此规则，20 对配对结论中 18 对算出相同 claimId，其余 2 对与 1 条 Opus 独有结论落在一个已量化的缺口里（见"已知缺口"）。

## 方法

从两份产物各抽取 20 条业务结论，人工判断哪些是同一条结论的不同表达，再对每一对检查候选 identity 规则能否算出相同 claimId。

40 条结论形成 **20 对配对**（覆盖 Sonnet 全部 20 条与 Opus 20 条中的 16 条），Opus 独有 4 条无法配对——它们是模型在原始事实上自行推导出的结果，Sonnet 未产出。

20 对中 **18 对结论一致，2 对互相矛盾**：

| 矛盾项 | Sonnet | Opus |
|---|---|---|
| 客户删除前是否校验在途项目/账单 | 未命中，因覆盖不全判"待确认" | 命中，`internal/handlers/clientProj/service.go:526` |
| 未使用的代码 | 未发现成规模的"有实现无入口"功能 | 135 个接口（539 个中的 25%）在工作区内找不到调用方 |

这两对是审计器最有价值的测试样本：它们是同一个谓词、同一个主体上的相反判定，而不是措辞差异。

## 三个必须回答的问题

### identity 由什么构成

**由谓词与主体构成，不含 factIds，不含成品句子。**

```json
{
  "claimId": "claim:table-written-by-multiple-services:wcp_leave",
  "predicate": "table-written-by-multiple-services",
  "subject": { "type": "entity", "ref": "wcp_leave" },
  "qualifiers": { "writers": ["wcp-service", "wcp-service-v2"] },
  "factIds": ["derived:structural-finding:tables-written-by-several-services", "..."]
}
```

`claimId = <predicate>:<subject.type>:<subject.ref>`。qualifiers 承载可变的量（数量、清单、判定结果），**不进入 identity**——这是让"同一条结论的两种说法"收敛的关键，也是让矛盾变得可检测的关键。

排除 factIds 的理由，实测：

| record_key 形态 | kind | 行号敏感 |
|---|---|---|
| `root\|path\|type\|name` | symbol | 否 |
| `root\|method\|path` | route | 否 |
| `root\|table` | entity | 否 |
| `root\|path\|target` | import | 否 |
| `<slug>` | structural-finding、health-signal | 否 |
| `root\|caller\|callee\|path\|line` | call-edge | **是** |
| `root\|\|entity\|op\|path\|line\|col` | data-access | **是** |
| `root\|subject\|op\|literal\|path\|line\|col` | condition | **是** |
| `root\|\|call-site\|path\|line\|col` | error-handling | **是** |
| `root\|test\|message\|path\|line\|col` | guard | **是** |
| `root\|path\|startLine\|endLine\|...` | decision | **是** |
| `root\|\|\|url\|path\|line\|col` | outbound-call | **是** |
| `root\|symbol\|kind\|name\|path\|line\|col` | auth-annotation | **是** |

行号敏感的 kind 合计 **20921 条，占 54253 条结构记录的 39%**——`call-edge` 11411、`data-access` 3185、`condition` 1957、`error-handling` 1729、`guard` 1060、`decision` 983、`outbound-call` 483、`auth-annotation` 113。在文件顶部插入一行空白，该文件下方全部此类 record_key 改变，引用它们的 claim 随之改变身份。请假、审批、鉴权这些最需要被写进报告的事实，恰好全部集中在这 39% 里。

排除成品句子的理由：View 层才有语言，statement 若是中文句子则语言无关性不成立，英文版与中文版会算出两套 claimId。

### factIds 有交集但不相等时算同一条还是两条

**算同一条。** identity 不看 factIds，因此这个问题在定稿规则下不再产生分歧。factIds 的差异体现为同一 claim 的支撑集合发生变化，由审计核对，不改变身份。

实测样本：请假模块的通知错误丢弃。Sonnet 引用请假模块内 13 条 `discarded-error` 记录，Opus 引用全系统 51 条。两者的 factIds 是子集关系。在定稿规则下，它们是两个不同主体上的同一谓词——`claim:outbound-error-discarded:module:leaves` 与对该谓词的汇总，不是同一条 claim 的两种引用。

### 概览与模块详情的粒度差异

**是父子关系，但父不是一条独立的 claim。** 概览里的聚合数字不持久化为 claim，它是对某谓词下 claim 集合的**汇总视图**，在渲染时由集合计算得出。

以问题中的原例验证：`tables-written-by-several-services` 在知识库中是**一条** `structural-finding` 记录，payload 的 `evidence` 数组含 7 张表。

- 模块详情产出 `claim:table-written-by-multiple-services:wcp_leave`，主体是表。
- 概览不产出"7 张表被多方写入"这条 claim，而是对谓词 `table-written-by-multiple-services` 的 claim 集合做汇总，数字由集合基数得出。

这样处理的收益是决定性的：概览说"7 张"与模块详情说"请假表"之间**结构上不可能矛盾**，因为前者由后者算出。审计器不需要判断"7 与 1 是矛盾还是粒度差异"——这个判断根本不必发生。

若反过来把聚合也做成一条 claim，两者的 factIds 完全相同（都只有那一条 derived 记录），按 factIds 会算出相同 claimId 却承载不同表述，直接冲突。这是 factIds 方案的第二个独立否决理由。

## 逐条测试结果

| 配对 | 结论 | 谓词 | 主体 | claimId 是否相同 |
|---|---|---|---|---|
| 1 | 后端之间无直接调用，耦合在数据层 | `no-inter-service-calls` | workspace | 是 |
| 2 | 早期服务未退役 | `service-not-retired` | root:wcp-service | 是 |
| 3 | 前端调用分布 | `frontend-call-volume` | root:各后端 | 是 |
| 4 | 各服务的表数分布 | `entity-count` | root:各后端 | 是 |
| 5 | 7 张表被多方写入 | `table-written-by-multiple-services` | entity:各表 | 是 |
| 6 | 28 张表结构声明不同 | `entity-declared-inconsistently` | entity:各表 | 是 |
| 7 | 12 个端点被多服务声明 | `endpoint-declared-by-multiple-services` | route:各端点 | 是 |
| 8 | `mainApi` 归属未确定 | `call-base-unresolved` | base-binding:mainApi | 是 |
| 9 | 定时任务 12 个 | `scheduled-task-present` | scheduled-task:各任务 | 是 |
| 10 | 8 个功能跨仓库 | `module-spans-roots` | module:各模块 | 是 |
| 11 | 外部依赖清单 | `external-dependency` | outbound-target:各依赖 | 是 |
| 12 | 北森地址不可得 | `target-address-unresolved` | outbound-target:北森 | 是 |
| 13 | 跨边界读取的表 | `table-read-across-boundary` | entity:各表 | 是 |
| 14 | 权限矩阵不可穷举 | `authz-not-declaratively-enumerable` | workspace | 是 |
| 15 | 覆盖率指标 | `coverage-metric` | health-signal:各指标 | 是 |
| 16 | 命中的业务规则 | `rule-present` | rule-subject:各规则 | 是 |
| 17 | 客户删除校验（**矛盾**） | `rule-present` | rule-subject:client-delete-guard | 是，qualifier 判定相反 |
| 18 | 未使用的代码（**矛盾**） | `endpoint-uncalled` | route:各端点 | 是，qualifier 数量相反 |
| 19 | 角色清单 | `role-defined` | role:各角色 | **否**，见缺口 1 |
| 20 | 请假状态流转 | `state-machine` | entity:wcp_leave | **否**，见缺口 1 |

18/20 相同。第 17、18 对算出相同 claimId 而 qualifier 相反，正是所需行为——矛盾落在同一个身份上才检得出来。

Opus 独有的 4 条：

| 结论 | 主体来源 | 主体是否稳定 |
|---|---|---|
| 源码中硬编码对称加密密钥 | symbol `wcp-service-v2\|internal/cmon/util.go\|const\|AESKey` | 稳定 |
| 24 小时规则在新旧服务边界不同 | condition 的 `enclosingFunction` | 稳定 |
| 业务逻辑写死办公室/项目/客户编号 | condition 的 `enclosingFunction` | 稳定 |
| 鉴权判断缺取反符号 | guard 的 `enclosingFunction` | 该条稳定，整体见缺口 2 |

## 已知缺口

**缺口 1：主体是"集合的成员"而知识库只存了集合。**

第 19、20 对不是 identity 规则本身的问题，是主体粒度取不到。角色枚举与请假状态流转在知识库中都以 `value-set` 记录整体存在（295 条，record_key 为 `root|path|line|name`，按声明位置而非按成员），成员没有独立记录，因此"角色数 20 还是 11""状态 7 个还是 9 个"这类分歧无法定位到成员级的主体。

出口：切片时把 `value-set` 展开为成员级主体供 claim 引用，`value-set` 记录本身作为 factId 保留。这是 PI-109 事实包的工作，不改分析层。

**缺口 2：仅存在于行号敏感 kind 且无 `enclosingFunction` 的事实，取不到稳定主体。**

实测覆盖率：

| kind | 总数 | 带 `enclosingFunction` | 覆盖 |
|---|---|---|---|
| guard | 1060 | 814 | 77% |
| condition | 1957 | 1112 | 57% |

缺失的 246 条 guard 与 845 条 condition，只能以 `root+path+line` 定位，而这正是不稳定的那部分。

出口：这类事实**不作为 claim 的主体**，只作为 factId 出现在其他 claim 的支撑里。若某条结论的主体只能落在这里，该结论按"覆盖不足"处理，由 PI-109 的生成前门禁阻断，不产出无法追踪的 claim。补齐 `enclosingFunction` 属分析层改动，不在 PI-107 范围内。

## 对后续任务的影响

- **PI-110 实现**：claim schema 中 `claimId` 由 `predicate` 与 `subject` 算出，`qualifiers` 与 `factIds` 均不参与。聚合不是 claim，是对 claim 集合的汇总视图。
- **PI-109**：事实包须把 `value-set` 展开为成员级主体；生成前门禁须把"主体不可稳定寻址"列为阻断条件。
- **PI-112**：跨文档一致性检查的对象是同一 claimId 上的 qualifier 冲突，不是数字比对。第 17、18 对是现成的矛盾样本，可直接作为测试夹具。
- **PI-115**：增量失效的计算链是 fact → claim 的支撑集合 → View。因 identity 不含 factIds，行位移只会导致支撑集合更新，不会让 claim 整体重建。

## 附：验收目标的模块名

知识库中的模块名取自结构（路由资源段），非模型生成的显示名。请假相关的模块 id 为 `mod_5e43886b5e32edd5`，名称是 **`leaves`**（跨 `wcp-service` 与 `wcp-service-v2` 两个根），不存在名为 `leave` 的模块；假期额度是独立模块 `holidayhour`。模块级验收以 `leaves` 为准。
