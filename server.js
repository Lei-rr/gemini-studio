const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const { loadConfig } = require("./src/config");
const ConcurrencyQueue = require("./src/queue");
const UpstreamClient = require("./src/upstream");
const ImageService = require("./src/imageService");

// 1. 初始化配置与全局组件
const config = loadConfig();
const queue = new ConcurrencyQueue(config.maxConcurrent, config.maxQueueLength);
const upstreamClient = new UpstreamClient(config, queue);

const IMAGE_DIR = path.join(__dirname, "images");
const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const imageService = new ImageService(
  IMAGE_DIR,
  config.upstream.url,
  upstreamClient.httpAgent,
  upstreamClient.httpsAgent
);

const app = express();

// 2. 核心中间件
app.set("trust proxy", true); // 信任反代获取客户端真实 IP & Host & Proto
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// 简明访问日志 (过滤探活请求)
app.use((req, res, next) => {
  if (req.url !== "/favicon.ico" && req.url !== "/health") {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  }
  next();
});

// 静态前端站点
app.use(express.static(PUBLIC_DIR));
app.get("/favicon.ico", (req, res) => res.status(204).end());

// 鉴权中间件 (如果配置了 serviceApiKey)
const authGuard = (req, res, next) => {
  const requiredKey = config.security.serviceApiKey;
  if (!requiredKey) return next();
  const authHeader = req.headers.authorization || req.headers["x-api-key"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== requiredKey && token !== `sk-${requiredKey}`) {
    return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
  }
  next();
};

// =========================================================================
// 3. 路由设计
// =========================================================================

// WebUI 首页
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// 2. 核心生图接口 (WebUI 使用)
app.post("/generate", authGuard, async (req, res) => {
  const { prompt, negative_prompt, model } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "请输入提示词 (prompt 必填)" });
  }

  try {
    const result = await upstreamClient.generateImage(req, prompt, {
      negative_prompt,
      model,
    });
    res.json({
      success: true,
      url: result.url,
      model: result.model,
      id: result.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 极简浏览器直出接口 GET /image?prompt=xxx
app.get(["/image", "/draw"], authGuard, async (req, res) => {
  const prompt = req.query.prompt;
  if (!prompt) {
    return res.status(400).json({ error: "Missing 'prompt' query parameter" });
  }

  try {
    const result = await upstreamClient.generateImage(req, prompt, {
      model: req.query.model,
    });
    if (req.query.format === "json") {
      return res.json(result);
    }
    res.redirect(result.url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. OpenAI DALL-E / 兼容格式接口 POST /v1/images/generations
app.post(["/v1/images/generations", "/images/generations"], authGuard, async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: { message: "Missing required parameter 'prompt'" } });
  }

  try {
    const result = await upstreamClient.generateImage(req, prompt, { model });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: result.url }],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 动态反代与本地加速图片路由
app.get("/images/:filename", (req, res) => {
  imageService.serveImage(req, res);
});

// 模型列表
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "gemini-3.1-flash-image-4K", object: "model", description: "4K 旗舰超清画质 (默认)" },
      { id: "gemini-3.1-flash-image-2K", object: "model", description: "2K 高清画质" },
      { id: "gemini-3.1-flash-image", object: "model", description: "1K 标准画质" },
    ],
  });
});

// 健康探活与运行负载
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    queue: queue.stats,
    configured: Boolean(config.upstream.url),
    uptime: process.uptime(),
  });
});

// 启动服务
app.listen(config.port, "0.0.0.0", () => {
  console.log(`=================================================`);
  console.log(`🚀 [gemini-img] 在线生图服务运行于: http://0.0.0.0:${config.port}`);
  console.log(`🔗 映射上游 : ${config.upstream.url || "(待通过 config.json 或环境变量配置)"}`);
  console.log(`🎨 默认模型 : ${config.upstream.defaultModel}`);
  console.log(`👥 最大并发 : ${config.maxConcurrent} | 最大排队: ${config.maxQueueLength}`);
  console.log(`🌐 直链域名 : ${config.publicBaseUrl || "(自适应客户端 Host/Domain)"}`);
  console.log(`=================================================`);
});
