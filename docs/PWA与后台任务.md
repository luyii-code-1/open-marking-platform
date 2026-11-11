# PWA与后台文件任务

## 使用方式

在“考试项目 → 归档与释放”提交任务，页面显示等待、执行、完成或失败及当前阶段进度。关闭页面后任务继续执行，返回页面可查看结果。归档完成后手动下载；释放仍需先生成清单，再由同一管理员明确确认。

归档、核对清单、释放和恢复均返回202及持久任务ID。已完成归档在任务恢复时复用同一归档编号；同项目文件任务串行提交，活动的相同请求合并。已确认的释放操作即使排队超过清单预览期，仍按确认记录执行；未确认清单过期则需重新预览。

## 执行与恢复

- 生产使用Celery/Redis，调度器每15秒恢复待执行或租约过期任务。
- 本地inline模式中，文件长任务由2线程执行，API启动时恢复已有任务，此后每15秒检查；普通页面识别的开发模式行为保留。
- 任务租约10分钟，执行线程每20秒续期；阶段进度按秒节流持久化，租约编号变化后停止旧执行器写入结果。
- 执行前检查提交人的当前管理员角色。明确的数据/权限错误停止，临时故障按退避重试，最多10次；最终失败可核查后手动重试。
- 释放另有独立操作令牌与租约，避免过期执行器覆盖接替执行器的状态。部分文件失败保留结果清单，需管理员再次确认重试。
- 原有同步接口保留兼容，正式页面使用后台任务接口。

真实Celery/Redis容器与全量大归档的耗时仍需在生产规格环境验证。

## PWA安装与更新

先运行前端构建，后启动服务；HTTPS域名或本机地址可注册应用外壳。页面提供“安装应用”，支持安装提示的浏览器会打开安装对话框，其余浏览器显示菜单操作说明。实际安装、独立窗口和手机体验由用户验收。

构建后产生带内容版本号的 `/worker.js`、应用清单和192/512图标。Service Worker仅缓存本次构建的公开HTML、JS、CSS、图标和清单；API、扫描卷、成绩、下载凭证及评分提交全部绕过缓存。离线可载入应用外壳，业务数据读取及提交仍需要服务器连接。

新版本先在等待状态准备缓存，出现“更新可用”后由用户确认重载。请先保存题卡或提交当前评分。首次安装不强制刷新；激活后只清理本应用的旧版本缓存。注册后每10分钟及恢复联网时检查更新。

实现依据：[Service Worker生命周期](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)、[安装提示事件](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event)、[应用图标与purpose](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons)。

## 验证命令

```powershell
.\.venv\Scripts\python.exe -m pytest -q
Set-Location web
npm run build
npm run test:pwa
```

后端用例覆盖后台任务提交/合并、结果恢复、排队释放确认、执行时权限检查、租约归属及本地重启恢复。Worker测试使用Node隔离运行环境，验证缓存隔离、离线外壳、API及私密下载绕过、用户确认更新；它不代替真实浏览器安装和UI验收。

## 服务端实时通知

登录后页面连接 `/api/v1/events`，HTTPS页面使用WSS。连接首帧发送当前登录令牌，令牌不进入URL；来源需要与 `OMP_DOMAIN` 的HTTPS来源一致。开发默认允许localhost/127.0.0.1的5173、8000端口及https://localhost；前后端分开部署时，在 `OMP_WS_ORIGINS` 中列出完整来源。

服务端统一读取已提交审计记录，每秒合并一次，按当前会话、阅卷分配及任教关系筛选刷新提示；消息不携带学生、答案、分数或其他业务内容。页面收到后，仍通过现有REST权限接口读取数据。SQLite数据文件由API和任务进程共享，因此后台进程的提交也能产生通知；每个API进程维护自己的读取位置。

评阅进度、已打开的本人历史、扫描批次、异常列表、成绩分析及文件任务列表接收刷新。当前评分输入、题卡草稿、名单及异常规则编辑表单保留在原地。新连接或重连后重新读取资源；断线按退避间隔重试，恢复联网或返回页面时补读。关闭/退出/撤销的登录会话及角色变化会关闭连接。

通知属于刷新提示，不承担评分提交或文件传输；评分、幂等重试和归档任务仍按既有接口执行。连接较慢时合并为一次整体补读。Service Worker不会接管WebSocket，也不会缓存通知中的业务数据读取。

容器启动参数使用 `websockets-sansio`，消息上限2048字节、输入队列4；通过requirements安装WebSocket协议依赖。Vite开发代理已开启WebSocket转发。协议依据：[Starlette WebSockets](https://www.starlette.io/websockets/)、[Uvicorn WebSocket协议](https://uvicorn.dev/concepts/websockets/)、[Uvicorn配置](https://uvicorn.dev/settings/)。

原生联调不启动浏览器：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m tools.realtime_smoke
.\.venv\Scripts\python.exe -X utf8 -m tools.realtime_smoke --clients 100
```

脚本启动独立临时服务，检查来源、首帧鉴权、不同任务教师的隔离、评分后进度提示、跨进程提交、退出撤销与重连。100位教师连接的本机验证中，一次评分后全部通知约1.006秒到达；另一个无关教师未收到业务提示。该验证使用临时少量作答，不代表完整10800份图像、浏览器重读请求及4核8GB生产机的综合压力结果。真实HTTPS代理、浏览器/手机后台和页面体验待用户验收。
