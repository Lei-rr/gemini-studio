const http = require("http");
const https = require("https");
const { URL } = require("url");
const path = require("path");

class UpstreamClient {
  constructor(config, queue) {
    this.config = config;
    this.queue = queue;

    // 高性能长连接连接池
    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 200,
      maxFreeSockets: 50,
      timeout: 120000,
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 200,
      maxFreeSockets: 50,
      timeout: 120000,
    });
  }

  /**
   * 动态推导请求方的公网访问根地址
   */
  resolveBaseUrl(req) {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl;
    }
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${proto}://${host}`;
  }

  /**
   * 将上游原始图片链接改写为当前服务域名的直链
   */
  rewriteImageUrl(req, upstreamUrl) {
    if (!upstreamUrl) return "";
    try {
      const filename = path.basename(new URL(upstreamUrl).pathname);
      const base = this.resolveBaseUrl(req);
      return `${base}/images/${filename}`;
    } catch {
      return upstreamUrl;
    }
  }

  /**
   * 调用上游模型生成图像 (包含画幅比例注入、并发控制与客户端断开感知)
   */
  async generateImage(req, prompt, options = {}) {
    if (!this.config.upstream.url) {
      throw new Error("服务端尚未配置上游接口地址 (upstream.url 未配置，请检查 config.json 或环境变量)");
    }

    const model = options.model || this.config.upstream.defaultModel;
    let fullPrompt = prompt.trim();

    // 1. 画幅比例精准注入 (Gemini Imagen 3/3.1 识别 aspect ratio 提示)
    const aspectRatio = options.aspect_ratio || options.aspectRatio;
    const width = Number(options.width);
    const height = Number(options.height);

    let ratioStr = "";
    if (aspectRatio) {
      ratioStr = aspectRatio;
    } else if (width && height) {
      const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
      const g = gcd(width, height);
      ratioStr = `${width / g}:${height / g}`;
      // 常见比例归一化
      if (Math.abs(width / height - 16 / 9) < 0.05) ratioStr = "16:9";
      else if (Math.abs(width / height - 9 / 16) < 0.05) ratioStr = "9:16";
      else if (Math.abs(width / height - 4 / 3) < 0.05) ratioStr = "4:3";
      else if (Math.abs(width / height - 3 / 4) < 0.05) ratioStr = "3:4";
      else if (Math.abs(width / height - 1) < 0.05) ratioStr = "1:1";
    }

    if (ratioStr) {
      fullPrompt += ` --ar ${ratioStr} (aspect ratio: ${ratioStr})`;
    }

    // 2. 负向提示词
    if (options.negative_prompt && options.negative_prompt.trim()) {
      fullPrompt += `\n(Negative Prompt / Avoid: ${options.negative_prompt.trim()})`;
    }

    const payload = {
      model,
      messages: [{ role: "user", content: fullPrompt }],
    };
    const bodyStr = JSON.stringify(payload);

    const targetUrl = new URL("/v1/chat/completions", this.config.upstream.url);
    const isHttps = targetUrl.protocol === "https:";
    const clientLib = isHttps ? https : http;
    const chosenAgent = isHttps ? this.httpsAgent : this.httpAgent;

    // 1. 获取并发队列令牌
    const releaseLock = await this.queue.acquire();

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (!settled) {
          settled = true;
          releaseLock();
        }
      };

      console.log(`[生图] 并发: ${this.queue.stats.activeWorkers}/${this.queue.maxConcurrent} (排队: ${this.queue.stats.waitingCount}) | 模型: ${model} | 提示词: "${prompt.slice(0, 35)}..."`);

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      };
      if (this.config.upstream.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.upstream.apiKey}`;
      }

      const upstreamReq = clientLib.request(
        targetUrl,
        {
          method: "POST",
          headers,
          agent: chosenAgent,
          timeout: this.config.requestTimeoutMs,
        },
        (upstreamRes) => {
          const chunks = [];
          upstreamRes.on("data", (c) => chunks.push(c));
          upstreamRes.on("end", () => {
            cleanup();
            const raw = Buffer.concat(chunks).toString("utf-8");
            try {
              const data = JSON.parse(raw);
              if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
                const content = data?.choices?.[0]?.message?.content || "";
                const match = content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
                const originalUrl = match ? match[1] : (content.startsWith("http") ? content.trim() : null);

                if (originalUrl) {
                  const localUrl = this.rewriteImageUrl(req, originalUrl);
                  resolve({
                    success: true,
                    url: localUrl,
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
            } catch {
              reject(new Error(`解析上游响应数据异常: ${raw.slice(0, 150)}`));
            }
          });
        }
      );

      // 客户端断开监听：及时取消上游请求，释放宝贵的并发令牌
      req.on("close", () => {
        if (!settled) {
          console.log(`[取消] 客户端连接关闭，终止上游请求并释放并发`);
          upstreamReq.destroy();
          cleanup();
          reject(new Error("客户端已断开"));
        }
      });

      upstreamReq.on("error", (err) => {
        cleanup();
        reject(err);
      });

      upstreamReq.on("timeout", () => {
        upstreamReq.destroy();
        cleanup();
        reject(new Error(`上游响应超时 (${this.config.requestTimeoutMs / 1000}s)`));
      });

      upstreamReq.write(bodyStr);
      upstreamReq.end();
    });
  }
}

module.exports = UpstreamClient;
