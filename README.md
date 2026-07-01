# OCS AI 题库适配器

这是放在 OCS Desktop 目录内的本地 AnswererWrapper 适配服务。它接收 OCS 传入的题目、题型和选项，调用兼容 OpenAI Chat Completions 的 API，缓存结果，并生成可粘贴到 OCS 自定义题库配置中的内容。

## 目录

```text
tiku/
  server.js
  src/
  scripts/
  config/
  data/
  .env.example
```

## 快速使用

1. 复制 `.env.example` 为 `.env`，填入你的模型接口：

```text
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=你的 key
AI_MODEL=gpt-4o-mini
AI_FORCE_ANSWER=true
AI_THINKING=enabled
AI_JSON_MODE=true
AI_ENSEMBLE_COUNT=3
AI_VERIFY_ANSWER=true
AI_CACHE_MIN_CONFIDENCE=0.7
```

2. 启动服务：

```powershell
cd "C:\Users\Lenovo\AppData\Local\Programs\OCS Desktop\tiku"
node server.js
```

3. 生成 OCS 配置：

```powershell
node scripts/generate-config.js
```

脚本会写入：

```text
config/ocs-answerer.json
config/ocs-answerer.txt
```

把 `config/ocs-answerer.txt` 里的内容粘贴到 OCS 自定义题库配置里。

## OCS 接口

默认接口：

```text
POST http://127.0.0.1:8787/ocs/answer
GET  http://127.0.0.1:8787/ocs/answer
```

OCS 传参：

```json
{
  "title": "${title}",
  "type": "${type}",
  "options": "${options}"
}
```

服务成功响应：

```json
{
  "code": 1,
  "question": "题目",
  "answer": "A",
  "answerList": ["A"],
  "explanation": "简要解析",
  "confidence": 0.86,
  "cached": false
}
```

多选题如果答案是选项字母，例如 `["A","C"]`，服务会返回：

```text
AC
```

如果是文本类多答案，服务会继续使用 `#` 分隔，例如：

```text
答案一#答案二
```

## 缓存

缓存文件：

```text
data/cache.json
```

同一题目、题型、选项会生成稳定 key。命中缓存时不会重复调用模型。

查看缓存：

```text
GET http://127.0.0.1:8787/cache
```

人工修正缓存：

```text
POST http://127.0.0.1:8787/cache/review
```

请求体：

```json
{
  "key": "缓存 key",
  "answer": "B",
  "status": "confirmed",
  "note": "人工确认"
}
```

如果设置了 `TIKU_ACCESS_TOKEN`，需要在请求头或参数中带上同一个 token。

## 常用配置

```text
TIKU_PORT=8787
TIKU_PUBLIC_BASE_URL=http://127.0.0.1:8787
TIKU_ACCESS_TOKEN=本地访问令牌，可留空
TIKU_REQUEST_TYPE=fetch
TIKU_CACHE_ENABLED=true
TIKU_CACHE_ONLY_CONFIRMED=false
TIKU_ANSWER_MODE=direct
```

`TIKU_ANSWER_MODE=direct` 会让 handler 直接返回接口答案；`review` 会让 handler 不把答案交给 OCS，只把结果留在缓存中，适合先审题。

`AI_FORCE_ANSWER=true` 会要求模型即使不确定也返回最可能的候选答案，并用低 `confidence` 和 `needsReview=true` 标记风险。改成 `false` 后，信息不足的题可能返回空答案。

如果你想让 DeepSeek 保留 thinking，可使用：

```text
AI_THINKING=enabled
AI_JSON_MODE=true
AI_USE_REASONING_CONTENT=false
```

注意：thinking 模式会把推理写到 `reasoning_content`，最终答案写到 `content`。建议继续保持 `AI_USE_REASONING_CONTENT=false`，避免把推理过程里出现的 A/B/C 误当成最终答案。

准确率优先时建议保留：

```text
AI_ENSEMBLE_COUNT=3
AI_VERIFY_ANSWER=true
AI_CACHE_MIN_CONFIDENCE=0.7
```

这会让同一道题产生多个候选答案，再做一次复核。它会明显增加请求次数和耗时，但比单次回答更稳。低于缓存置信度阈值的答案不会写入缓存。

`TIKU_REQUEST_TYPE=fetch` 适合 OCS Desktop 和普通浏览器环境；如果你确认当前脚本管理器允许访问本机地址，也可以改成 `GM_xmlhttpRequest` 后重新生成配置。

## 连接失败排查

如果 OCS 提示“题库连接失败”，先确认：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
```

能返回 JSON 后，再重新生成配置：

```powershell
node scripts/generate-config.js
```

把 `config/ocs-answerer.txt` 里的新内容重新粘贴到 OCS。修改 `.env` 或代码后，需要关闭旧的 `node server.js`，再重新启动。

## 兼容的模型服务

只要提供 OpenAI Chat Completions 兼容接口即可，例如：

```text
https://api.openai.com/v1/chat/completions
http://127.0.0.1:11434/v1/chat/completions
```

`AI_API_BASE_URL` 可填写到 `/v1`，服务会自动拼接 `/chat/completions`。

## 本地测试

```powershell
node scripts/test-request.js
```

或者手动请求：

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/ocs/answer" `
  -ContentType "application/json" `
  -Body '{"title":"地理学的对象是什么？","type":"single","options":"A. 地理环境\nB. 地理法则"}'
```

## 准确率评测

准备一个带标准答案的数据集，例如：

```json
[
  {
    "title": "若函数 f(x)=x^2，则 f'(x)=()。",
    "type": "single",
    "options": "A. x\nB. 2x\nC. x^3\nD. 2",
    "answer": "B"
  }
]
```

保存为 `data/eval.json`，启动服务后运行：

```powershell
node scripts/evaluate-dataset.js data/eval.json
```

脚本会输出正确率，并把明细写入 `data/eval-result-*.json`。

## 注意

请只在你有授权的课程、作业批改、教学辅助或自有测试环境中使用。模型答案可能出错，关键场景建议保留人工复核。
