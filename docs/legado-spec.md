# Legado 3.x 书源规则规范（实现基准）

> 取证来源：`HapeLee/legado-with-MD3`（main，6440★）Kotlin 源码，已解压到
> `D:\AI\工作区\legado-ref\legado-with-MD3-main\app\src\main\java\io\legado\app\`（2101 个 .kt，14.31MB）。
> 上游 `gedoor/legado` 源码已清空（仅剩 README + 公告图），**必须以 fork 为准**。
> 文档与源码冲突时一律以源码为准（已发现 6 处，见 §9）。

---

## 1. 规则字符串总纲

### 1.1 规则类型标志

| 标志 | 可省略条件 | 适用字段 |
|---|---|---|
| `@@` 默认规则 | 直接写时可省 | 所有字段 |
| `@XPath:` | 以 `//` 开头时可省 | 所有字段 |
| `@Json:` | 以 `$.` 开头时可省 | 所有字段 |
| `:` 正则（AllInOne） | **不可省** | **仅书籍列表(搜索/发现) + 目录列表** |
| `@css:` / `@CSS:` | 不可省 | 所有字段 |
| `@js:` / `<js></js>` | 不可省 | 所有字段 |
| `@webjs:` | 不可省 | 所有字段 |

`{{...}}` 内必须写明确规则标志；没标志当 JS 执行。

### 1.2 分段执行模型 —— 唯一入口 `splitSourceRule(ruleStr, allInOne)`
`AnalyzeRule.kt:539-573`

1. 若 `allInOne && ruleStr.startsWith(":")` → `Mode.Regex; isRegex=true; start=1`（**切掉首字符 `:`**）。
   源码注释原话：「仅首字符为 : 时为 AllInOne，其实 : 与伪类选择器冲突，建议改成 ? 更合理」
2. `else if (isRegex)` → 后续片段**仍为 Regex**（isRegex 粘滞，未复位）
3. 按 `JS_PATTERN = Regex("<js>([\\w\\W]*?)</js>|@js:([\\w\\W]*)", IGNORE_CASE)` 切出 JS 段 → `Mode.Js`
4. 再按 `WebJS_PATTERN = Regex("@webjs:([\\w\\W]{5,})", IGNORE_CASE)` 切出 `Mode.WebJs`
5. 其余片段各建 `SourceRule(片段, mMode)`；结果做 `getOrPutLimit(rule, 16)` 缓存

⚠️ **`getElement(ruleStr)` 与 `getElements(ruleStr)` 传 `allInOne=true`；`getString(ruleStr, unescape)` 传 false。**
`AnalyzeRule.kt:291-295,372-405,411-442`

### 1.3 `SourceRule` 模式判定优先级 `AnalyzeRule.kt:598-673`

① 传入 mode 为 `Js`/`Regex` → 保持不变
② `startsWith("@CSS:", true)` → `Default`，**规则保留原文**（`@css:` 由 `AnalyzeByJSoup.SourceRule` 二次剥离）
③ `startsWith("@@")` → `Default`，`substring(2)`
④ `startsWith("@XPath:", true)` → `XPath`，`substring(7)`
⑤ `startsWith("@Json:", true)` → `Json`，`substring(6)`
⑥ `isJSON || startsWith("$.", "$[")` → `Json`
⑦ `startsWith("/")` → `XPath`（注释：「XPath特征很明显,无需配置单独的识别标头」）
⑧ else → `Default`

`isJSON` 由 `setContent()` 判定：`if (content is Node) false else content.toString().isJson()`；
`isJson()` = trim 后首尾为 `{}` 或 `[]`（**只看首尾字符，不解析**）。`utils/StringExtensions.kt:47-55`

### 1.4 `##` 正则与 `{{}}`/`@get` 的冲突规则 `AnalyzeRule.kt:598-673`

`evalPattern = Regex("@get:\\{[^}]+?\\}|\\{\\{[\\w\\W]*?\\}\\}", IGNORE_CASE)`，取首个匹配后：
```
mode != Js && mode != Regex && (firstMatch.range.first == 0 || !tmp.contains("##"))
  → mode = Mode.Regex
```
即 **`##` 与 `{{}}`/`@get` 同现时不整体转 Regex**，而是走 `makeUpRule` 逐段拼装。

### 1.5 三种正则用法

| 用法 | 写法 | 适用范围 |
|---|---|---|
| AllInOne | `:<正则>`，**必须以 `:` 开头** | 仅搜索列表/发现列表/详情页预加载/目录列表 |
| OnlyOne | `##正则##替换###`（**结尾三井号**） | 上述之外；只取首个匹配并替换 |
| 净化（循环替换） | `##正则##替换`，接在其它规则后 | 对结果循环替换；独立使用时等价 `all##正则##替换` |

例：`-:<li><a[^\"]+\"([^\"]*)\">([^<]*)`（目录 AllInOne + 反序）；
`##:book_name"[^"]+"([^"]+)"##$1###`（OnlyOne）；
`@css:.content@html##<script>.*?</script>##`（净化）。

**源码级实现** `AnalyzeRule.kt:708-767`：`makeUpRule` 末尾 `rule.split("##")` →
`[0].trim()` = 规则、`[1]` = replaceRegex、`[2]` = replacement、**`size > 3` → `replaceFirst = true`**。

`replaceRegex(result, rule)` `AnalyzeRule.kt:491-514`：
- `replaceFirst` 分支 → `regex.find(result)`，命中返回 `match.value.replaceFirst(regex, replacement)`，**未命中返回 `""`**
- 普通分支 → `result.replace(regex, replacement)`，正则编译失败则退化为**字面量** `result.replace(replaceRegex, replacement)`

### 1.6 连接符号 `&&` / `||` / `%%`  ← 最容易搞错

**不是顺序管道，而是并列分支列表**：`RuleAnalyzer.splitRule("&&","||","%%")` 一次切分，
片段各自独立求值，`elementsType` 记录命中的分隔符。

- `||` = **首个非空即 break**
- `&&` = 全部合并（`addAll`）
- `%%` = **交替取值（zip-by-index）**：
```kotlin
for (i in results[0].indices) for (temp in results) if (i < temp.size) textS.add(temp[i])
```

⚠️ 限制：连接符号**只能在同种规则间使用，不包括 js 和正则**。
`getString` 只认 `&&`/`||`；`getStringList`/`getElements`/`getList` 认三个。

### 1.7 `@put` / `@get` 变量

- `@put:{bid:"//*[@bid-data]/@bid-data"}` 与 `@get:bid` **只能在 JS 以外的规则中使用**
- `java.put`/`java.get` **只能在 JS 中使用**（JS 内不能用 `@get`）
- 源码：`putPattern = Regex("@put:(\\{[^}]+?\\})", IGNORE_CASE)`，匹配内容存入 `putMap` 并从规则串**删除**；
  JSON 解析优先 `GSONStrict`，失败退回 `GSON` 并 Debug 提示「≡@put 规则 JSON 格式不规范，请改为规范格式」
- `put(key,value)` 落库顺序：`chapter?.putVariable ?: book?.putVariable ?: ruleData?.putVariable ?: source?.put(key,value)`；
  `get(key)` 同样顺序，且特判 `"bookName"→book.name`、`"title"→chapter.title`，未命中返回 `""`。`AnalyzeRule.kt:447-451,788-813`

### 1.8 `{{}}` 模板变量

- **搜索 URL / 发现 URL** 中：`{{}}` 内**只能用 JS**。例 `/search?key={{key}}&page={{page}}`、
  `/search?key={{java.base64Encode(key)}}&page={{(page-1)*20}}`
- **其它规则**中：`{{}}` 内可用任意规则，默认 JS，需标志头 —— JS 无需标志 / `@@` 默认 /
  `@xpath:` 或 `//` / `@json:` 或 `$.` / `@css:`
- `{}` 旧语法（阅读 2.0）只支持 JSONPath，建议避免
- 源码 `makeUpRule`：`{{...}}` → `ruleType = -1`；`isRule(param)` 则以 `@`/`$.`/`$[`/`//` 开头 ⇒ 递归 `getString`，
  否则 `evalJS`，且 **Double 且整除 → `String.format(Locale.ROOT,"%.0f",v)`**（去掉 `.0`）
- `isRule()` 定义 `AnalyzeRule.kt:769-774`

### 1.9 列表前缀 `-` / `+`  ← 纯规则描述里的 `-` 只有这一个含义

- `bookList` / `chapterList` **首字符 `-`** → `reverse = true`，规则本体 `substring(1)`
- **`+`** → AllInOne（`substring(1)`，配合 `:` 首字符判定）
- ⚠️ **澄清**：`-` 前缀**只对列表规则有定义**，语义是「列表反序」。
  **不存在**「`-@js:` 前缀」这种语法；`@js:` 规则本身无 `-` 语义。
- **反序双层（必须同时复刻）** `BookChapterList.kt:126-137`：
  ① 源声明 `reverse` 处理；② `LinkedHashSet` 去重；③ **`if (!book.getReverseToc()) list.reverse()`**（用户设置）；
  ④ `list.forEachIndexed { index, c -> c.index = index }`

### 1.10 默认规则（JSoup）完整文法

每段 3 部分 `.` 连接：`类型.名称.位置`。类型 = `class`/`id`/`tag`/`text`/`children`；位置从 0 开始、负数倒数。
示例：`class.odd.0@tag.a.0@text`、`tag.div.-1@text`。

取值表：`text` / `textNodes` / `ownText` / `href` / `src` / `html` / `all`。**其它一律当属性名**。
排除符号 `!`：`tag.div!0:2@text`。
数组写法 `[index]`：`[0]`/`[-1]`/`[0:3]`/`[2:5]`/`[0:10:2]`/`[!0:2]`/`[-1:0]`(反转)。

**源码级文法（实现必须照抄）** `AnalyzeByJSoup.kt`：

- `SourceRule(ruleStr)`：`isCss = startsWith("@CSS:", true)` → `elementsRule = substring(5).trim()`
- `getElements(temp, rule)`：`splitRule("&&","||","%%")`；`isCss` → `temp.select(ruleStr)`；
  否则 `RuleAnalyzer(ruleStr).trim()` + `splitRule("@")`，`rs.size>1` 时**递归链式** `getElements(et, rl)`，
  否则 `ElementsSingle().getElementsSingle(temp, ruleStr)`
- `getResultList(ruleStr)`：`trim()` → `splitRule("@")`，`for (i in 0 until last)` 逐层 `ElementsSingle` 求并集，
  末端 `getResultLast(elements, rules[last])`
- `ElementsSingle(beforeRule, indexDefault, indexes)`：
  - `beforeRule` 空 → `children`；否则按 `beforeRule.split(".")` 的首段分派：
    `children`→`children()` / `class`→`getElementsByClass(r[1])` / `tag`→`getElementsByTag(r[1])` /
    `id`→`Collector.collect(Evaluator.Id(r[1]), temp)` / `text`→`getElementsContainingOwnText(r[1])` /
    **else → `temp.select(beforeRule)`**
  - 索引提取：`lastIndexes = (indexDefault.size-1).takeIf{it != -1} ?: (indexes.size-1)`（两种写法互斥）
  - 无 `[]`：逆向遍历 `indexDefault`；`it in 0 until len` 收；`it < 0 && len >= -it` → `it + len`
  - 有 `[]`（区间 `Triple(start?,end?,step?)`）：`start = startX ?: 0`、`end = endX ?: (len-1)`，负值 `+= len`；
    两端同时越界则跳过；`start>=len→len-1`、`start<0→0`、`end>=len→len-1`、`end<0→0`；
    `start==end || stepX>=len` → 只取 start；
    `step = if (stepX>0) stepX else if (-stepX<len) stepX+len else 1`；
    `end>start → start..end step step` 否则 `start downTo end step step`
  - 应用：`split=='!'` → `elements[pcInt]=null` 后 `removeAll(nullSet)`（排除，保留其它）；
    `split=='.'` → 按 indexSet 取
- `getResultLast(elements, lastRule)`：
  - `text`→`element.text()`（非空才收）
  - `textNodes`→各文本节点 `trim { it <= ' ' }` 后 `joinToString("\n")`
  - `ownText`→`ownText()`
  - `html`→**先 `select("script").remove()` + `select("style").remove()`** 再 `outerHtml()`
  - `all`→不删的 `outerHtml()`
  - **else→`element.attr(lastRule)`，`url.isBlank() || textS.contains(url)` 则 skip（同值去重）**
- `getString(ruleStr)`：空→null；list 空→null；size==1→`first()`；否则 `joinToString("\n")`。
  `getString0` = 空则 `""` 否则 `[0]`。**所有 URL 取值只取首个元素。**
- `getStringList`：`elementsRule.isEmpty()` → `textS.add(element.data() ?: "")`（**返回整篇 HTML 源码**）
- `parse(doc)`：`Element` 原样；`JXNode` 元素 → `asElement()`；
  `toString().startsWith("<?xml", true)` → `Jsoup.parse(..., Parser.xmlParser())`；否则 `Jsoup.parse(...)`

### 1.11 索引文法 `findIndexSet` `AnalyzeByJSoup.kt:388-511`

支持 `tag.div.-1`、`tag.div[-1, 3:-2:-10, 2]`、`tag.div[-1:0]`（反向）、`start:end` 或 `start:end:step`（step 为负 = 倒序）；
负索引 `+= len`；越界丢弃或夹取；`!` = 排除、`.` = 选取。收尾固定 `split=' '; beforeRule=rus`。

### 1.12 返回值类型随上下文变化

| 入口 | 返回 |
|---|---|
| `AnalyzeRule.getString(...)` | `String?`（多结果 `\n` 连接） |
| `getStringList(...)` | `List<String>`（String 结果 `split("\n")`；isUrl 时逐个绝对化去重） |
| `getElement(ruleStr)` | `Any?`（Default→Elements；Json→getObject；XPath→List） |
| `getElements(ruleStr)` | `List<Any>`（Default→Elements，空则 `ArrayList()`） |
| `@js:` 中 `result` | 视位置：搜索/发现列表=单个元素；详情/目录=元素；正文=元素或 String |

`{$.xxx}` 内嵌：`innerRule("{$.") { getString(it) }`（JSONPath 专用，`RuleAnalyzer(rule, code=true)` 用
`chompCodeBalanced` 处理 `[`/`]` 嵌套，避免 `&&`/`||` 与含 `}` 的 JSON 文本误匹配）。`AnalyzeByJSonPath.kt`

---

## 2. JS 引擎与执行环境

### 2.1 引擎

- **Rhino 1.8.1**（`gradle/libs.versions.toml:70`），解释执行模式
- `modules/rhino/…/RhinoScriptEngine.kt:318-330`：`languageVersion = Context.VERSION_ES6`、`isInterpretedMode = true`、
  `instructionObserverThreshold = 10000`、`maximumInterpreterStackDepth = 1000`、`FEATURE_ENABLE_JAVA_MAP_ACCESS` 开启
- **ES 支持（VERSION_ES6）**：
  ✓ 箭头函数 ✓ `let`/`const` ✓ 模板字符串 ✓ 解构 ✓ 展开 ✓ 默认参数 ✓ `class` ✓ `for...of`
  ✓ 生成器 ✓ `Map`/`Set`/`Symbol`/`Proxy`
  ✗ **`Promise`/`async`/`await` —— Rhino 不支持，书源里基本不会出现**
  ✓ `JSON.parse`/`JSON.stringify` ✓ `String.prototype.includes`/`startsWith`/`endsWith`/`padStart`/`repeat`/`trimStart`
  ✓ `Array.from`/`includes`/`find`/`flat` ✓ `Object.assign`/`Object.entries` ✓ `Array.prototype.forEach/map/filter/reduce`
  ⚠️ **`const` 不支持块级作用域**（循环中值不变），文档明确要求「改用 `var`」
- ⚠️ **标准 JS 全局对象不完整**：`getRuntimeScope(bindings)` 用的是**裸 `cx.initStandardObjects()`，未包 ImporterTopLevel**
  `RhinoScriptEngine.kt:261-267` ⇒ **没有 `Packages` 全局**、没有 `importPackage`/`importClass`。
  需要 Java 类时**必须写全限定名**，如 `new Packages.java.io.ByteArrayInputStream(data)`
- ⚠️ **`java` 变量已被 Legado 覆盖为 `AnalyzeRule` 实例**（即 `JsExtensions`），**调用 `java.*` 包必须写 `Packages.java.*`**

### 2.2 沙箱与脚本隔离

- `RhinoClassShutter` 黑名单含 `java.lang.Class`、`ClassLoader`、`URLClassLoader`、`Runtime`、`ProcessBuilder`、
  `ProcessImpl`、`UNIXProcess`、`java.io.File`、`FileDescriptor`、`FileInputStream`、`FileOutputStream` 等
- `doTopCall` 未授权时 `error("Not allow run script in unauthorized way.")`；`observeInstructionCount` → `cx.ensureActive()`
- 作用域复用 `AnalyzeRule.kt:818-849`：`topScope = source?.getShareScope(coroutineContext) ?: topScopeRef?.get()`；
  无 topScope 时 `RhinoScriptEngine.getRuntimeScope(bindings)`，且**调用 >16 次后把 `scope.prototype` 存入 `topScopeRef` 复用**；
  有 topScope 则 `bindings.prototype = topScope`
- **jsLib（跨规则共享作用域）** `model/SharedJsScope.kt`：key = `md5(jsLib)`，`LruCache<String, WeakReference<Scriptable>>(16)`；
  两种 jsLib 格式：① JavaScript 代码片段；② JSON Map `{"example":"https://example.com/lib.js"}`
  （只对 `isAbsUrl()` 的 value 下载，ACache 缓存，失败抛 `NoStackTraceException("下载jsLib-${value}失败")`）
- ⚠️ **执行完 `scope.preventExtensions()`** ⇒ 这就是「**函数内不可声明全局变量；函数外的全局变量不可再赋值，
  否则抛 `无法修改密封对象的属性`**」的实现。书源里的 jsLib 必须写成「`var` 声明 + 立即执行的函数」风格

### 2.3 绑定变量全表

**规则执行阶段（`AnalyzeRule.evalJS`）** `AnalyzeRule.kt:818-849`：

| 变量 | 类型 | 说明 |
|---|---|---|
| `java` | AnalyzeRule (JsExtensions) | 全部 `java.*` 方法 |
| `baseUrl` | String | 当前规则上下文的基准 URL |
| `result` | Any | 上一条规则的结果（**随位置变化**，见下表） |
| `book` | Book | 当前书籍对象（搜索/发现时为 `RuleData`，可能是空 Book） |
| `rssArticle` | RssArticle | RSS 文章（书源场景为 null） |
| `chapter` | BookChapter | 当前章节 |
| `source` | BaseSource(BookSource) | 书源对象 |
| `cookie` | CookieStore | Cookie 操作 |
| `cache` | CacheManager | 缓存 |
| `title` | String | `chapter?.title` |
| `src` | String | `content`（当前内容，**正文阶段可写它保存正文**） |
| `nextChapterUrl` | String | 下一章 URL |
| `fromBookInfo` | Boolean | 是否在详情页上下文 |

**`result` 在不同规则位置的含义**：

| 位置 | result |
|---|---|
| 搜索列表 / 发现列表的 name/author/… | **单个列表项元素**（Element / JSON Node / Map） |
| `ruleSearch.bookUrl` 等 URL 字段 | 同上元素；`getString(..., isUrl=true)` |
| 详情页各字段 | 详情页元素 |
| 目录 `chapterName`/`chapterUrl` | **单个目录项元素** |
| 正文 `content` | 正文元素或 String |
| 图片解密规则 | **`ByteArray`**，另有 `src` = 图片链接 |
| `@js:` 接在别的规则后（`@css:.book@text@js:…`） | 前面规则的结果字符串 |

**URL 阶段（`AnalyzeUrl.evalJS`）** `AnalyzeUrl.kt:361-387`：
`java`（=AnalyzeUrl，只含 AnalyzeUrl 那组方法）/ `baseUrl` / `cookie` / `cache` / `page` / `key` /
`speakText` / `speakSpeed` / `book` / `source` / `result` / `infoMap`。
⚠️ **没有 `chapter`/`title`/`src`** —— URL 阶段的 JS 不能用它们。

**详情页预加载 / 目录 `preUpdateJs` 阶段**：同上规则执行阶段，额外可用 **`java.reGetBook()`** 与
**`java.refreshTocUrl()`**；⚠️ 这两个方法**仅 `preUpdateJs=true` 时可用**，否则抛
`NoStackTraceException("只能在 preUpdateJs 中调用")` `AnalyzeRule.kt:898-937`。

**目录 `formatJs` 额外绑定** `BookChapterList.kt`：
`gInt = 0`、`index`（**从 1 开始**，= `index + 1`）、`chapter`（BookChapter）、`title`（= `chapter.title`）。
返回值非空则覆盖 `chapter.title`。

---

## 3. `java.*` API 完整表

### 3.1 网络

| 签名 | 返回 | 说明 |
|---|---|---|
| `java.ajax(urlStr)` | String | 单请求取 body；失败返回**异常栈字符串**（不抛异常） |
| `java.ajaxAll(urlList)` | `Array<StrResponse>` | 并发（线程数 = 设置项 threadCount） |
| `java.ajaxTestAll(urlList, timeout)` / `(…, timeout, skipRateLimit)` | `Array<StrResponse>` | 测试模式（错误码 -1~-7） |
| `java.connect(urlStr)` / `(urlStr, header)` / `(urlStr, header, callTimeout)` | StrResponse | header 为 **JSON 字符串** |
| `java.get(urlStr, headers)` / `(…, timeout)` | `Connection.Response` | **jsoup**，`followRedirects(false)` |
| `java.head(urlStr, headers)` / `(…, timeout)` | `Connection.Response` | 同上，HEAD |
| `java.post(urlStr, body, headers)` / `(…, timeout)` | `Connection.Response` | 同上，POST |
| `java.webView(html, url, js)` / `(…, cacheFirst)` | String | **必须在后台线程**，否则 `error("webView must be called on a background thread")` |
| `java.webViewGetSource(html, url, js, sourceRegex)` / (…cacheFirst) / (…cacheFirst, delayTime) | String | 嗅探页面源码 |
| `java.webViewGetOverrideUrl(html, url, js, overrideUrlRegex)` / (+cacheFirst/delayTime) | String | 拦截跳转 URL |
| `java.startBrowser(url, title)` / `(url, title, html)` | void | 打开浏览器 |
| `java.startBrowserAwait(url, title)` / (…refetchAfterSuccess) / (…refetchAfterSuccess, html) | StrResponse | 等待用户完成 |
| `java.getVerificationCode(imageUrl)` | String | 需手动打码 |
| `java.cacheFile(url)` / `(url, saveTime)` | String | 下载并缓存到本地，返回**相对路径**；key = `md5Encode16(url)` |
| `java.importScript(url \| 相对路径 \| 绝对路径)` | String | http 开头走 `cacheFile`，否则 `readTxtFile`；空则抛 `NoStackTraceException("$path 内容获取失败或者为空")` |

**`StrResponse` 方法**：`raw()`、`url()`（优先 `raw.networkResponse?.request?.url`，即**重定向后最终 URL**）、`body()`、
`code()`、`message()`、`headers()`、`isSuccessful()`、`errorBody()`、`callTime()`、`toString()`。`help/http/StrResponse.kt`

### 3.2 `urlOption` JSON 字段（**14 个**）

`AnalyzeUrl.kt:811-988`，语法 `URL,{JSON}`（逗号前后允许空白，`paramPattern = Regex("\\s*,\\s*(?=\\{)")`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `method` | String | GET | `uppercase()` 后映射：`"POST"`→POST / `"HEAD"`→HEAD / else GET |
| `charset` | String | null | 见 §4.1（**语义特殊**） |
| `headers` | Object | — | 逐项覆盖 headerMap |
| `body` | String | — | POST body（⚠️ 必须是 JS String 类型，用 `String()` 强转） |
| `origin` | String | — | ⚠️ 文档未记载 |
| `retry` | Int | 0 | 重试次数 |
| `type` | String | — | 文件类型（文件类源），决定下载后缀 |
| `webView` | Boolean | — | `useWebView()`：`null`/`""`/`false`/`"false"` → false，**其它任何值 → true** |
| `webJs` | String | — | ⚠️ 文档未记载 |
| `dnsIp` | String | — | ⚠️ 文档未记载，指定 DNS 解析 IP |
| `js` | String | — | 解析 URL 时执行，**结果赋给 url**；可用 `java.url`/`java.headerMap.put(...)` |
| `bodyJs` | String | — | ⚠️ 文档未记载，对响应 body 二次处理 |
| `serverID` | String | — | ⚠️ 文档未记载 |
| `webViewDelayTime` | Long | 0 | 负值取 0 |

⚠️ **没有独立 `proxy` 字段** —— 代理通过 `header` 里的 `proxy` 键配置
（`socks5://host:port`、`socks4://`、`http://host:port`、带认证 `http://host:port@user@pass`）。

### 3.3 编码 / 加解密

| 签名 | 说明 |
|---|---|
| `java.encodeURI(str)` / `(str, enc)` | **`java.net.URLEncoder.encode`** ⚠️ **空格 → `+`**，与 JS `encodeURIComponent` 的 `%20` **不同** |
| `java.base64Encode(str)` / `(str, flags)` | flags 支持 `java.util.Base64.NO_WRAP` 等 |
| `java.base64Decode(str)` / `(str, charset)` / `(str, flags)` | — |
| `java.base64DecodeToByteArray(str)` / `(str, flags)` | ByteArray |
| `java.strToBytes(str)` / `(str, charset)` | ByteArray |
| `java.bytesToStr(bytes)` / `(bytes, charset)` | String |
| `java.hexDecodeToByteArray(hex)` | ByteArray? |
| `java.hexDecodeToString(hex)` | String?（UTF-8） |
| `java.hexEncodeToString(utf8)` | String? |
| `java.md5Encode(str)` / `java.md5Encode16(str)` | 32 位 / 16 位 MD5（走 **Hutool**，宽松解码兼容） |
| `java.createSymmetricCrypto(transformation, key, iv)` | cipher；key 为 null → 随机密钥；iv 非空 → `setIv`。方法 `decrypt`/`decryptStr`/`encrypt`/`encryptBase64`/`encryptHex` |
| `java.createSymmetricCrypto(transformation, key)` | 同上，iv = null |
| `java.createAsymmetricCrypto(transformation).setPublicKey(k).setPrivateKey(k)` | `decrypt(data, usePublicKey=true)` 等 |
| `java.createSign(algorithm).setPublicKey/.setPrivateKey` | `sign.sign(data)` / `sign.signHex(data)` |
| `java.digestHex(data, algorithm)` / `java.digestBase64Str(data, algorithm)` | 摘要 |
| `java.HMacHex(data, algorithm, key)` / `java.HMacBase64(data, algorithm, key)` | HMAC |

示例：`java.createSymmetricCrypto("AES/CBC/PKCS5Padding", key, iv).decrypt(result)`

### 3.4 时间 / 文本 / 标识

`java.timeFormat(time)` = `yyyy/MM/dd HH:mm`；`java.timeFormatUTC(time, format, sh)`；
`java.htmlFormat(str)` = `HtmlFormatter.formatKeepImg`；`java.t2s(text)` / `java.s2t(text)`（简繁）；
`java.randomUUID()`；`java.androidId()`；`java.toNumChapter(s)`（中文数字章号→数字）；
`java.toURL(url)` / `(url, baseUrl)` → `JsURL`；`java.getWebViewUA()`；
`java.log(msg)`（返回 `Any?`，可插在链中）；`java.logType(var)`；`java.toast(msg)` / `java.longToast(msg)`；
`java.openUrl(url)` / `(url, mimeType)`。

### 3.5 文件（相对路径，只能操作 `android/data/{package}/cache/` 内）

`java.downloadFile(url)`→String、`java.unArchiveFile(zipPath)`、`unzipFile`、`unrarFile`、`un7zFile`、
`getTxtInFolder(unzipPath)`、`java.readFile(path)`→ByteArray?、`java.readTxtFile(path)` / `(path, charsetName)`、
`java.deleteFile(path)`→Boolean、`java.getFile(path)`。
TTF 字体：`java.queryBase64TTF(data)`、`java.queryTTF(data)` / `(data, useCache)`、
`java.replaceFont(result, f1, f2, true)`（第 4 参 = 过滤掉 f1 中不存在的字形）。

### 3.6 仅特定场景可用

- **仅订阅源 `shouldOverrideUrlLoading` 规则**：`java.searchBook(bookName)`、`java.addBook(bookUrl)`
- **仅「登录检查 JS」**：`AnalyzeUrl` 那组 —— `java.initUrl()`、`java.getHeaderMap().putAll(source.getHeaderMap(true))`、
  `java.getStrResponse(jsStr, sourceRegex)`、`java.getResponse()`

### 3.7 `cookie.*` / `cache.*` / `source.*` / `book.*`

- **cookie** `help/http/CookieStore.kt`：`cookie.getCookie(url)`、`cookie.getKey(url, key)`、`cookie.setCookie(url, cookie)`、
  `cookie.replaceCookie(url, cookie)`、`cookie.removeCookie(url)`
- **cache** `help/CacheManager.kt`（saveTime 单位**秒**；DB+文件 50MB 上限）：`cache.put(key,value,saveTime?)`、
  `cache.get(key)`、`cache.delete(key)`、`cache.putFile(key,value,saveTime?)`、`cache.getFile(key)`、
  `cache.putMemory(key,value)`、`cache.getFromMemory(key)`、`cache.deleteMemory(key)`
- **source（BookSource）**：`getKey()`（= bookSourceUrl）、`setVariable(v)`、`getVariable()`、`getLoginHeader()`、
  `getLoginHeaderMap().get(k)`、`putLoginHeader(header)`、`removeLoginHeader()`、`getLoginInfo()`、
  `getLoginInfoMap().get(k)`、`removeLoginInfo()`、`login()`、`getHeaderMap(hasLoginHeader)`、`put(k,v)`、`get(k)`
  ⚠️ **只读包装**：`SearchRule`/`ExploreRule`/`BookInfoRule`/`ContentRule`/`BookChapter`/`Book.ReadConfig`
  注册为 `ReadOnlyJavaObject`（**写操作抛异常**）；⚠️ **`TocRule` 未注册** ⇒ JS 里 `source.ruleToc` 拿不到包装
- **book 属性（26 项）**：`bookUrl`、`tocUrl`、`origin`、`originName`、`name`、`author`、`kind`、`customTag`、
  `coverUrl`、`customCoverUrl`、`intro`、`customIntro`、`charset`、`type`(0 text/1 audio)、`group`、
  `latestChapterTitle`、`latestChapterTime`、`lastCheckTime`、`lastCheckCount`、`totalChapterNum`、
  `durChapterTitle`、`durChapterIndex`、`durChapterPos`、`durChapterTime`、`canUpdate`、`order`、`originOrder`、`variable`
- **chapter 属性**：`url`、`title`、`baseUrl`、`bookUrl`、`index`、`resourceUrl`、`tag`、`start`、`end`、`variable`
- **`Packages.*`**：默认 scope **无 `Packages` 全局**，需写全限定名 `Packages.java.…`
  ⚠️ Hutool 在 classpath 上，书源可直接 `Packages.cn.hutool.*`

---

## 4. 实战要点

### 4.1 中文 GBK/GB2312 编码完整链路

`help/http/OkHttpUtils.kt:79-95` `fun ResponseBody.text(encode: String? = null): String`：
1. 先 `Utf8BomUtils.removeUTF8BOM(bytes())`
2. 若显式 `encode`（来自 `UrlOption.charset`）→ `Charset.forName(encode)`
3. 否则 `contentType()?.charset()`（HTTP 响应头）
4. 否则 **`EncodingDetect.getHtmlEncode(responseBytes)`（内容探测）**

**`charset` 只在一个地方声明：`UrlOption.charset`**，即 `URL,{"charset":"gbk"}`。`AnalyzeUrl.kt:252,306`
可用值 `AppConst.charsets = ["UTF-8","GB2312","GB18030","GBK","Unicode","UTF-16","UTF-16LE","UTF-16BE","ASCII"]`。

⚠️ **`charset` 在 `encodeParams` 里还有第二重语义（最容易踩的坑）** `AnalyzeUrl.kt:301-343`：
```
checkEncoded = charset.isNullOrEmpty()     // charset 未指定 ⇒ 假定输入已编码，不重复编码
charset 映射：null/空 → UTF_8 ｜ "escape" → null(走 EncoderUtils.escape) ｜ 其它 → charset(name)
```
⇒ **未指定 `charset` 时，URL 里的 `{{key}}` 结果原样拼接不做百分号编码**；想编码必须显式写 `"charset":"utf-8"`。

### 4.2 搜索/发现 URL 占位符

- `{{key}}` = 搜索关键字（**搜索 URL**）；`{{page}}` = 页码（**从 1 开始**；搜索/发现 URL）
- `{{page - 1 == 0 ? "" : page}}` 第一页无页码；简写 **`<,{{page}}>`** —— 源码 `pagePattern = Regex("<(.*?)>")`，
  `pages = groupValues[1].split(",")`，`page < pages.size` → `pages[page-1].trim()`，否则 `pages.last().trim()` `AnalyzeUrl.kt:188-214`
- ⚠️ **替换顺序（源码注释）**：**先替换内嵌规则再替换页数规则，避免内嵌规则中存在大于小于号时规则被切错**。即 `{{}}` → 然后 `<…>`
- 发现页 `exploreUrl` 两种格式：字符串 或 JSON 数组（元素 `title` 必填 + `url` 必填，支持 `{{page}}`；`style` 为 Flexbox 属性）。
  **探索页格式 `标题::URL`，多页用 `&&` 或换行分隔**

### 4.3 `bookSourceUrl` 与相对 URL 的拼接规则

`utils/NetworkUtils.kt:180-204` `getAbsoluteURL(baseURL, relativePath)`：
1. `relativePath.trim()`
2. baseURL 为空 / null → 直接返回 relativePath
3. `isAbsUrl()`（`http://`/`https://` 开头，**大小写不敏感**）→ 原样
4. `isDataUrl()`（`^data:.*?;base64,(.*)` 全匹配）→ 原样
5. **`startsWith("javascript")` → 返回 `""`**
6. 否则 `URL(baseURL, relativePath).toString()`（标准 RFC 3986 相对解析），异常时返回原 relativePath 并记日志

`getBaseUrl(url)`：`http://`/`https://` 开头时 `indexOf("/", 9)`，-1 → 整个 url，否则 `substring(0, index)`。
`getSubDomain(url)` → 公共后缀表取 eTLD+1（Node 需 `tldts` 或等效实现）。
`BookChapter.getAbsoluteURL()` `data/entities/BookChapter.kt:147-153`：`url.startsWith(title) && isVolume → baseUrl`；
否则 `paramPattern` 切出 `,{…}` 参数后再拼回。

### 4.4 正文分页 / 翻页处理约定

`model/webBook/BookContent.kt:253-262`：
- `ruleContent.nextContentUrl` **返回单个 URL 或 URL 数组**；`getStringList(nextUrlRule, isUrl = true)` 收集全部
- 外层 `mapAsync(threadCount.coerceIn(1, maxNextPageConcurrency))` 并发抓取并 append
- ⚠️ **递归调用传 `getNextPageUrl=false` —— 只翻一层，不做多级递归**
- 目录翻页同理；**JS 返回 `[]`/`null`/`""` 时停止**；源码还会**过滤掉等于当前 `redirectUrl` 的项** 以防死循环
- 正文空判定：`if (!bookChapter.isVolume && contentStr.isBlank()) throw ContentEmptyException("内容为空")`
- 正文排版 `replaceRegex`：`contentStr.split("\n").joinToString("\n"){ it.trim() }` → 应用规则 →
  `joinToString("\n"){ "　　$it" }`（**全角双空格缩进**）

### 4.5 其它必须知道的边界行为

- **`baseUrl` 用重定向后的 `res.url`**：`WebBook.searchBookAwait` 里 `BookList.analyzeBookList(baseUrl = res.url, …)`
  ⇒ **所有相对 URL 都相对最终 URL 解析，不是请求 URL**
- `isRedirect = res.raw.priorResponse?.isRedirect == true`；
  `bookUrl` 兜底 = `if (isRedirect) baseUrl else getAbsoluteURL(analyzeUrl.url, analyzeUrl.ruleUrl)`
- **搜索 URL 命中 `bookUrlPattern` 时直接按详情页解析**（返回单元素列表，`searchBook.infoHtml = body`）`BookList.kt:62-81`
- **发现规则 `bookList` 为空 → 回退搜索规则**
- `bookInfoInit` ⇒ **JSON 键实为 `init`**；`init` 非空时 `analyzeRule.setContent(analyzeRule.getElement(it))`
  （**仅 AllInOne 正则或 JS**）。JS 返回 JSON
  `{a:书名,b:作者,c:分类,d:字数,e:最新章节,f:简介,g:封面URL,h:目录URL}`，各字段填对应 key
- `canReName`：规则非空 且 详情页书名非空 → 用详情页书名覆盖（作者同理）
- 简介 `intro`：`startsWith("<usehtml>")`/`"<md>"`/`"<useweb>"` 时**原样保留不格式化**，
  否则 `HtmlFormatter.format(...).take(5000)`
- `chapterList` 项 **title 为空则整条丢弃**；url 空时兜底：`isVolume` → `title + index`，否则 → `baseUrl`
- `ruleToc.preUpdateJs` 非空 → `AnalyzeRule(book, bookSource, preUpdateJs = true).evalJS(preUpdateJs)` 后再取目录
- 一级卷不解析正文：`bookChapter.isVolume && url.startsWith(bookChapter.title)` → 返回 `bookChapter.tag ?: ""`
- 目录页正文缓存：`if (book.tocUrl == baseUrl) book.tocHtml = body`，正文阶段
  `bookChapter.url == book.bookUrl && book.tocHtml` 非空则复用

---

## 5. 书源 JSON 字段全集

`data/entities/BookSource.kt`，`@Entity(tableName = "book_sources")`，`@PrimaryKey var bookSourceUrl: String = ""`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `bookSourceUrl` | String | `""` | **必填，唯一标识**（重复会覆盖） |
| `bookSourceName` | String | `""` | 必填 |
| `bookSourceGroup` | String? | null | 分组 |
| `bookSourceType` | Int | 0 | **0 文本 / 1 音频 / 2 图片 / 3 文件** |
| `bookUrlPattern` | String? | null | 书籍详情页 URL 正则；命中则跳过列表解析 |
| `customOrder` | Int | 0 | 排序 |
| `enabled` | Boolean | true | 启用 |
| `enabledExplore` | Boolean | true | 发现页启用 |
| `jsLib` | String? | null | 代码片段或 JSON Map |
| `enabledCookieJar` | Boolean? | true | 自动管理 Cookie |
| `concurrentRate` | String? | null | 并发率 |
| `header` | String? | null | 请求头 JSON，**key 大小写敏感**；可 `@js:`/`<js>` 动态 |
| `loginUrl` | String? | null | 登录 URL（JS 需实现 `login()`） |
| `loginUi` | String? | null | 登录界面 JSON 数组 |
| `loginCheckJs` | String? | null | 登录检查 JS，**返回 `true` 表示已登录** |
| `coverDecodeJs` | String? | null | 封面解密 |
| `bookSourceComment` | String? | null | 备注（`addErrorComment` 会加 `// Error: …` 前缀） |
| `variableComment` | String? | null | 变量说明 |
| `lastUpdateTime` | Long | 0 | — |
| `respondTime` | Long | 180000 | — |
| `weight` | Int | 0 | 权重 |
| `exploreUrl` | String? | null | 发现页 URL；字符串或 JSON 数组；可 `<js>`/`@js:` |
| `exploreScreen` | String? | null | — |
| `ruleExplore` | ExploreRule? | null | 发现规则 |
| `searchUrl` | String? | null | 搜索 URL |
| `ruleSearch` | SearchRule? | null | 搜索规则 |
| `ruleBookInfo` | BookInfoRule? | null | 详情规则 |
| `ruleToc` | TocRule? | null | 目录规则 |
| `ruleContent` | ContentRule? | null | 正文规则 |
| `ruleReview` | ReviewRule? | null | 段评 |
| `eventListener` | Boolean | false | — |
| `customButton` | Boolean | false | — |
| `homepageModules` | String? | null | 首页模块 JSON 数组 |

**`concurrentRate` 语法** `help/ConcurrentRateLimiter.kt`：
- `"1000"` = 单数字 → **访问间隔毫秒**（`ConcurrentRecord(now, 1, 1000, 0)`）
- `"20/60000"` = `rateIndex > 0` → `accessLimit=20`、`interval=60000`（**时间窗口内最大请求数**）；
  `<=0` 抛 NumberFormatException（catch 后保留旧 record）
- `null` / `""` / `"0"` → 不限速

### 5.1 规则子对象字段全集

| 实体 | 字段 |
|---|---|
| `BookListRule`(接口) | `bookList` `name` `author` `intro` `kind` `lastChapter` `updateTime` `bookUrl` `coverUrl` `wordCount` |
| `SearchRule` | 上述 + **`checkKeyWord`**（全 `String? = null`） |
| `ExploreRule` | 同 BookListRule（无 `checkKeyWord`） |
| `BookInfoRule` | **`init`** `name` `author` `intro` `kind` `lastChapter` `updateTime` `coverUrl` `tocUrl` `wordCount` `canReName` `downloadUrls` `relatedBooks` |
| `TocRule` | `preUpdateJs` `chapterList` `chapterName` `chapterUrl` `formatJs` `isVolume` `isVip` `isPay` `updateTime` `nextTocUrl` |
| `ContentRule` | `content` `subContent` `title` `nextContentUrl` `webJs` `sourceRegex` `replaceRegex` `imageStyle` `imageDecode` `payAction` `callBackJs` |

⚠️ **所有规则实体都带自定义 `jsonDeserializer`**：`isJsonObject` → 正常反序列化；
**`isJsonPrimitive` → 先取 `asString` 再反序列化**（即字段可以直接写成字符串）；否则 null。Node 实现必须复刻。

`checkKeyWord` 逻辑：`ruleSearch.checkKeyWord` 非空**且不含 `http`/`::`/`++`/`--`** 时用它，否则用默认。

`TocRule` 细节：
- `isVip`：**结果为 `null`/`false`/`0`/`""` 时为非 VIP**（源码 `isTrue()`）
- `updateTime`：可用 `java.timeFormat(timestamp)`
- `nextTocUrl`：单个 URL 或 URL 数组；JS 返回 `[]`/`null`/`""` 时停止

`ContentRule` 细节：
- `subContent` = 副文规则，拼在正文后；**以 `http` 开头则当 URL 再抓一次取 body**
- `title` = 有些网站只能在正文中获取标题
- `imageStyle` 默认居中/`FULL` 最大宽度；`payAction` = 购买操作；`callBackJs` = 事件回调
- `imageDecode` = 图片解密 JS，`result` 为 **ByteArray**

---

## 6. 调试入口约定

搜索填关键字；发现填 `排行榜::https://www.example.com/rank?page={{page}}`；详情页填 URL；
**目录页前缀 `++`**；**正文页前缀 `--`**。

---

## 7. Node.js 实现建议

- **依赖**：`cheerio`、`iconv-lite`（**GBK 必需**）、`jsonpath-plus` 或 `jsep`+自研、
  `node:vm`、`undici`/手写、`tldts`、`css-select`+`domhandler`
- **`charset` 双语义**与 `##` 的 `$N` 捕获组回填是最易踩的两个坑
- ✅ `cheerio` 完全覆盖 JSoup 引擎 API（`children`/`getElementsByClass`/`getElementsByTag`/
  `Collector.collect(Evaluator.Id)`/`getElementsContainingOwnText`/`select` 均有等价物）
- ✅ `node:vm` + `vm.createContext()` 覆盖 `@js:`；注入 `java`/`cookie`/`cache`/`source`/`book`/`result`/
  `baseUrl`/`chapter`/`title`/`src`/`nextChapterUrl` 即可
- ⚠️ **`java.*` 只能实现纯计算子集**；❌ **实现不了必须显式降级**：`androidId`、`getWebViewUA`、
  `webView*` 全家、`startBrowser*`、`getVerificationCode`、`openUrl`、文件类 API、TTF 字体解析
- ❌ **Rhino 特有差异**：`importPackage`/`JavaAdapter`/`Java.type` 在 Node `vm` 里**没有对应物**
- ⚠️ **Node `vm` 不是安全沙箱** —— 官方文档明确说明可被逃逸。跑不可信书源需 `vm2` 类方案或独立子进程
- **超时保护必须设**（Rhino 靠 `instructionObserverThreshold = 10000` + `maximumInstructionStackDepth = 1000`；
  Node `vm` 用 `{ timeout }`），否则恶意书源可挂死进程
- **实现顺序**：① URL 层（`AnalyzeUrl`：占位符 → UrlOption → 编码 → 请求 → 解码）→
  ② JSoup 层（`AnalyzeByJSoup` 逐字移植）→ ③ `AnalyzeRule` 调度层（模式判定 + 连接符 + `##`）→
  ④ 五阶段 `webBook` 流水线 → ⑤ JS 引擎层 → ⑥ JSONPath/XPath
- **80% 覆盖率务实取舍**：只实现 §1.1 标志 + §1.10 默认文法 + `@css:` + `@js:` 纯计算子集即可覆盖绝大多数中文站书源

### 7.1 本项目实际采用的架构（`src/rules/jsrt.js` / `src/engine/source.js`）

**同步 `java.ajax` 的替代方案 ——「推测式预取 + 重跑」**：

Rhino 里的 `java.ajax(url)` 是**同步阻塞**调用，Legado 的规则 JS 因此天然串行、cookie 时
序必然正确。Node 里做不到同步阻塞（实测：Worker + `SharedArrayBuffer` + `Atomics.wait`
方案首请求 28s、主线程一阻塞 worker 定时器即被拖慢到 40s 超时，**已放弃**）。

本项目的等价实现：

1. `@js:` 在 `node:vm` 里跑，`java.ajax` 等 IO 方法**不真的发请求** —— 命中
   `Prefetcher` 缓存则返回内容，未命中则把请求**登记进 miss 表**（以
   `method+url+body+headers+charset` 为键）并返回空串。
2. JS 跑完后引擎检查 miss 表：非空则**按登记顺序串行**取回全部 URL（写入缓存与
   CookieJar），然后**整条规则重跑**；重复至无 miss 或 `MAX_ROUNDS=64`。
3. 对确定性 JS，多跑几轮与「同步阻塞」结果等价；串行是必须的 ——
   曾用 `Promise.all` 并发取回，导致 `signJs` 的 Set-Cookie 还没写入 jar、后续 POST 已
   发出，站点返回 403（uu书库 7940 实测）。

**JS 时间冻结**：一轮内 `Date.now()`/`new Date()` 返回值固定（`nowMs` 注入），否则重跑
时同一段 JS 会因时间不同而产出不同 URL，永不收敛。

**其它必须对齐的点**（均已实现，见 README「书源兼容性」）：

- 默认 UA = 桌面 Windows Chrome。站点常按 UA 下发**完全不同的模板**，用移动 UA 会让
  CSS 规则全部取空 —— 这不是书源的错。
- POST body 非 JSON/XML 且未显式给 `Content-Type` 时，自动按 form 编码并设
  `application/x-www-form-urlencoded`（§3.2 的 `postForm` 分支）。
- 页面级规则的初始 `result` 是**整页 HTML 原文**（`AnalyzeRule.kt:207` +
  `BookContent.kt:227-234` 的 `setContent(body)`），不是空串；整条规则只含一个 `@js:`
  块时尤其依赖这一点。
- 正文出规则后必须过 `HtmlFormatter`（段首补 `\u3000\u3000`），且后续清理**不能**对每
  行直接 `.trim()`（`'\u3000\u3000'.trim() === ''`，会把缩进吃掉）。

---

## 8. 示例源（测试 fixture）

① **CSS + 正则源**：`searchUrl="/search?q={{key}}&page={{page}}"`；`ruleSearch.bookList="@css:li.clearfix"`；
`ruleBookInfo.name="##:book_name\"[^\"]+\"([^\"]*)\"##$1###"`（OnlyOne）；
`ruleContent.content="@css:.chapter-content p@textNodes##广告文字|本站声明.*|<!\\[CDATA\\[|\\]\\]>"`（净化）；
`ruleToc.chapterList="-:<li><a[^\"]+\"([^\"]*)\">([^<]*)"`，`chapterName="$2"`、`chapterUrl="$1"`。

② **XPath 源**：`searchUrl="/search,{\n  \"method\": \"POST\",\n  \"body\": \"q={{key}}\"\n}"`；
`ruleToc.nextTocUrl="//*[@id=\"chapter-list\"]/*[position()>1]/@value"`。

③ **JSONPath 源**：`ruleBookInfo: {}`（空 → 直接取搜索结果）；`ruleContent.content="$.chapter.body"`；
`ruleSearch.bookUrl="/book/detail?id={$._id}"`；`ruleToc.chapterList="$.chapterInfo.chapters.[*]"`；
`searchUrl="/book/search?query={{key}}&start={{(page-1)*20}}&limit=20"`。

---

## 9. ⚠️ 文档 vs 源码差异（实现时以源码为准）

| # | 文档说法 | 源码事实 |
|---|---|---|
| 9.1 | `url-options.md` 列 9 个 UrlOption 字段，含独立 `proxy` | **实为 14 个字段**：多 `origin`/`webJs`/`dnsIp`/`bodyJs`/`serverID`/`webViewDelayTime`；**没有 `proxy` 字段**，代理走 `header.proxy` |
| 9.2 | `source-fields.md` 写 `ruleBookInfo.bookInfoInit` | **JSON 键实为 `init`** |
| 9.3 | `discovery-url.md` 只列 `title`/`url`/`style` | `ExploreKind` 实为 `title`/`url`/`type`/`action`/`chars`/`default`/`viewName`/`style`，`Type = url\|text\|button\|toggle\|select` |
| 9.4 | js.md 说 Rhino **1.8.0** | 实依赖 `libs.versions.toml:70` = **1.8.1** |
| 9.5 | `BookSource.kt:41` 注释写 `0 文本,1 音频,2 图片,3 文件,4 视频` | **`BookSourceType` 常量只定义到 3**，无 `video=4` |
| 9.6 | — | `BookSource.kt` 有 `ruleReview`/`exploreScreen`/`homepageModules`，`docs/dev/source-fields.md` 完全未记载 |

---

## 10. 存疑项（未验证）

- 🟡 `grading`/3.0 vs 3.25+ 版本差异：本仓库为 MD3 fork 最新 main，**无法逐版本比对**
- 🟡 `NetworkUtils.getSubDomain` 依赖 Android `PublicSuffixDatabase`：Node 用 `tldts` **理论一致但不保证等价**
- 🟡 `EncodingDetect.getHtmlEncode` 探测算法**未读源码**，Node 侧用 `chardet`/`jschardet` 是**近似实现**
- 🟡 `HtmlFormatter.formatKeepImg` 的 `formatImagePattern` 正则已逐字提取，但**多分支行为未实测**
- 🟡 Rhino `Packages` 全局：`initStandardObjects()` 不含 ImporterTopLevel 是**源码推断**；Rhino 1.8.1 内部对未定义
  标识符的处理**未实测**（文档的图片解密示例用了 `Packages.java.io.ByteArrayInputStream` 且称可用，说明实践中能工作）
- 🟡 `BookSourceType = 4`（视频）：注释提到但常量缺失，**无法确定是否真的支持**
- 🟡 `ruleReview`/`exploreScreen`/`homepageModules` 有字段定义但**未读消费方代码**
- 🟡 `webView`/字体/图片解密 在 Node 端无对应实现能力，只能降级

### 10.1 实测确认的差异（本机真站验证，非源码推断）

| # | 假设 | 实测事实 |
|---|---|---|
| 10.1 | 默认请求 UA 用移动端更「像 App」 | **必须用桌面 Windows Chrome**。`zuizhong.net` 按 UA 返回两套模板：同一 `POST /search.html` 桌面 UA 得 18698 B 含 `.txt-list`（17 个 `li`），移动 UA 得 16983 B 且 `.txt-list` 为 0 —— 书源规则只对桌面模板有效 |
| 10.2 | POST 裸 UTF-8 body 即可 | 站点**只认带表单 `Content-Type` 的 POST**。裸 body / 百分号编码但缺 Content-Type → 空壳页且不含关键词 |
| 10.3 | 预取可以并发加速 | **不可以**。并发会打乱 `java.ajax` 的 cookie 时序（详见 §7.1） |
| 10.4 | 整条只含 `@js:` 的规则其 `result` 为空串 | 页面级规则的 `result` 是**整页 HTML**；给空串会导致正则零匹配、正文 0 字（神文小说 7908 实测） |
| 10.5 | `##` 是段级操作符 | `##` 在 `@`/`&&` 切分**之前**就整条剥离（`AnalyzeRule.kt:768-779`），是挂在规则上的替换后缀 |
