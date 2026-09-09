const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

class ImageService {
  constructor(imageDir, upstreamUrl, httpAgent, httpsAgent) {
    this.imageDir = imageDir;
    this.upstreamUrl = upstreamUrl;
    this.httpAgent = httpAgent;
    this.httpsAgent = httpsAgent;
    this.pendingDownloads = new Map(); // 文件名 => Promise，合并防重
  }

  serveImage(req, res) {
    const filename = path.basename(req.params.filename);
    const localPath = path.join(this.imageDir, filename);

    // 1. 本地缓存命中，直接高性能流式响应
    if (fs.existsSync(localPath)) {
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "public, max-age=604800, immutable"); // 7天缓存
      return fs.createReadStream(localPath).pipe(res);
    }

    if (!this.upstreamUrl) {
      return res.status(404).json({ error: "Upstream image service not configured" });
    }

    // 2. 多人并发读取同一张未缓存图片时，共用同一个上游下载流
    if (this.pendingDownloads.has(filename)) {
      return this.pendingDownloads
        .get(filename)
        .then(() => {
          if (fs.existsSync(localPath)) {
            res.set("Content-Type", "image/jpeg");
            res.set("Cache-Control", "public, max-age=604800, immutable");
            fs.createReadStream(localPath).pipe(res);
          } else {
            res.status(404).json({ error: "Image not found" });
          }
        })
        .catch((err) => res.status(502).json({ error: err.message }));
    }

    // 3. 向上游发起下载并流式回写客户端同时落盘
    const downloadPromise = new Promise((resolve, reject) => {
      const upstreamImgUrl = new URL(`/images/${filename}`, this.upstreamUrl);
      const isHttps = upstreamImgUrl.protocol === "https:";
      const clientLib = isHttps ? https : http;
      const chosenAgent = isHttps ? this.httpsAgent : this.httpAgent;

      const proxyReq = clientLib.get(
        upstreamImgUrl,
        { agent: chosenAgent, timeout: 30000 },
        (upstreamRes) => {
          if (upstreamRes.statusCode === 200) {
            res.writeHead(200, {
              "Content-Type": upstreamRes.headers["content-type"] || "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
            });

            const fileStream = fs.createWriteStream(localPath);
            upstreamRes.pipe(fileStream);
            upstreamRes.pipe(res);

            fileStream.on("finish", () => resolve());
            fileStream.on("error", (e) => reject(e));
          } else {
            res.status(upstreamRes.statusCode).json({ error: "Image not found on upstream" });
            reject(new Error("Image not found on upstream"));
          }
        }
      );

      proxyReq.on("error", (err) => {
        if (!res.headersSent) res.status(502).json({ error: "Failed to fetch image from upstream" });
        reject(err);
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: "Image fetch timeout" });
        reject(new Error("Timeout"));
      });
    });

    this.pendingDownloads.set(filename, downloadPromise);
    downloadPromise.finally(() => this.pendingDownloads.delete(filename));
  }
}

module.exports = ImageService;
