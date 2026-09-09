const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3055;
const prompt = process.argv[2] || "a futuristic sports car in cyber city, 4k resolution";

console.log(`[Test] 发送生图请求: "${prompt}" -> http://127.0.0.1:${PORT}/generate`);
const start = Date.now();

const req = http.request(
  `http://127.0.0.1:${PORT}/generate`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: 90000,
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      try {
        const data = JSON.parse(raw);
        if (data.success && data.url) {
          console.log(`✅ 生图成功！耗时: ${elapsed}s`);
          console.log(`🌐 图片直链: ${data.url}`);
          console.log(`🎨 使用模型: ${data.model}`);
        } else {
          console.log(`❌ 响应错误:`, data);
        }
      } catch (e) {
        console.log(`❌ 响应解析失败: ${raw.slice(0, 300)}`);
      }
    });
  }
);

req.on("error", (e) => console.log(`❌ 请求异常: ${e.message}`));
req.write(JSON.stringify({ prompt, model: "gemini-3.1-flash-image-4K" }));
req.end();
