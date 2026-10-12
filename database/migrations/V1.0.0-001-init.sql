-- V1.0.0-001：核心表结构，来源：技术开发方案 §12（12.1～12.4、12.6），全部业务表带 tenant_id
-- 修改表结构请新增迁移文件，不要改已执行过的文件（迁移脚本会校验 checksum）

CREATE TABLE IF NOT EXISTS schema_migration (
  version     VARCHAR(64)  PRIMARY KEY COMMENT '迁移脚本文件名，如 V1.0.0-001-init.sql',
  checksum    CHAR(64)     NOT NULL,
  applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT '已执行的迁移脚本（§18.2）';

CREATE TABLE tenant (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(32)  NOT NULL UNIQUE COMMENT '租户编码',
  name          VARCHAR(64)  NOT NULL,
  industry      VARCHAR(32)  NOT NULL COMMENT '行业：auto_aftermarket…',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=启用 0=停用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP
) COMMENT '租户（id=0 保留给平台级知识，不插入本表）';

CREATE TABLE admin_account (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  real_name     VARCHAR(64)  NULL,
  role          VARCHAR(32)  NOT NULL COMMENT 'platform_admin/tenant_admin/operator/labeler',
  status        TINYINT      NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user (tenant_id, username)
) COMMENT '管理台账号';

CREATE TABLE channel_account (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  channel       VARCHAR(32)  NOT NULL COMMENT 'simulator/wecom_group/…',
  name          VARCHAR(64)  NOT NULL COMMENT '机器人名称',
  bot_user_id   VARCHAR(128) NOT NULL COMMENT '机器人在渠道内的身份ID',
  credentials   TEXT         NULL COMMENT '渠道凭证（AES加密）',
  status        TINYINT      NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant (tenant_id)
) COMMENT '渠道机器人账号';

CREATE TABLE cs_staff (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(64)  NOT NULL COMMENT '客服姓名',
  wecom_user_id   VARCHAR(128) NOT NULL COMMENT '企微账号',
  status          TINYINT      NOT NULL DEFAULT 1 COMMENT '接线状态：1=正常 0=禁用',
  last_assigned_at DATETIME    NULL COMMENT '轮询分配用',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_wecom (tenant_id, wecom_user_id)
) COMMENT '客服人员配置（PRD 3.9）';

CREATE TABLE rp_param (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT '0=平台默认',
  param_key   VARCHAR(64)  NOT NULL,
  param_value VARCHAR(255) NOT NULL,
  value_type  VARCHAR(16)  NOT NULL COMMENT 'int/float/bool/string/json',
  description VARCHAR(255) NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_param (tenant_id, param_key)
) COMMENT '参数配置（PRD 3.8），租户值覆盖平台默认值';

CREATE TABLE llm_route (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT '0=平台默认',
  stage       VARCHAR(32)  NOT NULL COMMENT 'understand/final_check/compose/background/vision/embedding/rerank',
  provider    VARCHAR(32)  NOT NULL COMMENT 'dashscope/hunyuan/deepseek/doubao/self_hosted',
  model       VARCHAR(64)  NOT NULL,
  base_url    VARCHAR(255) NOT NULL,
  api_key_ref VARCHAR(64)  NOT NULL COMMENT '密钥在环境变量/密钥管理中的引用名，不存明文',
  priority    TINYINT      NOT NULL DEFAULT 1 COMMENT '1=主 2=备',
  params      JSON         NULL COMMENT 'temperature/max_tokens 等',
  status      TINYINT      NOT NULL DEFAULT 1,
  UNIQUE KEY uk_route (tenant_id, stage, priority)
) COMMENT '模型路由（模型层隔离）';
CREATE TABLE rule_pack_version (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  version      VARCHAR(32)  NOT NULL COMMENT '如 2026.10.12-01',
  status       VARCHAR(16)  NOT NULL COMMENT 'DRAFT/PUBLISHED/ARCHIVED',
  snapshot     JSON         NULL COMMENT '发布时的全量快照',
  remark       VARCHAR(255) NULL,
  published_by BIGINT UNSIGNED NULL,
  published_at DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ver (tenant_id, version)
) COMMENT '业务规则包版本';

CREATE TABLE rp_intent_def (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  parent_id   BIGINT UNSIGNED NULL COMMENT '一级（主意图）为平台锁死，parent 为空',
  level       TINYINT      NOT NULL COMMENT '1=主意图 2=子意图 3=三级',
  code        VARCHAR(64)  NOT NULL COMMENT '如 CONSULT / CONSULT.PRICE / CONSULT.PRICE.YEARS',
  name        VARCHAR(64)  NOT NULL,
  definition  VARCHAR(500) NOT NULL COMMENT '判定定义（进 Prompt）',
  examples    JSON         NULL COMMENT '2~3 条典型例句（进 Prompt）',
  sort        INT          NOT NULL DEFAULT 0,
  status      TINYINT      NOT NULL DEFAULT 1,
  UNIQUE KEY uk_code (tenant_id, code)
) COMMENT '意图体系（主/子/三级）';

CREATE TABLE rp_intent_sample (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  text        VARCHAR(500) NOT NULL COMMENT '整组文本',
  context     VARCHAR(1000) NULL COMMENT '上一组/关系便签（可选）',
  labels      JSON         NOT NULL COMMENT '[{span, main, sub, l3}]',
  source      VARCHAR(32)  NOT NULL COMMENT 'history_label/feedback/manual',
  vector_id   VARCHAR(64)  NULL COMMENT 'Qdrant point id',
  status      TINYINT      NOT NULL DEFAULT 1,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant (tenant_id, status)
) COMMENT '意图识别样本（few-shot 动态检索）';

CREATE TABLE rp_intent_action (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  intent_code VARCHAR(64)  NOT NULL COMMENT '主意图或子意图 code，子意图优先',
  scene       VARCHAR(32)  NOT NULL DEFAULT 'ANY' COMMENT 'PRESALE/AFTERSALE/ANY',
  action      VARCHAR(16)  NOT NULL COMMENT 'ANSWER/GUIDE/HANDOFF/FALLBACK',
  source      VARCHAR(16)  NOT NULL COMMENT 'RAG/FAQ/SCRIPT/TOOL/PRICE_LIST/FLOW（FLOW 为预留，§3.3）',
  flow_key    VARCHAR(64)  NULL COMMENT 'source=FLOW 时的任务流标识（预留）',
  handoff     TINYINT      NOT NULL DEFAULT 0 COMMENT '是否触发转人工（答后转）',
  script_key  VARCHAR(64)  NULL,
  tool_key    VARCHAR(64)  NULL,
  UNIQUE KEY uk_action (tenant_id, intent_code, scene)
) COMMENT '意图→动作表（§5.5.1）';

CREATE TABLE rp_script (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  script_key  VARCHAR(64)  NOT NULL COMMENT 'ack/close/chitchat_fallback/complaint_soothe/handle_guide/handoff_transfer/mic_return/low_conf/degrade…',
  scene       VARCHAR(32)  NOT NULL DEFAULT 'ANY',
  intent_code VARCHAR(64)  NULL,
  content     VARCHAR(1000) NOT NULL COMMENT '支持变量 {{customerName}} {{staffName}}',
  weight      INT          NOT NULL DEFAULT 1 COMMENT '同 key 多条时随机加权',
  status      TINYINT      NOT NULL DEFAULT 1,
  KEY idx_key (tenant_id, script_key)
) COMMENT '话术包';

CREATE TABLE rp_price_item (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  product     VARCHAR(64)  NOT NULL,
  brand       VARCHAR(64)  NULL,
  model       VARCHAR(64)  NULL,
  term        VARCHAR(64)  NULL COMMENT '年限/里程',
  price       DECIMAL(12,2) NOT NULL,
  crm_product_id BIGINT UNSIGNED NULL COMMENT '来源 CRM 商品',
  remark      VARCHAR(255) NULL,
  status      TINYINT      NOT NULL DEFAULT 1,
  KEY idx_prod (tenant_id, product, brand, model)
) COMMENT '价目表';

CREATE TABLE rp_sensitive_word (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT '0=平台通用',
  word        VARCHAR(64)  NOT NULL,
  level       VARCHAR(8)   NOT NULL COMMENT 'P0=直接转人工 P1=记录',
  category    VARCHAR(32)  NOT NULL COMMENT 'complaint/police/legal/threat/refund/regulator/exposure/privacy…',
  status      TINYINT      NOT NULL DEFAULT 1,
  UNIQUE KEY uk_word (tenant_id, word)
) COMMENT '敏感词';

CREATE TABLE rp_relation_keyword (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT '0=平台通用',
  pattern     VARCHAR(128) NOT NULL COMMENT '关键词或正则（以 re: 前缀）',
  relation    VARCHAR(16)  NOT NULL COMMENT 'CORRECT/NEW_TOPIC/CLOSE/CONTINUE',
  priority    INT          NOT NULL DEFAULT 0 COMMENT '多命中时取高优先级；纠正>换题>收尾>承接',
  status      TINYINT      NOT NULL DEFAULT 1
) COMMENT '接关/末检规则词典（PRD 3.9.2）';

CREATE TABLE rp_group_name_pattern (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  regex       VARCHAR(255) NOT NULL COMMENT '命名捕获组：name/phone/product/bought',
  sort        INT          NOT NULL DEFAULT 0,
  status      TINYINT      NOT NULL DEFAULT 1
) COMMENT '企微群名称解析模板';
CREATE TABLE conversation (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  channel            VARCHAR(32)  NOT NULL,
  channel_chat_id    VARCHAR(128) NOT NULL COMMENT '群ID',
  chat_name          VARCHAR(255) NULL COMMENT '群名称',
  customer_name      VARCHAR(64)  NULL,
  customer_phone_hash CHAR(64)    NULL,
  customer_phone_mask VARCHAR(20) NULL,
  crm_customer_id    BIGINT UNSIGNED NULL,
  customer_snapshot  JSON         NULL COMMENT '客户级/订单级元数据快照：车辆、已购商品、订单',
  status             VARCHAR(16)  NOT NULL COMMENT 'QUEUED/ACTIVE/ENDED',
  mic_owner          VARCHAR(8)   NOT NULL DEFAULT 'BOT' COMMENT '话筒归属 BOT/HUMAN',
  mic_staff_id       BIGINT UNSIGNED NULL,
  turn_count         INT          NOT NULL DEFAULT 0,
  handoff            TINYINT      NOT NULL DEFAULT 0 COMMENT '是否转人工',
  handoff_reason     VARCHAR(500) NULL COMMENT '转人工依据',
  handoff_at         DATETIME     NULL,
  sensitive_words    JSON         NULL COMMENT '命中敏感词汇总',
  emotion            VARCHAR(16)  NULL COMMENT '最近情绪',
  frustration_count  INT          NOT NULL DEFAULT 0 COMMENT '挫败次数',
  resolved           TINYINT      NULL COMMENT '是否解决：1/0/NULL未判定',
  rule_pack_version  VARCHAR(32)  NOT NULL,
  started_at         DATETIME(3)  NOT NULL,
  ended_at           DATETIME(3)  NULL,
  end_reason         VARCHAR(32)  NULL COMMENT 'CLOSE_IDLE/IDLE/MANUAL',
  KEY idx_chat (tenant_id, channel_chat_id, status),
  KEY idx_time (tenant_id, started_at)
) COMMENT '会话';

CREATE TABLE conversation_background (
  conversation_id    BIGINT UNSIGNED PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  content            JSON         NOT NULL COMMENT '会话级背景（笔记本，§5.9）',
  updated_turn_seq   INT          NOT NULL,
  updated_at         DATETIME(3)  NOT NULL
) COMMENT '会话级背景';

CREATE TABLE turn (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  conversation_id    BIGINT UNSIGNED NOT NULL,
  seq                INT          NOT NULL COMMENT '会话内第几轮',
  status             VARCHAR(16)  NOT NULL COMMENT 'IN_PROGRESS/DONE',
  responder          VARCHAR(8)   NOT NULL DEFAULT 'BOT' COMMENT '本轮回复方：BOT/HUMAN（人工轮：话筒在人工手里时由人工回复）',
  relation           VARCHAR(16)  NULL COMMENT '接关关系：CONTINUE/CORRECT/NEW_TOPIC/CLOSE',
  relation_note      VARCHAR(500) NULL COMMENT '关系便签',
  scene              VARCHAR(32)  NULL,
  decision           JSON         NULL COMMENT '决策结果：动作、来源、转人工判定',
  final_check_relation VARCHAR(16) NULL COMMENT '末检关系',
  final_check_msg_ids JSON        NULL COMMENT '末检关系会话（消息ID）',
  merge_count        TINYINT      NOT NULL DEFAULT 0,
  reply_text         TEXT         NULL COMMENT '回复内容详情',
  reply_confidence   DECIMAL(4,3) NULL COMMENT '内容置信度',
  reply_status       VARCHAR(16)  NULL COMMENT 'SENT/VOIDED/SEND_FAILED/DEGRADED',
  reply_msg_id       BIGINT UNSIGNED NULL,
  low_confidence     TINYINT      NOT NULL DEFAULT 0,
  handoff_triggered  TINYINT      NOT NULL DEFAULT 0,
  rule_pack_version  VARCHAR(32)  NOT NULL,
  timings            JSON         NULL COMMENT '各环节耗时 ms',
  seal_to_send_ms    INT          NULL COMMENT '封组→发出耗时（验收口径）',
  started_at         DATETIME(3)  NOT NULL,
  finished_at        DATETIME(3)  NULL,
  UNIQUE KEY uk_seq (conversation_id, seq),
  KEY idx_tenant_time (tenant_id, started_at)
) COMMENT '轮';

CREATE TABLE msg_group (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  conversation_id    BIGINT UNSIGNED NOT NULL,
  turn_id            BIGINT UNSIGNED NULL COMMENT '所属轮；归档组属于人工轮',
  sender_channel_user_id VARCHAR(128) NOT NULL,
  status             VARCHAR(16)  NOT NULL COMMENT 'COLLECTING/UNDERSTANDING/FINAL_CHECKING/SENT/ARCHIVED/VOIDED',
  merged_text        TEXT         NOT NULL COMMENT '整组拼接内容',
  message_count      INT          NOT NULL,
  seal_reason        VARCHAR(16)  NOT NULL COMMENT 'QUIET/COUNT/HARD/HUMAN_TIMEOUT/HUMAN_REPLIED',
  first_msg_at       DATETIME(3)  NOT NULL,
  sealed_at          DATETIME(3)  NOT NULL,
  KEY idx_conv (conversation_id),
  KEY idx_turn (turn_id)
) COMMENT '组';

CREATE TABLE message (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  conversation_id    BIGINT UNSIGNED NOT NULL,
  group_id           BIGINT UNSIGNED NULL,
  channel             VARCHAR(32)  NOT NULL COMMENT '渠道（与 channel_msg_id 一起保证幂等）',
  channel_msg_id     VARCHAR(128) NOT NULL,
  sender_role        VARCHAR(16)  NOT NULL COMMENT 'CUSTOMER/STAFF_CS/STAFF_OTHER/PARTNER/BOT/SYSTEM（发送时刻的角色快照）',
  sender_channel_user_id VARCHAR(128) NOT NULL,
  sender_name        VARCHAR(64)  NULL,
  msg_type           VARCHAR(16)  NOT NULL COMMENT 'text/image/voice/file/other',
  content            TEXT         NULL COMMENT '文本 / 图片描述',
  media_url          VARCHAR(512) NULL,
  mentions           JSON         NULL,
  is_placeholder     TINYINT      NOT NULL DEFAULT 0 COMMENT '占位应答',
  sent_at            DATETIME(3)  NOT NULL,
  received_at        DATETIME(3)  NOT NULL,
  UNIQUE KEY uk_channel_msg (tenant_id, channel, channel_msg_id),
  KEY idx_conv_time (conversation_id, sent_at)
) COMMENT '消息（轮原会话：文本/图片；流水账）';

CREATE TABLE chat_member (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  channel            VARCHAR(32)  NOT NULL,
  channel_chat_id    VARCHAR(128) NOT NULL COMMENT '群ID',
  member_id          VARCHAR(128) NOT NULL COMMENT '企业成员 userid 或外部联系人 ID',
  name               VARCHAR(64)  NULL COMMENT '群昵称/姓名',
  member_type        VARCHAR(16)  NOT NULL COMMENT '渠道身份：INTERNAL/EXTERNAL_WECHAT/EXTERNAL_WECOM/UNKNOWN',
  corp_name          VARCHAR(128) NULL COMMENT '外部企业微信用户所属企业',
  role               VARCHAR(16)  NOT NULL COMMENT '业务角色：CUSTOMER/STAFF_CS/STAFF_OTHER/PARTNER/BOT',
  role_source        VARCHAR(16)  NOT NULL COMMENT 'CHANNEL/CONFIG/FALLBACK/MANUAL（MANUAL 不被同步覆盖）',
  is_primary         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否主客户',
  joined_at          DATETIME     NULL,
  left_at            DATETIME     NULL,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_member (tenant_id, channel_chat_id, member_id)
) COMMENT '群成员与身份（§11.3）';

CREATE TABLE customer_identity (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  channel            VARCHAR(32)  NOT NULL,
  external_member_id VARCHAR(128) NOT NULL COMMENT '外部联系人 ID',
  union_id           VARCHAR(128) NULL,
  crm_customer_id    BIGINT UNSIGNED NULL,
  phone_hash         CHAR(64)     NULL,
  bind_source        VARCHAR(16)  NOT NULL COMMENT 'GROUP_NAME/MANUAL',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ext (tenant_id, channel, external_member_id)
) COMMENT '外部联系人 ↔ CRM 客户绑定';

CREATE TABLE partner_corp (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  corp_name          VARCHAR(128) NOT NULL COMMENT '协作方企业名（4S店/保险公司/厂家…）',
  status             TINYINT      NOT NULL DEFAULT 1,
  UNIQUE KEY uk_corp (tenant_id, corp_name)
) COMMENT '协作方企业白名单';

CREATE TABLE intent_span (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  turn_id            BIGINT UNSIGNED NOT NULL,
  group_id           BIGINT UNSIGNED NOT NULL,
  idx                TINYINT      NOT NULL COMMENT '片段序号',
  main_intent        VARCHAR(16)  NOT NULL COMMENT '意图分类',
  sub_intent         VARCHAR(64)  NULL,
  l3_intent          VARCHAR(64)  NULL,
  span_text          VARCHAR(500) NOT NULL COMMENT '意图原内容',
  product            VARCHAR(64)  NULL,
  model_confidence   DECIMAL(4,3) NULL,
  action             VARCHAR(16)  NULL,
  source             VARCHAR(16)  NULL,
  answer_confidence  DECIMAL(4,3) NULL COMMENT '检索/执行置信度',
  label_main         VARCHAR(16)  NULL COMMENT '人工复核标注（评测用）',
  label_sub          VARCHAR(64)  NULL,
  KEY idx_turn (turn_id)
) COMMENT '意图片段';

CREATE TABLE retrieval_log (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  turn_id            BIGINT UNSIGNED NOT NULL,
  intent_span_id     BIGINT UNSIGNED NULL,
  collection         VARCHAR(32)  NOT NULL COMMENT 'kb_chunks/kb_faq',
  query              VARCHAR(1000) NOT NULL,
  filters            JSON         NULL,
  results            JSON         NOT NULL COMMENT 'Top-K：chunkId/score/rerankScore',
  top_score          DECIMAL(4,3) NULL COMMENT '重排后最高分=置信度',
  latency_ms         INT          NOT NULL,
  created_at         DATETIME(3)  NOT NULL,
  KEY idx_turn (turn_id),
  KEY idx_tenant_time (tenant_id, created_at)
) COMMENT '检索日志（验收指标"检索置信度"数据源）';

CREATE TABLE handoff_record (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  conversation_id    BIGINT UNSIGNED NOT NULL,
  turn_id            BIGINT UNSIGNED NULL,
  trigger_type       VARCHAR(16)  NOT NULL COMMENT 'SENSITIVE/INTENT/FRUSTRATION/BLIND_SPOT/MANUAL',
  evidence           VARCHAR(1000) NOT NULL,
  package            JSON         NOT NULL COMMENT '交接包',
  staff_id           BIGINT UNSIGNED NULL,
  staff_first_reply_at DATETIME(3) NULL,
  auto_returned_at   DATETIME(3)  NULL COMMENT '人工超时自动切回时间',
  created_at         DATETIME(3)  NOT NULL,
  KEY idx_conv (conversation_id),
  KEY idx_tenant_time (tenant_id, created_at)
) COMMENT '转人工记录';

CREATE TABLE state_transition_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  entity_type   VARCHAR(16) NOT NULL COMMENT 'conversation/turn/group/mic',
  entity_id     BIGINT UNSIGNED NOT NULL,
  from_state    VARCHAR(16) NULL,
  to_state      VARCHAR(16) NOT NULL,
  reason        VARCHAR(64) NULL,
  trace_id      VARCHAR(64) NULL,
  created_at    DATETIME(3) NOT NULL,
  KEY idx_entity (entity_type, entity_id)
) COMMENT '状态流转日志';

CREATE TABLE llm_call_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  trace_id      VARCHAR(64)  NOT NULL,
  turn_id       BIGINT UNSIGNED NULL,
  stage         VARCHAR(32)  NOT NULL,
  prompt_key    VARCHAR(64)  NOT NULL,
  provider      VARCHAR(32)  NOT NULL,
  model         VARCHAR(64)  NOT NULL,
  input_tokens  INT          NULL,
  output_tokens INT          NULL,
  latency_ms    INT          NOT NULL,
  status        VARCHAR(16)  NOT NULL COMMENT 'OK/TIMEOUT/ERROR/SCHEMA_FAIL/FALLBACK',
  request       MEDIUMTEXT   NULL COMMENT '入参（脱敏后；保留 30 天）',
  response      MEDIUMTEXT   NULL,
  created_at    DATETIME(3)  NOT NULL,
  KEY idx_trace (trace_id),
  KEY idx_tenant_time (tenant_id, created_at)
) COMMENT 'LLM 调用日志（计量/排障）';
CREATE TABLE kb_document (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL COMMENT '0=平台级',
  title         VARCHAR(255) NOT NULL,
  product       VARCHAR(64)  NOT NULL COMMENT '产品名称；通用知识填"通用"',
  intent        VARCHAR(16)  NOT NULL DEFAULT 'CONSULT',
  category      VARCHAR(32)  NULL COMMENT '产品功能/产品条款/产品区别/购买条件…',
  file_url      VARCHAR(512) NOT NULL,
  file_type     VARCHAR(16)  NOT NULL,
  active_version INT         NOT NULL DEFAULT 1,
  chunk_count   INT          NOT NULL DEFAULT 0,
  status        VARCHAR(16)  NOT NULL COMMENT 'PARSING/READY/FAILED/DISABLED',
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_prod (tenant_id, product)
) COMMENT '知识文档';

CREATE TABLE kb_chunk (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  document_id   BIGINT UNSIGNED NOT NULL,
  version       INT          NOT NULL,
  seq           INT          NOT NULL,
  heading_path  VARCHAR(500) NULL,
  content       TEXT         NOT NULL,
  vector_id     VARCHAR(64)  NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'active',
  KEY idx_doc (document_id, version)
) COMMENT '知识切片（向量在 Qdrant，原文在此便于预览/编辑）';

CREATE TABLE kb_faq (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  product       VARCHAR(64)  NOT NULL,
  intent        VARCHAR(16)  NOT NULL COMMENT 'OBJECTION/QUERY/CONSULT…',
  sub_intent    VARCHAR(64)  NULL,
  question      VARCHAR(500) NOT NULL,
  similar_questions JSON     NULL,
  answer        TEXT         NOT NULL,
  source        VARCHAR(32)  NOT NULL COMMENT 'import/feedback/manual',
  status        VARCHAR(16)  NOT NULL DEFAULT 'active',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_prod (tenant_id, product, intent),
  FULLTEXT KEY ft_question (question) WITH PARSER ngram COMMENT '向量库不可用时的降级检索（§16.2）'
) COMMENT 'FAQ';

CREATE TABLE kb_feedback (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  type          VARCHAR(24)  NOT NULL COMMENT 'NEW_FAQ/SCRIPT_REVISION/INTENT_SAMPLE',
  conversation_id BIGINT UNSIGNED NULL,
  turn_id       BIGINT UNSIGNED NULL,
  payload       JSON         NOT NULL COMMENT '问题/AI答案/人工答案/错误意图/建议意图',
  cluster_key   VARCHAR(64)  NULL COMMENT '相似问题聚类',
  status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/APPROVED/REJECTED',
  reviewer_id   BIGINT UNSIGNED NULL,
  reviewed_at   DATETIME     NULL,
  result_ref    VARCHAR(64)  NULL COMMENT '入库后的 faq/sample/script id',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (tenant_id, type, status)
) COMMENT '知识回流';

CREATE TABLE eval_dataset (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(128) NOT NULL,
  type          VARCHAR(16)  NOT NULL COMMENT 'INTENT/RETRIEVAL/E2E',
  item_count    INT          NOT NULL DEFAULT 0,
  file_url      VARCHAR(512) NOT NULL COMMENT 'jsonl',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT '评测集';

CREATE TABLE eval_run (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  dataset_id    BIGINT UNSIGNED NOT NULL,
  rule_pack_version VARCHAR(32) NOT NULL,
  prompt_keys   JSON         NOT NULL,
  model_routes  JSON         NOT NULL,
  metrics       JSON         NULL COMMENT '主意图准确率/二级意图准确率/置信度达标率/P50/P95',
  report_url    VARCHAR(512) NULL,
  status        VARCHAR(16)  NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT '评测运行记录';
CREATE TABLE flow_def (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL COMMENT '0=平台通用',
  flow_key      VARCHAR(64)  NOT NULL COMMENT '如 appointment.maintenance',
  name          VARCHAR(64)  NOT NULL,
  engine        VARCHAR(16)  NOT NULL COMMENT 'native/langgraph/remote',
  version       VARCHAR(32)  NOT NULL COMMENT '与代码中的任务流版本对应',
  trigger_type  VARCHAR(16)  NOT NULL DEFAULT 'INTENT' COMMENT 'INTENT/EVENT/CRON/MANUAL',
  trigger_conf  JSON         NULL COMMENT '事件名 / cron 表达式等',
  slot_schema   JSON         NULL COMMENT '需收集的信息（JSON Schema）',
  config        JSON         NULL COMMENT '超时、确认话术、可用工具白名单等',
  status        TINYINT      NOT NULL DEFAULT 0 COMMENT '1=启用 0=停用',
  UNIQUE KEY uk_flow (tenant_id, flow_key, version)
) COMMENT '任务流定义';

CREATE TABLE flow_instance (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '= LangGraph thread_id',
  tenant_id       BIGINT UNSIGNED NOT NULL,
  flow_key        VARCHAR(64)  NOT NULL,
  flow_version    VARCHAR(32)  NOT NULL,
  engine          VARCHAR(16)  NOT NULL,
  conversation_id BIGINT UNSIGNED NULL COMMENT '交互域任务流关联会话；营销任务流可为空',
  crm_customer_id BIGINT UNSIGNED NULL,
  status          VARCHAR(16)  NOT NULL COMMENT 'RUNNING/WAITING_USER/WAITING_HUMAN/SUSPENDED/DONE/CANCELLED/FAILED/HANDOFF',
  slots           JSON         NULL,
  step_log        JSON         NULL COMMENT '节点轨迹（回放用）',
  idempotency_key VARCHAR(64)  NULL COMMENT '写操作幂等键',
  started_at      DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL,
  expire_at       DATETIME(3)  NULL,
  KEY idx_conv (conversation_id, status),
  KEY idx_tenant_status (tenant_id, status)
) COMMENT '任务流运行实例';

CREATE TABLE flow_checkpoint (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flow_instance_id BIGINT UNSIGNED NOT NULL COMMENT 'thread_id',
  checkpoint_ns   VARCHAR(128) NOT NULL DEFAULT '',
  checkpoint_id   VARCHAR(64)  NOT NULL,
  parent_id       VARCHAR(64)  NULL,
  checkpoint      LONGBLOB     NOT NULL COMMENT '序列化状态',
  metadata        JSON         NULL,
  pending_writes  LONGBLOB     NULL,
  created_at      DATETIME(3)  NOT NULL,
  UNIQUE KEY uk_ckpt (flow_instance_id, checkpoint_ns, checkpoint_id)
) COMMENT 'LangGraph 状态存档（MySQL 存档器使用）';
