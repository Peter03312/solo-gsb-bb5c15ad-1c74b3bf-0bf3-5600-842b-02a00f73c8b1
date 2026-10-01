# 多抄本校勘 Web 应用（古籍整理）

面向古籍整理团队的多抄本对校工具：对同一篇文献录入 **至少两份抄本** 的逐行文字，
选定 **底本**，将行内连续字句编入 **对应组**；自动呈现异文、缺文、倒置与未归组文字，
并提供「待修复 → 修复 → 发布」的版本化工作流。

技术栈：**Node.js + TypeScript（Express）· React 18 + Vite · PostgreSQL 16**。

---

## 一、一键启动（Docker，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后打开浏览器：

> **http://localhost:4000**

- 端口可通过环境变量 `APP_PORT` 修改（默认 `4000`）；
- 首次启动自动：建库、建表（`db/schema.sql`）、安装全部依赖、构建前端；
- 数据持久化于命名卷 `collation-pgdata`。

常用命令：

```bash
docker compose logs -f app      # 查看应用日志
docker compose down             # 停止（保留数据）
docker compose down -v          # 停止并删除数据库数据
```

### 配置（可选）

复制 `.env.example` 为 `.env` 后修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `4000` | 浏览器访问端口（宿主机） |
| `PGUSER` | `collation` | 数据库用户 |
| `PGPASSWORD` | `collation` | 数据库密码 |
| `PGDATABASE` | `collation` | 数据库名 |

---

## 二、本地开发（不用 Docker）

需要本机已有 PostgreSQL 13+，并预先创建数据库：

```bash
createdb collation
# 表结构由后端启动时自动执行 db/schema.sql 建好；也可手动：
# psql -d collation -f db/schema.sql
```

启动后端（终端 1）：

```bash
cd server
npm install
npm run dev          # http://localhost:4000，热重载
```

启动前端（终端 2）：

```bash
cd web
npm install
npm run dev          # http://localhost:5173 （/api 自动代理到 4000）
```

开发模式请打开 **http://localhost:5173**；生产模式仅暴露 **4000**（Express 托管前端产物）。

后端环境变量（均有默认值）：`PGHOST=localhost PGPORT=5432 PGUSER=collation PGPASSWORD=collation PGDATABASE=collation PORT=4000`。

---

## 三、业务规则与功能

### 录文
- 每份抄本按 **原始行序逐行录入**；新增抄本不限份数。
- 在行文中鼠标拖选连续字句即可就地 **改字**（替换 / 插入 / 删除，删除即替换框留空）。
- 字符位置以 **Unicode 码点** 计，生僻字、扩展区汉字（𫬺、𰻞等）安全。

### 归组规则（保存时强校验，任一不满足即整体拒绝、**绝不部分保存**）
1. 每组 **必须且仅含一个底本片段**（底本片段不能标缺文）；
2. 其他抄本 **每组至多占一个片段**，或对该组显式 **标为缺文**；
3. 同一抄本的片段 **不得在行内重叠归组**（端点相接允许）；
4. 片段不得 **越界**（起点/终点超出该行当前字数）。

校验失败时错误信息逐条给出 **位置与原因**，例如：

> 第 2 组「乙本」越界：该行共 10 字，片段位于第 1 行第 6–99 字；合法范围为第 1–10 字
> 抄本「乙本」第 1 行存在重叠归组：第 1 组 [1, 6) 与第 2 组 [6, 11) 在第 6 字重叠…

组序（底本顺序）必须自 1 连续。

### 对照页
- 上半部 **依底本顺序** 列出每个对应组，自动标注 **异文 / 缺文 / 倒置**；
- 下半部按各抄本 **原始行序** 展示全文：已归组文字加底色，**未归组文字自然完整可见**。

### 改动原文与待修复
- 修改原文时，只有 **受影响** 的对应组变为待修复：
  与改动区间相交、或改动缩短行后导致片段越界的组；
  改动点之后的片段自动平移，不受影响的组保持完好。
- 切换底本后，不含新底本片段的组全部待修复。
- **修复前不得发布新校勘版**；待修复组需逐组重录并通过同一套校验。

### 发布与旧版
- 发布生成 **不可变快照**（JSONB，固化发布定稿时的版本号）。发布后继续修改只影响工作版，
  **旧发布版始终可阅读**（“发布与旧版”页签 → 阅读此版）。

### 版本对照（任一已发布校勘版 ↔ 当前工作版）
- 在“发布与旧版”页签对任一已发布版本点 **“与当前工作版对照”**（或在旧版阅读页点同名按钮），
  打开版本对照页；**页面与 HTTP API 返回同一结果**，均为只读：不修改工作版，也不修改快照，
  点“刷新”即按当前最新工作版重新对照。
- **行文增删改**：按“抄本 + 该抄本原始行号”列出新增行 / 删除行 / 行内改字，行内以码点级
  增删标记呈现（生僻字按 Unicode 码点处理）。
- **对应组**：呈现组序变化、各抄本片段（位置/文字）与缺文标记的变化。
  整批重存会更换全部组 ID，因此对照 **绝不凭组 ID / 组序判定增删**：
  仅在两侧底本相同、且某组底本片段的“原始行号 + 码点区间”在两侧各自唯一并一一对应时才配对；
  无法唯一配对的旧组、新组分别列入“未配对”，**不推断移动**；
  两侧底本不同则完全不配对，旧组与新组分别列出（原因显式标注）。
- **待修复组显式标识**：待修复 / 越界片段的文字 **不作为确定文字**（标注为待修复，
  越界前可见部分仅作参考），两侧均完好时才给出“文字已变”的确定结论。
- 对照页头部同时显示两侧 **底本与版本号**（旧版：第 N 版及快照版本号；新版：当前工作版版本号）。
- 旧版不存在时接口与页面均明确报错（404，提示当前已发布至第几版）。
- 接口：`GET /api/documents/:id/editions/:no/diff`，例如

  ```bash
  curl http://localhost:4000/api/documents/1/editions/1/diff
  ```

  返回：`sides`（两侧底本/版本号/组数/待修复数）、`textChanges`（行文增删改）、
  `groupDiff.paired`（配对组的组序与各抄本片段、缺文变化）、
  `groupDiff.unpairedOld / unpairedNew`（未配对旧/新组及原因）。


### 自动补配（按底本文字在目标抄本行文中预配片段）
- 在工作区“自动补配”页签选择**目标抄本**（不能是底本）后，系统按**完好对应组**的底本文字，
  在该抄本**原始行文**中预览补配候选；**待修复组不参与**。
- 参与范围：仅该抄本**尚无片段且未标缺文**的完好组。候选须为某**单行内**与底本文字
  按 **Unicode 码点完整相同**的连续字句，且区间**不占用任何现有片段**（端点相接允许）；
  返回行号与 `[startCp, endCp)` 码点区间。
- 每组显示：**无候选**、**多处候选**（需人工择一）、或唯一候选**与其他组候选区间重叠**的原因；
  仅**唯一且无冲突**的候选标记为“可直接采纳”（默认勾选，可取消），其余由人选一个或跳过。
  行文中以颜色高亮全部候选（绿=可采纳，黄=多候选，红=区间冲突），点击高亮即可选中。
- 提交时连同**预览时的文献版本号**一并送服务端，在当前工作版（行锁 + SERIALIZABLE）内
  **重新核对整批**：组仍完好且仍参与、底本文字未变、候选行归属与区间合法、文字仍逐码点相同、
  不与现有片段重叠、所选候选彼此不重叠，再跑一遍完整归组校验——**整批通过才写入**；
  **未选组与已有片段原样保留**，成功后文献版本**只推进一次**。
- `expectedVersion` 过期 → **409 版本已过期**；候选在当前工作版已失效 → **409（CANDIDATE_STALE）拒绝整批、不推进版本**。
- 接口：
  - 预览（只读，不推进版本）：`GET /api/documents/:id/supply-preview?msId=<目标抄本id>`
  - 提交：`POST /api/documents/:id/supply`，请求/响应示例：

    ```bash
    # 预览
    curl 'http://localhost:4000/api/documents/1/supply-preview?msId=2'
    # 返回（节选）：version=预览版本号；groups[].candidates[] 含 lineId/lineNo/startCp/endCp/text，
    # adoptable=true 即唯一无冲突；reason: no-candidate | multiple-candidates | candidate-conflict

    # 提交所选候选（每组至多一个；expectedVersion 取预览返回的 version）
    curl -X POST http://localhost:4000/api/documents/1/supply \
      -H 'Content-Type: application/json' \
      -d '{
        "expectedVersion": 4,
        "msId": 2,
        "selections": [
          { "groupId": 1, "lineId": 2, "startCp": 1, "endCp": 6 },
          { "groupId": 2, "lineId": 2, "startCp": 6, "endCp": 11 }
        ]
      }'
    # 201 -> {"ok":true,"adopted":2,"groupIds":[1,2]}
    # 409（版本过期）-> {"error":"版本已过期：您基于版本 4 修改，当前版本为 5 …","details":{"currentVersion":5}}
    # 409（候选失效）-> {"error":"第 2 组候选文字「…」与当前底本文字「…」不再完全相同，候选失效",
    #                    "details":{"code":"CANDIDATE_STALE","groupOrd":2}}
    ```

### 并发控制
- 所有写请求必须携带 `expectedVersion`（乐观锁）；
- 基于过期版本的修改返回 **409 拒绝**，不做任何写入，前端提示刷新后重试；
- 事务隔离级别为 `SERIALIZABLE`，序列化冲突同样返回 409。

---

## 四、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/documents` | 文献列表 |
| POST | `/api/documents` | 新建（标题 + ≥2 份抄本名） |
| GET | `/api/documents/:id` | 校勘读模型（组/异文/缺文/倒置/原始行/覆盖区间/版本号） |
| POST | `/api/documents/:id/manuscripts` | 增加抄本 |
| PUT | `/api/documents/:id/base` | 选定底本 |
| POST | `/api/manuscripts/:msId/lines` | 追加一行 |
| PUT | `/api/lines/:lineId` | 行内改字（`startCp/endCp/replacement`） |
| PUT | `/api/documents/:id/groups` | 整批保存对应组（替换式，全量校验） |
| PUT | `/api/documents/:id/groups/:gid/repair` | 修复单个对应组 |
| DELETE | `/api/documents/:id/groups/:gid` | 删除对应组 |
| POST | `/api/documents/:id/publish` | 发布新版（有待修复组则 409） |
| GET | `/api/documents/:id/editions` / `…/editions/:no` | 版本列表 / 阅读旧版快照 |
| GET | `/api/documents/:id/editions/:no/diff` | **该已发布版与当前工作版的版本对照**（旧版不存在 → 404） |
| GET | `/api/documents/:id/supply-preview?msId=` | **补配候选预览**（只读；完好组底本文字在目标抄本行文中的空闲单行相同文字） |
| POST | `/api/documents/:id/supply` | **整批提交补配选择**（带预览版本号重新核对；过期 409、候选失效 409 拒绝整批） |

写请求体均含 `expectedVersion`；错误响应：`{ "error": "...", "details": [ { "code", "message", "groupOrd", "msName", "lineNo", ... } ] }`。

---

## 五、测试

后端使用内嵌 PostgreSQL（PGlite，WASM）做端到端集成测试，无需外部数据库：

```bash
cd server
npm test
```

覆盖：合法归组、异文/缺文判定、倒置、越界/重叠/缺底本/重复抄本报错定位、
整体拒绝不部分保存、乐观锁 409、改字仅波及相关组、平移、缩短越界、
修复流程、发布门禁、旧版快照可读、切换底本，以及
**版本对照：行文增删改（按原始行号）、整批重存换组 ID 仍按底本位置唯一配对、
无法配对组分别列出且不推断移动、底本不同不配对、缺文标记变化、待修复组显式标识且越界文字不作确定文字、
旧版不存在 404、对照只读且刷新反映最新工作版，以及
**自动补配：唯一空闲候选可采纳、多处/无候选/被现有片段占用/组间候选重叠的原因、
码点级区间（扩展区生僻字）、整批提交只推进一次版本、未选组与已有片段保留、
版本过期 409、候选失效（文字变化/越界/组已待修复）409 拒绝整批且不推进版本、待修复组不参与**。

---

## 六、目录结构

```
.
├── Dockerfile                # 多阶段构建：前端 → 后端 → 静态托管
├── docker-compose.yml        # 一键：db(PostgreSQL 16) + app
├── db/schema.sql             # 数据库结构（幂等，可重复执行）
├── server/                   # Node.js + TypeScript + Express
│   └── src/ (db/validate/collation/diff/routes/repo/...)
└── web/                      # React 18 + Vite + TypeScript
    └── src/ (录文 / 归组 / 对照 / 发布与旧版 / 版本对照)
```
