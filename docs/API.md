# API contract v1

Base `/api/v1`. JSON requests. Lists return arrays. IDs are UUID strings. Errors use `{detail: string}`. Authentication uses `Authorization: Bearer <token>`.

- `POST /auth/login` `{username,password,portal?}` => `{token,user:{id,username,name,role}}`.
- `POST /auth/bootstrap` `{username,password,name}` creates the first admin only.
- `GET /auth/me` returns current user.
- `GET /dashboard` => `{projects,groups,students,pending_tasks,exceptions}` counts.
- `GET/POST /projects`: `{id,name,status}`; creation `{name}`.
- `GET/POST /subjects`: `{id,project_id,name}`; creation `{project_id,name}`.
- `GET/POST /groups`: `{id,subject_id,name,template_id}`; creation `{subject_id,name}`.
- `GET/POST /classes`: `{id,name,grade}`.
- `GET/POST /students`: `{id,name,candidate_number,class_id}`.
- `GET/POST /users`: `{id,username,name,role}`; creation includes password, role admin/teacher.
- `GET/POST /templates`: `{id,group_id,name,paper,sides,candidate_length,revision,questions}`. Creation includes group_id, name, paper A3/A4, sides 1/2, candidate_length, questions array.
- Question: `{id,number,type,options,answer,points,regions,rule,review_mode,threshold}`. type single/multiple/subjective; options count; answer array of letters; regions array `{page,x,y,width,height}` in millimetres; rule object; review_mode single/double; threshold numeric.
- `PUT /templates/{id}` updates draft; `POST /templates/{id}/publish` fixes revision; `GET /templates/{id}/pdf` prints PDF.
- `GET/POST /scan-batches`: `{id,group_id,room,status,back_order}`; creation `{group_id,room,back_order}` with same/reverse.
- `POST /scan-batches/{id}/pages` multipart: file, capture_id UUID, side front/back, sequence integer. Response `{id,status}`. Device may use same Bearer token initially.
- `GET /scan-batches/{id}/pages` array of page metadata.
- `POST /scan-batches/{id}/pair` confirms sequence pairing; mismatched counts block.
- `GET /tasks` lists current teacher tasks. `POST /tasks/claim` `{template_id,question_id}` returns task or null.
- `POST /tasks/{id}/score` `{score,idempotency_key}` returns persisted score and final score.
- `GET /exceptions`; `POST /exceptions/{id}/resolve` `{resolution}`.
- `GET /results?group_id=...`; `GET /results/export?group_id=...` CSV.

Frontend must show server validation and loading states. Scanner freezes batch on upload HTTP 409. Never fabricate a successful server response.

## 教师分配与进度

- `GET/POST /assignments`：`{template_id,question_id,user_ids,weights,arbitration_mode,arbitrator_ids}`。再次提交同一题更新已有分配并保留审计。`weights` 是教师UUID到0～255权重的映射，默认1；0暂停普通评阅。仅支持主观题。
- `arbitration_mode`：`random` 从有效阅卷教师中随机选取；`designated_random` 从 `arbitrator_ids` 指定范围中随机选取；`fixed` 仅指定一位仲裁教师。
- 普通任务预先按权重分配，默认尽量均分，答卷顺序随机化并持久保存。双评每份答卷的两评教师必须不同，同时保留可回避的仲裁教师。因此双评份额也受每份最多一评及仲裁回避约束。
- 双评至少需要两位有效普通阅卷教师，以及一位可回避前两评的仲裁教师。固定仲裁教师不承担该题普通两评。无可用仲裁配置时拒绝保存。
- 修改分配保留已经完成和仍有效的在途任务，对剩余任务重新平衡。跳过的作答后移，之后仍可再次领取。
- `GET /review-progress?template_id=...&question_id=...`：返回 `my_total,my_completed,my_in_progress,my_progress,total_submissions,question_completed,question_progress,paper_progress`。仲裁任务产生后计入该仲裁教师份额。百分比为0～100。
- `GET /tasks/history?template_id=...&question_id=...`：本人评分历史，`final_score` 读取当前实际给分；未完成两评或仲裁时为null。
- 专职仲裁教师同样可见对应考试、题卡及任务入口，但只能领取分配给自己的仲裁作答。

## 顺序重阅

- `POST /tasks/{id}/regrade-from` `{reason}`：以本人该题已完成的评分为起点，按首次评分时间及任务ID顺序，将该份及后续本人评分加入重阅队列；返回 `{queued}`。重复加入不生成重复队列项。冻结成绩禁止加入。
- 后续 `POST /tasks/claim` 优先返回重阅队列，任务携带 `regrading:true` 及本人原评分。原评分在再次提交前继续有效；新评分保留在评分流水和审计中，并更新当前实际给分。
- 重阅中 `POST /tasks/{id}/skip` 将当前作答后移；再次提交评分后移出重阅队列。特殊卷更正使原任务失效时同步清除对应重阅项。
- `/review-progress` 另返回 `my_regrade_pending`。管理员发布成绩时检查重阅队列，尚有待重阅作答则返回409。

## 自动异常、核查与客观题更正

- `GET/PUT /groups/{id}/anomaly-rules`：三项规则 `blank_answers:{enabled,min_count}`、`same_answer_run:{enabled,min_run}`、`invalid_single:{enabled}`。默认全部关闭；前两项默认数量为5，启用后分别按“至少N题留空”和“连续至少N道单选题相同选项”检查。规则按题卡题目顺序计算，题号可不连续；空白、多填或多选题打断单选连续段。
- 保存规则同步重新检查该组已有答卷；配页、客观题人工更正和补扫替换后自动检查相关答卷。冻结后需先复核才能修改规则。
- 相同证据的已处理异常保持已处理；证据或阈值变化重新打开；条件消失或规则关闭时自动结束待核查事项。规则只生成提示，不改分。
- 正面考号缺填、多填或识读不清生成固定的信息缺失提示；人工更正考号或排除该页后重新检查。四角定位失败仍保留原始图片并进入人工核查。
- `GET /exceptions?group_id=...&status=open|resolved`；`GET /exceptions/{id}` 返回异常、考试/科目/题卡组/考场/考生上下文、页面图与选项，以及教师报告对应的作答裁切图。
- `POST /exceptions/{id}/resolve` `{resolution}`；`POST /exceptions/resolve` `{ids,resolution}` 原子批量记录核查结论，每次1～500条。记录核查结论不会代替实际数据更正。
- `GET /submissions/{id}/objective` 返回题号、选项数、原始识读与当前采用选项；`PUT /submissions/{id}/objective` `{reason,selections:{question_uuid:["A"]}}` 保存单份答卷的人工更正，空数组表示确认空白。保留原页识读，分数按更正结果计算并写入审计；冻结或缺考答卷拒绝修改。

## 成绩分析

- `GET /analysis/group?group_id=...&metric=raw|converted&include_absent=false&pass_ratio=0.6&excellent_ratio=0.85`：题卡组、班级、题目、分布及考生排名。及格/优秀线为相应满分的比例，可调整；返回统计口径、满分、缺考/未结分人数等。
- 默认缺考不进入统计，未结总分始终不进入总分均值和排名。单题按该题已评作答统计，可以包含尚未完成整卷的考生。排名为同分并列、后续跳号。
- 教师只能读取已发布的任教班级成绩，排名范围标为 `assigned_classes`；管理员为题卡组范围。赋分的转换仍先按完整题卡组计算，再过滤教师可见班级。
- `GET /analysis/group/export` 同上参数及 `view=classes|questions|distribution|students`，导出CSV。单题始终统计原始得分；班级总分统计可选择原始分或赋分。
- `GET /analysis/project?project_id=...`：跨科明细。每个题卡组单列，保留无记录、缺考和待结分的区别；`recorded_raw_sum` 只汇总已有总分，`recorded_effective_sum` 对已赋分科目采用赋分，其余采用原始分。合计不推定应考科目齐全，不跨不同组/满分生成考试排名。
- `GET /analysis/project/export?project_id=...`：同口径跨科CSV。教师仅包括已发布且实际具有任教班级成绩的列；导出标题及内容均处理表格公式起始字符。

## 应考名单与未扫描发布

- `GET /groups/{id}/roster`：管理员读取应考名单配置及 `scanned|absent|unscanned` 采集状态。`PUT` 请求 `{class_ids,student_ids}`，按当前班级成员和额外学生去重生成本次考试快照；之后变更学生姓名/班级不自动改动快照，重新保存时更新。已存在的答卷不会随名单调整删除。
- 没有配置应考名单时，只能统计已有答卷，不能判断哪些学生漏扫。名单快照单独储存，普通教师的题卡组列表不暴露全体应考学生资料。
- 已配置名单中没有答卷记录的学生进入成绩列表，`status=unscanned`，总分和每题分数为null；不生成阅卷任务，不计缺考，不进入分数均值、分布或排名，即使启用缺考计入统计仍保持空白。
- `/analysis/group` 的汇总及班级项包含 `unscanned` 人数；跨科条目包含 `unscanned_records`。没有任何已知总分时跨科合计为null。CSV状态使用“未扫描”，分数为空。
- `POST /results/publish` 默认阻止未扫描；管理员可提交 `{group_id,force_unscanned:true,reason}` 强制发布。强制只豁免未扫描，仍阻止已扫描但未评完、未处理异常和待重阅。记录发布事件、原因及未扫描学生ID；题卡组保存发布时未扫描人数。
- 发布后需要先 `POST /groups/{id}/reopen` 才能重新配置名单、新建扫描批次、接收新页或配页补录；相同已接收页及已配对批次的幂等重试仍返回原结果。
- 教师可见已发布的任教班级“未扫描”行，即使该班尚无任何实考答卷；其余班级身份信息不返回。

## 归档、下载、释放与文件恢复

- `POST /projects/{id}/archive`：创建 `omp-project-2` ZIP，包含项目范围记录、应考快照、评分流水、审计、关联人员公开资料、发布题卡PDF、扫描原图/校正图、背景/插图/特殊卷资产。人员公开资料不包含密码、会话或通行密钥。`manifest.json`记录每项实际归档字节的大小及SHA-256，数据库保存ZIP整体SHA-256。原始扫描哈希与接收记录不一致时拒绝归档。
- `GET /archives`；`POST /archives/{id}/download-link` 返回五分钟有效的随机下载URL。浏览器以该URL流式下载，避免前端一次构造大型Blob；凭证仅以哈希保存。旧的带Bearer `/archives/{id}/download` 仍可用。
- `POST /projects/{id}/release-preview` `{archive_id,mode:"local"|"all"}`：校验归档、扫描文件、项目范围及冻结状态，返回十分钟有效清单ID、文件数、本地活动文件大小、远端文件数和前100项明细。`all`包含本地及远端，`local`仅删除本地活动扫描文件。未覆盖的新文件、已变化文件、未发布题卡组或仍在处理的页面会阻止预览。
- `POST /projects/{id}/release` `{plan_id,confirm:true}`：同一管理员再次确认清单，再校验后删除；返回 `status:completed|partial,released_files,failed`。清单过期需重建，活动操作不能重复运行；部分失败保留具体路径和错误类型，可重试同一清单。已完成清单重试只返回结果，不再次删除后来恢复的文件。
- 删除远端时核对数据库登记的后端及位置指纹，防止配置换到其他存储后删除同名对象。旧目录记录缺少位置指纹时需先重新同步，不能直接远端释放。S3/ROS、WebDAV、SFTP均有单文件删除适配，真实端点尚待联调。
- 保留归档ZIP、打印稿、题卡资产、对象UUID、成绩与审计；释放量为活动扫描文件副本大小，归档ZIP本身仍占用空间。读取已释放扫描页时，按数据库索引回取远端或归档文件，不扫描储存目录。
- `POST /archives/{id}/restore`：校验归档后恢复本地扫描文件与题卡资产。已有文件哈希一致则跳过，不一致则拒绝覆盖；评分和当前数据库记录不回滚。该入口是文件恢复，完整数据库恢复仍需另行实现和演练。
- 项目释放进行中保留租约并阻止发起复核，操作结束或失败后解除；失败文件可从保留的归档恢复。

## 后台文件任务

- `POST /projects/{id}/archive-jobs`；`POST /projects/{id}/release-preview-jobs` `{archive_id,mode}`；`POST /projects/{id}/release-jobs` `{plan_id,confirm:true}`；`POST /archives/{id}/restore-jobs`：立即返回202及持久任务。页面使用这些接口，同步接口保留兼容。
- `GET /jobs?project_id=...`；`GET /jobs/{id}`：管理员读取状态、阶段 `phase`、`progress_current/progress_total`、错误及最终 `result`。`POST /jobs/{id}/retry` 重试已停止或租约过期任务。
- `GET /release-plans/{id}`：读取已完成的预览或释放结果，含 `can_confirm`、有效期及失败清单；不同管理员可查看，确认仍限定原操作人。
- 同项目活动的相同文件任务合并，其余文件任务等待当前任务结束后再提交。实际执行时重新校验管理员权限，长任务周期续租，恢复时沿用预定归档/清单ID。
- 预览有效期内确认后排队，保存 `confirmed_at`，执行不因排队跨过预览期而丢失已确认操作。未确认的过期清单仍拒绝提交。

## 人工定位、缺考识读与补齐答卷

- 新建或编辑草稿记录 `layout_version=2`，发布后固定。该版式在正面124mm/45mm处使用独立缺考填涂框；缺少版式版本的早期已发布题卡按旧版生成，关闭自动缺考识读，避免应用升级改变旧打印稿含义。
- 二维码使用ZXing-C++识读并按方向转正，OpenCV作为补充；多个不同OMP二维码视为归属冲突。明确属于其他OMP题卡/面的二维码不能用人工定位改写归属。
- `GET /pages/{id}/alignment?rotation=0|1|2|3`：返回原始扫描图方向、像素宽高、二维码匹配/冲突及图像URL。`GET /pages/{id}/alignment-source` 返回对应转向后的原图PNG，管理员鉴权，禁止公共缓存。
- `POST /pages/{id}/align` `{request_id,corners:[{x,y},...],rotation,reason,confirm_template}`：按原图像素坐标，依次提供左上、右上、右下、左下定位方块中心。二维码缺失或仅有非OMP二维码时，需 `confirm_template:true` 人工确认。拒绝退化、越界及顺序错误的四点。
- 人工恢复保留原始扫描件、旧校正图及识读元数据，重新识读考号/选项/缺考框，结束对应定位异常。相同操作UUID重试不会重复调整；已配对或发布页面使用补扫替换流程。隔离批次仍需管理员明确恢复，其他异常页不受此操作影响。
- 正面缺考框明确填涂后，配页生成 `status=absent`，记0分且不进阅卷任务。`PUT /pages/{id}` 可在配页前纠正 `absent_mark`；`PUT /submissions/{id}/attendance` `{absent,reason}` 可在发布前纠正已有答卷出勤，同时使旧评分失效并保留流水。
- 手工缺考记录没有扫描页时，`POST /submissions/{id}/attach-pages` `{page_ids:[front,back?],reason}` 核对完整页数、版式、面、考号和页面归属后补齐整卷并恢复实考。新页标记已关联，后续批次配页跳过这些页面，防止重复建卷。
- 补扫替换的新页同样登记已关联；全部页面已经关联的批次可确认完成。
- 校正图记录内容哈希。远端/归档回取及文件恢复核对当前使用版本，避免取回人工调整前的旧校正图。
- 扫描端批次查询另含 `group_frozen`；客户端刷新后同步已排除页和已恢复识读页，人工处理完成后恢复本地批次状态。已排除页不计入配页数量，原文件保留。

## 扫描设备鉴权

- `GET/POST /scanner/devices`：管理员列出设备或登记 `{label,public_key,password}`。公钥为P-256 SPKI DER的Base64URL；登记需再次验证管理员密码。
- `POST /scanner/devices/{id}/status` `{enabled,reason,password?}`：停用或重新启用，启用需管理员密码。每次状态变更使旧设备令牌失效；启用由当前管理员重新授权。
- `POST /scanner/challenge` `{device_id}` 返回 `{id,device_id,nonce,expires_at}`；`POST /scanner/authenticate` `{challenge_id,signature}` 返回15分钟设备令牌。消息和签名规范见 `扫描端.md`；挑战只用一次，失败也消耗。
- `POST /scanner/devices/{id}/adopt-batches` `{batch_ids}`：管理员关联未归属设备的历史批次。迁移其他设备的批次另需旧设备已停用、`migrate_revoked:true` 和 `reason`，不得直接夺取活动设备批次。
- 设备令牌与用户会话隔离，仅扫描元数据和本机批次接口接受。题卡元数据去除题目/标准答案，考试/科目/组只返回扫描必需字段；人员、成绩和管理接口拒绝该令牌。
- 设备创建批次时服务端写入设备归属，客户端不能伪造。读取、上传和配页均核对归属，管理员管理接口保留完整权限。
# 扫描页面质量证据补充

`POST /scan-batches/{id}/pages` 的 multipart 可附加 `quality_report` JSON，旧客户端可省略。记录含 `issues`、`dpi`、`sharpness`、`corners` 以及本次 `options`；服务端验证字段类型、允许的异常代码与数值范围，忽略客户端的通过结论，仍独立识读。质量记录存入页面 `scanner_quality`，问题写入 `source=scanner`、`kind=scan_quality` 的异常，并冻结批次。重复捕获UUID沿用原始证据，不新增异常。

非空问题报告的首次成功上传响应包含 `quality_review_required=true`。管理员通过异常核查接口填写结论后，再调用批次恢复接口；仍有扫描端质量异常未核查时恢复返回409。质量依据不因自动异常规则重算、排除页面或补正识读结果而自动结案。

## 编号与扫描单题版本

用户、业务对象与题目定义使用统一UUID注册表。题目UUID可由客户端提供或服务端生成，必须为标准小写UUID；格式错误返回422，跨对象/跨题卡冲突及移出草稿后重新使用返回409。编辑同一道仍在草稿中的题保留编号，复制题卡须为每题生成新编号。移除题目、对象软删除或硬删除会永久保留编号。旧数据库初始化时从对象、用户及题卡审计历史补建注册表；发现历史编号冲突会停止迁移，需要明确处理，避免改写已有评分引用。

- `GET /submissions/{id}/answer-slices?history=false`：管理员读取该答卷当前单题切片记录；`history=true` 包含被补扫或特殊区域版本取代的记录。
- 答卷 `answer_slice_ids` 映射题目定义UUID到当前扫描作答UUID。切片记录包含 `question_id`、`question_number`、`sources`（整页编号、区域、校正图校验值）、`asset_id`、`previous_id`、`status` 及被取代时的 `superseded_by`。
- 配页、整卷补齐、补扫替换或特殊区域/彩色补图会维护切片版本。改变图像来源时生成新UUID，旧区域与旧资产记录保留；重复确认批次不会重复生成。
- 新领取评阅任务含 `answer_slice_id`，其图像接口使用该任务绑定的版本，保留补扫前历史图像。早期未绑定的任务仍走原有兼容读取路径，需要迁移后才能获得相同历史版本保证。
- 项目归档的 `data.json` 含相应 `identifiers` 注册记录、单题切片历史与所引用的历史资产。

账号初始化、创建、密码/Passkey登录、恢复码重置密码及退出写入 `account-events`，已有资料、密码和权限更改继续留痕；账号事件与其审计记录不写入密码或访问令牌。

## 制卡、Default与题卡库

- `POST /subjects` 可传 `group_mode:default`，同时创建Default组并返回 `default_group_id`；`custom` 为自行分组。旧请求省略此字段时保留原有自行分组行为。
- `POST /subjects/{id}/default-group` 幂等获取或建立该科目的Default组。
- `POST /templates/check` 接收当前题卡定义，返回 `{valid,issues}`，用于显示发布前的配置问题；发布接口继续独立检查。
- `POST /templates/preview?page=1` 接收当前题卡定义，返回与打印PDF同源的110 DPI PNG。新草稿缺少编号时仅为预览生成临时编号，不保存业务记录。需管理员身份，响应 `Cache-Control:private,no-store`；需要Poppler，忙碌、缺失或超时返回503。
- `POST /templates/{id}/save-to-library` `{name?,description?}`：从已保存题卡建立独立定义快照，快照内的题目没有运行时UUID。
- `GET /template-library`：管理员读取快照列表及定义。
- `POST /template-library/{id}/instantiate` `{group_id?,subject_id?,name?}`：优先使用目标组，未提供组时使用目标科目的Default组；新建题卡和所有题目UUID，返回未发布草稿。
- 有扫描批次或答卷的组不能被新题卡覆盖绑定；冻结组需先复核或选择新组。库快照与实例不会相互改写。

## WebSocket刷新提示

`WS(S) /events` 仅接受配置来源的连接，不接受查询参数。首帧须在5秒内发送 `{"type":"auth","token":"当前用户会话"}`，成功响应 `{"type":"ready"}`。扫描设备令牌不接受；会话失效、退出或角色变化关闭码4401。

- `{"type":"invalidate","roots":["review-progress","tasks"]}`：重读相关REST资源；根路径仅作为类别，不包含记录ID或业务数据。
- `{"type":"sync"}`：慢连接合并或恢复时重读当前资源。
- `{"type":"ping"}`：客户端回复 `{"type":"pong"}`。

新连接及重连应主动补读，通知不是可恢复业务事件流。服务端按登录身份筛选可见类别，客户端不能订阅其他用户或项目。资料与实时资源加载需忽略过期请求，退出后不再接纳旧会话返回的数据。

## 数据库备份与离线恢复

- `POST /system/backup`：管理员创建一致SQLite备份，返回 `{id,status,created_at,size,sha256,counts,download_url}`。
- `GET /system/backups`：管理员读取登记备份，附带本地文件 `available`。
- `GET /system/backups/{id}/download`：管理员流式下载，校验失败返回409，缺失返回404，响应禁用缓存。
- `python -m server.recovery BACKUP --target NEW_DIRECTORY --files-from FILE_SNAPSHOT --sha256 EXPECTED`：恢复到新目录，校验并补齐扫描文件，不覆盖原目录。显式 `--database-only` 可仅恢复数据库。

恢复保留业务记录和原审计，失效旧登录/设备/下载授权及未完成释放清单，未完成后台任务等待管理员核查重试。具体运行步骤和报告字段见《备份与恢复》。

## 管理员日志检索

- `GET /system/audit?before=&limit=50&actor=&object_id=&kind=&action=`：只读业务审计。返回 `{items,next_before}`，每条含游标、时间、操作者、对象类型、操作及隐藏凭证后的快照。
- `GET /system/requests?before=&limit=50&actor=&object_id=&status=`：HTTP访问记录，返回 `{items,next_before,writer_errors,queued}`。按路由模式记录接口，不返回完整URL或请求正文。
- `limit` 为1至200，`before` 为更早记录的游标。访问与业务记录为独立游标序列；教师、扫描设备均不可访问。

教师读取成绩及跨科分析必须属于已发布任教范围；无关题卡组/考试返回403。阅卷进度仍按阅卷分配授权。

## 赋分导入与版本

- `POST /score-conversions`：配置 `name,mode,segments|table,precision?,boundary?`，新建版本1。`precision` 为0至2，默认2；`boundary` 为lower/upper，默认lower。配置要求赋分不低于40且随原始分不下降。
- `POST /score-conversions/import-preview`：multipart `file,name?,precision?`，支持CSV/TSV及UTF-8/GB18030。返回 `{config,row_count,sample}`，预览最多20行，不建立方案。
- `PUT /score-conversions/{id}`：提交完整定义及 `base_revision,reason`。修订号冲突或用于已发布成绩返回409；成功版本加一。已绑定组的现有完成成绩必须全部可转换。
- `PUT /groups/{id}/conversion`：`{conversion_id}` 绑定，传null取消；冻结组拒绝改动，绑定前检查当前分数覆盖。
- 发布组保存 `conversion_snapshot,conversion_revision`，统计采用该快照。副本通过POST创建新ID，不修改旧方案。

百分位按整个题卡组的有效实考成绩计算，同分采用居中百分位；缺考为0、未扫描为空。对照表严格匹配原始分数，不自动插值。详见《赋分方案》。

# 成绩中的班级快照

`GET /api/v1/results` 的每行包含 `class_id`、`class_name`、`grade`。配页及手动登记缺考会把班名、年级保存到 `student_snapshot`；配置应考名单时，沿用名单已有的考试身份快照。以后升年级、更名或转班不覆盖这些字段。

分组统计的 `classes`、学生明细以及考试跨科汇总与CSV使用同一快照。缺少答卷的应考学生使用应考名单中的班级快照。教师查看权限继续由其当前任教班级决定，保存历史班名不延续已撤销的教师权限。

较早答卷若未保存班名或年级，优先使用同一学生且班级编号相同的应考快照；两种快照均缺少字段时只能回退当前班级信息，无法据此恢复真实历史名称。此兼容回退不改写原始答卷记录。

## 登录入口与忘记密码

`portal`可选`admin`或`marking`。管理后台仅管理员可登录，阅卷台允许教师和管理员；未传portal的现有设备/API登录保持原权限。Passkey的`/auth/passkeys/login/options`也接受portal并随挑战保存，完成验证时再次检查管理权限。

`POST /auth/recovery-reset`接收`{username,code,new_password}`：验证一次性恢复码、设置10至200字符的新密码并撤销旧会话，操作在同一事务完成；返回`{status:"reset"}`，不签发登录令牌。无效恢复码不消耗有效码，重放返回401。恢复码不再作为独立登录方式。

## 考试层级删除

- `POST /{kind}/{id}/deletion-preview`：管理员预览，kind仅支持`projects`、`subjects`、`groups`。返回预览编号、目标、完整路径、分类数量、保留评分/归档数量、后台任务及运行状态影响、阻塞事项和10分钟有效期。预览不删除业务数据。
- `GET /deletion-plans/{id}`：管理员查看预览或完成结果。
- `GET /deletion-plans/{id}/manifest`：下载完整JSON清单，包含`summary`、`target`、`records`、`questions`、`background_tasks`、`release_plans`；从一致读快照生成临时文件并发送后清理，不把完整清单重复写入预览和审计。已完成删除的清单仍可下载。
- `POST /deletion-plans/{id}/confirm` `{confirm:true,reason}`：仅生成预览的管理员确认。过期、范围数据变化或后台任务运行中返回409；已完成的相同请求幂等返回原结果。删除记录、审计、编号退役、任务取消及重阅状态清理均在一个事务内完成。

当前采用逻辑删除，保留扫描文件、原始评分、审计、共享资产及归档。相关后台任务标记`cancelled_by_deletion`后不能重试；相关释放清单标记`invalidated_by_deletion`后不能确认或执行。项目归档保留`project_name`及`project_deleted`，供独立归档入口展示。详见《删除与数据保留》。
