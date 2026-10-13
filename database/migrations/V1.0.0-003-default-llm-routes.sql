-- V1.0.0-003：平台默认模型路由（tenant_id = 0，§8.1）。
-- 主模型百炼（通义千问），备用 DeepSeek；具体型号以 bake-off 结果为准，改这里的配置即可，代码里不写模型名。
-- api_key_ref 是环境变量名，密钥本身只放服务器的 .env。
-- params 原样并入请求体：temperature / max_tokens，以及关闭深度思考的开关（百炼 enable_thinking=false）。
INSERT INTO llm_route (tenant_id, stage, provider, model, base_url, api_key_ref, priority, params) VALUES
  (0, 'understand',       'dashscope', 'qwen-plus',  'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0,"max_tokens":400,"enable_thinking":false}'),
  (0, 'understand',       'deepseek',  'deepseek-chat', 'https://api.deepseek.com/v1',                    'DEEPSEEK_API_KEY',  2, '{"temperature":0,"max_tokens":400}'),
  (0, 'compose',          'dashscope', 'qwen-plus',  'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0.3,"max_tokens":400,"enable_thinking":false}'),
  (0, 'compose',          'deepseek',  'deepseek-chat', 'https://api.deepseek.com/v1',                    'DEEPSEEK_API_KEY',  2, '{"temperature":0.3,"max_tokens":400}'),
  (0, 'compose.advanced', 'dashscope', 'qwen-max',   'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0.3,"max_tokens":400,"enable_thinking":false}'),
  (0, 'compose.advanced', 'deepseek',  'deepseek-chat', 'https://api.deepseek.com/v1',                    'DEEPSEEK_API_KEY',  2, '{"temperature":0.3,"max_tokens":400}'),
  (0, 'final_check',      'dashscope', 'qwen-flash', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0,"max_tokens":50,"enable_thinking":false}'),
  (0, 'background',       'dashscope', 'qwen-plus',  'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"temperature":0,"max_tokens":600,"enable_thinking":false}'),
  (0, 'embedding',        'dashscope', 'text-embedding-v4', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 1, '{"dimensions":1024}'),
  (0, 'rerank',           'dashscope', 'gte-rerank-v2', 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank', 'DASHSCOPE_API_KEY', 1, '{}');
