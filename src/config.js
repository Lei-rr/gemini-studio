const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(process.cwd(), "config.json");

function loadConfig() {
  let jsonConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      jsonConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (e) {
      console.warn(`[Config] 解析 config.json 失败: ${e.message}`);
    }
  }

  const upstreamUrl = (process.env.UPSTREAM_URL || jsonConfig.upstream?.url || "").replace(/\/+$/, "");
  const upstreamKey = process.env.UPSTREAM_KEY || jsonConfig.upstream?.apiKey || "";

  return {
    port: Number(process.env.PORT) || jsonConfig.port || 3055,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || jsonConfig.publicBaseUrl || "").replace(/\/+$/, ""),
    maxConcurrent: Number(process.env.MAX_CONCURRENT) || jsonConfig.maxConcurrent || 10,
    maxQueueLength: Number(process.env.MAX_QUEUE) || jsonConfig.maxQueueLength || 100,
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT) || jsonConfig.requestTimeoutMs || 180000,
    upstream: {
      url: upstreamUrl,
      apiKey: upstreamKey,
      defaultModel: process.env.UPSTREAM_MODEL || jsonConfig.upstream?.defaultModel || "gemini-3.1-flash-image",
    },
    security: {
      serviceApiKey: process.env.SERVICE_API_KEY || jsonConfig.security?.serviceApiKey || "",
    },
  };
}

module.exports = {
  loadConfig,
  CONFIG_FILE,
};
