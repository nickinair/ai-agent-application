-- 轮作废原因（运行时末检 / 话筒终验作废时写入）。原先直接改在 001 里，已执行过 001 的库不会加这一列，故单独成文件。
-- 改过的 001 在个别开发库里执行过（列已存在），所以先查再加，重复执行也不报错。
SET @has_void_reason := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turn' AND COLUMN_NAME = 'void_reason'
);
SET @ddl := IF(@has_void_reason = 0,
  'ALTER TABLE turn ADD COLUMN void_reason VARCHAR(32) NULL COMMENT ''作废原因：MIC_SEIZED/RECOMPUTE_ABANDONED/RULE_BLOCKED'' AFTER reply_status',
  'SELECT 1');
PREPARE add_void_reason FROM @ddl;
EXECUTE add_void_reason;
DEALLOCATE PREPARE add_void_reason;
