const AiBot = require('@wecom/aibot-node-sdk');
const { generateReqId } = require('@wecom/aibot-node-sdk');
const fs = require('fs');
const path = require('path');

// 读取 .env 中的配置
const envPath = path.resolve(__dirname, '../.env');
let botId = process.env.WECOM_BOT_ID || '';
let botSecret = process.env.WECOM_BOT_SECRET || '';
let dashscopeApiKey = process.env.DASHSCOPE_API_KEY || '';

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('WECOM_BOT_ID=')) {
      botId = trimmed.split('=')[1].trim();
    } else if (trimmed.startsWith('WECOM_BOT_SECRET=')) {
      botSecret = trimmed.split('=')[1].trim();
    } else if (trimmed.startsWith('DASHSCOPE_API_KEY=')) {
      dashscopeApiKey = trimmed.split('=')[1].trim();
    }
  }
}

console.log('====================================================');
console.log('🤖 正在启动 [车和网CRM-agent] 真实 AI 智能体大脑监听进程...');
console.log('🤖 Bot ID:', botId);
console.log('🧠 AI 模型: 通义千问 (Qwen-Plus)');
console.log('====================================================');

/** 流式调用通义千问，每收到增量就回调 onDelta(全文) */
async function callQwenStream(prompt, onDelta) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${dashscopeApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen-plus',
      stream: true,
      messages: [
        {
          role: 'system',
          content: '你是“车和网CRM智能销售/客服助手”，专为车和网客户和员工提供车辆延保、售后咨询、销售线索跟进等专业解答。请用亲切、专业、精炼的语言回答用户提问，条理清晰，支持使用 Markdown 格式。'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dashscope API error: ${response.status} - ${errorText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta(full);
        }
      } catch {}
    }
  }
  return full || '抱歉，未能成功生成回复。';
}

/** 发送一帧流式回复并等待企微回执，失败时打印原因 */
async function sendStream(frame, streamId, content, finish) {
  try {
    const ack = await client.replyStream(frame, streamId, content, finish);
    const errcode = ack?.body?.errcode ?? ack?.errcode;
    if (errcode && errcode !== 0) {
      console.error(`⚠️ 企微回执异常 finish=${finish}:`, JSON.stringify(ack));
    }
    return ack;
  } catch (err) {
    console.error(`❌ 企微发送失败 finish=${finish}:`, err?.message || err);
    throw err;
  }
}

const client = new AiBot.WSClient({
  botId,
  secret: botSecret,
  logger: {
    info: console.log,
    error: console.error,
    warn: console.warn,
    debug: () => {}
  }
});

client.on('authenticated', () => {
  console.log('🎉🎉🎉 [车和网CRM-agent] 认证成功，长连接已就绪！AI 大脑已接入！');
  console.log('👉 现在可以在企业微信群里 @车和网CRM-agent 或单聊发送任何业务问题进行真实 AI 测试！');
});

client.on('message.text', async (frame) => {
  const rawContent = frame.body.text?.content || '';
  const fromUser = frame.body.from?.user_id || '用户';
  // 清洗群里的 @机器人 标记
  const content = rawContent.replace(/@[\w\u4e00-\u9fa5\-_]+(?:\s+|$)/gi, '').trim() || rawContent;
  console.log(`\n📩 [收到来自 ${fromUser} 的提问]: "${content}"`);

  const streamId = generateReqId('stream');

  try {
    await sendStream(frame, streamId, '🤖 正在思考中...', false);
    console.log('✅ 首帧已被企微确认');

    console.log('🧠 正在流式调用通义千问 Qwen-Plus...');
    const startTime = Date.now();
    let latest = '';
    let lastSent = '';
    let sending = false;
    // 每 1 秒把当前已生成内容推一次，保持流不过期
    const timer = setInterval(async () => {
      if (sending || !latest || latest === lastSent) return;
      sending = true;
      const snapshot = latest;
      try {
        await sendStream(frame, streamId, snapshot, false);
        lastSent = snapshot;
      } catch {}
      sending = false;
    }, 1000);

    let aiAnswer;
    try {
      aiAnswer = await callQwenStream(content, (full) => { latest = full; });
    } finally {
      clearInterval(timer);
    }
    while (sending) await new Promise((r) => setTimeout(r, 50));
    console.log(`🧠 推理完成 (耗时 ${Date.now() - startTime}ms, ${aiAnswer.length} 字)`);

    await sendStream(frame, streamId, aiAnswer, true);
    console.log(`📤 [已回复 ${fromUser}]: 企微已确认收到最终帧`);
  } catch (err) {
    console.error('❌ AI 处理或回复失败:', err?.message || err);
    try {
      await sendStream(frame, streamId, '抱歉，处理时出了点问题，请稍后再试。', true);
    } catch {}
  }
});

client.on('event.enter_chat', (frame) => {
  console.log('\n👋 [收到用户进入会话事件]');
  client.replyWelcome(frame, {
    msgtype: 'text',
    text: { content: '您好！我是车和网CRM智能助手。我可以为您提供车辆延保、售后政策与销售线索咨询，请问有什么可以帮您？' }
  });
});

client.on('error', (err) => {
  console.error('❌ 连接发生错误:', err);
});

client.connect();

process.on('SIGINT', () => {
  console.log('正在断开连接...');
  client.disconnect();
  process.exit(0);
});
