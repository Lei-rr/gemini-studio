const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const app = express();

// =========================================================================
// 1. 配置加载 (支持 config.json 映射与环境变量覆盖)
// =========================================================================
const CONFIG_FILE = path.join(__dirname, "config.json");
const IMAGE_DIR = path.join(__dirname, "images");
const PUBLIC_DIR = path.join(__dirname, "public");

function loadConfig() {
  let jsonConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      jsonConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (e) {
      console.warn(`[Config] 解析 config.json 失败，使用默认值: ${e.message}`);
    }
  }

  return {
    port: Number(process.env.PORT) || jsonConfig.port || 3055,
    // 自定义绑定域名 (如 https://img.mydomain.com，留空则自动从请求头动态获取)
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || jsonConfig.publicBaseUrl || "").replace(/\/+$/, ""),
    upstream: {
      url: (process.env.UPSTREAM_URL || jsonConfig.upstream?.url || "http://52.221.92.226:8045").replace(/\/+$/, ""),
      apiKey: process.env.UPSTREAM_KEY || jsonConfig.upstream?.apiKey || "zhatianbang",
      defaultModel: process.env.UPSTREAM_MODEL || jsonConfig.upstream?.defaultModel || "gemini-3.1-flash-image-4K",
    },
    security: {
      serviceApiKey: process.env.SERVICE_API_KEY || jsonConfig.security?.serviceApiKey || "",
    },
  };
}

let config = loadConfig();

// 目录准备
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// 高性能 TCP 连接池
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 100, maxFreeSockets: 20, timeout: 120000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 100, maxFreeSockets: 20, timeout: 120000 });

// 基础中间件
app.set("trust proxy", true); // 信任反代以正确获取 X-Forwarded-Proto / Host
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// 请求日志
app.use((req, res, next) => {
  if (req.url !== "/favicon.ico") {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  }
  next();
});

// 静态文件
app.use(express.static(PUBLIC_DIR));
app.get("/favicon.ico", (req, res) => res.status(204).end());

/**
 * 动态计算用户当前访问的基础域名 (支持反代与自定义域名)
 */
function getPublicBaseUrl(req) {
  if (config.publicBaseUrl) {
    return config.publicBaseUrl;
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * 将上游可能返回的原始 IP 链接重写为用户绑定的当前域名链接
 */
function rewriteToPublicImageUrl(req, upstreamImgUrl) {
  if (!upstreamImgUrl) return "";
  // 提取文件名 (如 1788963541810_5oiezk2.jpg)
  const filename = path.basename(new URL(upstreamImgUrl).pathname);
  const base = getPublicBaseUrl(req);
  return `${base}/images/${filename}`;
}

/**
 * 核心：调用上游标准 OpenAI 兼容生图服务
 */
async function callStandardUpstreamImage(req, prompt, options = {}) {
  const model = options.model || config.upstream.defaultModel;
  let fullPrompt = prompt.trim();

  if (options.negative_prompt && options.negative_prompt.trim()) {
    fullPrompt += `\n(Negative Prompt / Avoid: ${options.negative_prompt.trim()})`;
  }

  const payload = {
    model,
    messages: [{ role: "user", content: fullPrompt }],
  };

  const bodyStr = JSON.stringify(payload);
  const targetUrl = new URL("/v1/chat/completions", config.upstream.url);
  const isHttps = targetUrl.protocol === "https:";
  const clientLib = isHttps ? https : http;
  const chosenAgent = isHttps ? httpsAgent : httpAgent;

  console.log(`[生图调用] 上游: ${targetUrl.origin} | 模型: ${model} | 提示词: "${prompt.slice(0, 50)}..."`);

  return new Promise((resolve, reject) => {
    const upstreamReq = clientLib.request(
      targetUrl,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.upstream.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
        agent: chosenAgent,
        timeout: 90000,
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            const data = JSON.parse(raw);
            if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
              const content = data?.choices?.[0]?.message?.content || "";
              const match = content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
              const originalUrl = match ? match[1] : (content.startsWith("http") ? content.trim() : null);

              if (originalUrl) {
                // 重点：将上游内网或原始 IP 转换为用户当前绑定的域名直链
                const domainUrl = rewriteToPublicImageUrl(req, originalUrl);
                resolve({
                  success: true,
                  url: domainUrl,
                  originalUrl,
                  model,
                  id: data.id,
                });
              } else {
                reject(new Error(`上游未返回有效图片地址: ${content.slice(0, 150)}`));
              }
            } else {
              reject(new Error(data.error?.message || data.error || data.message || `上游 HTTP ${upstreamRes.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`解析上游响应失败: ${raw.slice(0, 150)}`));
          }
        });
      }
    );

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy();
      reject(new Error("上游响应超时 (90s)"));
    });

    upstreamReq.write(bodyStr);
    upstreamReq.end();
  });
}

/**
 * 转发/代理图片访问 (当用户通过绑定的域名访问 /images/:filename 时)
 */
app.get("/images/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const localFilePath = path.join(IMAGE_DIR, filename);

  // 1. 本地缓存命中，直接以高性能流发送
  if (fs.existsSync(localFilePath)) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    return fs.createReadStream(localFilePath).pipe(res);
  }

  // 2. 本地不存在，向上游图片服务反代并落地缓存
  const upstreamImgUrl = new URL(`/images/${filename}`, config.upstream.url);
  const isHttps = upstreamImgUrl.protocol === "https:";
  const clientLib = isHttps ? https : http;

  const proxyReq = clientLib.get(upstreamImgUrl, (upstreamRes) => {
    if (upstreamRes.statusCode === 200) {
      res.writeHead(200, {
        "Content-Type": upstreamRes.headers["content-type"] || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      });

      const fileStream = fs.createWriteStream(localFilePath);
      upstreamRes.pipe(fileStream);
      upstreamRes.pipe(res);
    } else {
      res.status(upstreamRes.statusCode).json({ error: "Image not found on upstream" });
    }
  });

  proxyReq.on("error", () => {
    res.status(502).json({ error: "Failed to fetch image from upstream" });
  });
});

// 可选的对外 API Key 中间件
const checkApiKey = (req, res, next) => {
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
// 路由列表
// =========================================================================

// 1. 首页: 现代 WebUI 绘图工作站
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// 2. 网页核心生成接口: POST /generate
app.post("/generate", checkApiKey, async (req, res) => {
  const { prompt, negative_prompt, model } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "请输入生图提示词 (prompt 必填)" });
  }

  try {
    const result = await callStandardUpstreamImage(req, prompt, {
      negative_prompt,
      model: model || config.upstream.defaultModel,
    });

    console.log(`[生成成功] 域名下载直链: ${result.url}`);

    res.json({
      success: true,
      url: result.url,
      model: result.model,
      id: result.id,
    });
  } catch (err) {
    console.error("[生成失败]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. 浏览器直出图片接口: GET /image?prompt=xxx
app.get(["/image", "/draw"], checkApiKey, async (req, res) => {
  const prompt = req.query.prompt;
  if (!prompt) {
    return res.status(400).json({ error: "Missing 'prompt' query parameter" });
  }

  try {
    const result = await callStandardUpstreamImage(req, prompt, {
      model: req.query.model || config.upstream.defaultModel,
    });

    if (req.query.format === "json") {
      return res.json(result);
    }

    // 默认 302 重定向到绑定域名的图片直链
    res.redirect(result.url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. 标准 SD WebUI txt2img 兼容接口: POST /sdapi/v1/txt2img
app.post("/sdapi/v1/txt2img", checkApiKey, async (req, res) => {
  const { prompt, negative_prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const result = await callStandardUpstreamImage(req, prompt, { negative_prompt });
    res.json({
      images: [result.url],
      parameters: req.body,
      info: JSON.stringify({ prompt, url: result.url, model: result.model }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. OpenAI 格式兼容接口: POST /v1/images/generations
app.post(["/v1/images/generations", "/images/generations"], checkApiKey, async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: { message: "Missing required parameter 'prompt'" } });
  }

  try {
    const result = await callStandardUpstreamImage(req, prompt, { model });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: result.url }],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 6. 模型列表接口: GET /v1/models
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "gemini-3.1-flash-image-4K", object: "model", description: "4K 旗舰超高画质生图模型 (默认)" },
      { id: "gemini-3.1-flash-image-2K", object: "model", description: "2K 高清画质生图模型" },
      { id: "gemini-3.1-flash-image", object: "model", description: "1K 标准快速生图模型" },
    ],
  });
});

// 7. 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    upstream: config.upstream.url,
    model: config.upstream.defaultModel,
    uptime: process.uptime(),
  });
});

// 启动服务
app.listen(config.port, "0.0.0.0", () => {
  console.log(`=================================================`);
  console.log(`🚀 [gemini-img] 运行在: http://0.0.0.0:${config.port}`);
  console.log(`🔗 映射上游 : ${config.upstream.url}`);
  console.log(`🔑 上游密钥 : ${config.upstream.apiKey}`);
  console.log(`🎨 默认模型 : ${config.upstream.defaultModel}`);
  console.log(`🌐 动态域名 : ${config.publicBaseUrl || "(自适应客户端 Host/Domain)"}`);
  console.log(`=================================================`);
});
