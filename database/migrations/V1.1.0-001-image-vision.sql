-- V1.1.0-001：图片识别（看图）
-- 1) message 增加媒体 MD5（跨通道去重、看图缓存）与看图结果（审计、多轮回看）。先查再加，可重复执行。
-- 2) 平台默认视觉模型路由：主 qwen-vl-max，备 qwen-vl-plus（百炼 OpenAI 兼容接口）。
-- 3) 运行参数：打开 vision_enabled，新增看图超时、单组最多看几张、最低可信度。

SET @has_media_md5 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND COLUMN_NAME = 'media_md5'
);
SET @ddl := IF(@has_media_md5 = 0,
  'ALTER TABLE message ADD COLUMN media_md5 CHAR(32) NULL COMMENT ''媒体文件 MD5（小写 hex）'' AFTER media_url',
  'SELECT 1');
PREPARE add_media_md5 FROM @ddl;
EXECUTE add_media_md5;
DEALLOCATE PREPARE add_media_md5;

SET @has_media_desc := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND COLUMN_NAME = 'media_desc'
);
SET @ddl := IF(@has_media_desc = 0,
  'ALTER TABLE message ADD COLUMN media_desc JSON NULL COMMENT ''看图结果（vision@v1 输出）'' AFTER media_md5',
  'SELECT 1');
PREPARE add_media_desc FROM @ddl;
EXECUTE add_media_desc;
DEALLOCATE PREPARE add_media_desc;

INSERT INTO llm_route (tenant_id, stage, provider, model, base_url, api_key_ref, priority, params) VALUES
  (0, 'vision', 'dashscope', 'qwen3-vl-plus',       'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0,"max_tokens":500}'),
  (0, 'vision', 'dashscope', 'qwen3.5-omni-flash',  'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 2, '{"temperature":0,"max_tokens":500}')
ON DUPLICATE KEY UPDATE model = VALUES(model), base_url = VALUES(base_url), params = VALUES(params);

INSERT INTO rp_param (tenant_id, param_key, param_value, value_type, description) VALUES
  (0, 'vision_enabled',        'true', 'bool',  '图片理解开关：客户发图时先看图，把图片内容转成文字再理解'),
  (0, 'vision_timeout_ms',     '8000', 'int',   '看图超时（毫秒），超时按 [图片] 占位继续'),
  (0, 'vision_max_images',     '3',    'int',   '单组最多看几张图'),
  (0, 'vision_min_confidence', '0.5',  'float', '看图结果可信度低于此值不采纳')
ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), description = VALUES(description);
