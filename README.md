# gemini-img

🚀 基于 Node.js + Express 构建的高性能 AI 图像生成网关与现代化工作站。
原生对接 Gemini 4K 生图模型（`gemini-3.1-flash-image-4K`），完美兼容 OpenAI DALL-E 与 Stable Diffusion WebUI API 规范。

---

## ✨ 核心特性

- 🎨 **极美现代化前端 UI**：基于 Tailwind CSS CDN 构建的深色玻璃拟态工作台，支持提示词灵感预设、画幅比例切换、实时计时与本地历史记录。
- 🖼️ **动态域名直出**：无论绑定任何域名或经过反代，图片下载与预览直链自动转换为用户绑定的公网域名，上游内网 IP 100% 隐藏保护。
- 💎 **Gemini 4K 旗舰直连**：对接 `gemini-3.1-flash-image-4K`、`gemini-3.1-flash-image-2K`、`gemini-3.1-flash-image`。
- 🔌 **多格式 API 兼容**：
  - 标准 OpenAI 格式：`POST /v1/images/generations`（可无缝接入 NextChat / LobeChat / OneAPI / New-API）
  - 标准 SD WebUI 格式：`POST /sdapi/v1/txt2img`
  - 极简网页出图：`GET /image?prompt=cat`（浏览器直接回车出图）
- ⚙️ **配置解耦**：上游地址、密钥、模型全部存放于 `config.json`，Docker 挂载即改即生效。

---

## 🛠️ 快速部署 (Docker Compose)

### 1. 准备配置
在部署目录创建 `config.json`：
```json
{
  "port": 3055,
  "publicBaseUrl": "",
  "upstream": {
    "url": "http://你的上游IP:8045",
    "apiKey": "你的API密钥",
    "defaultModel": "gemini-3.1-flash-image-4K"
  },
  "security": {
    "serviceApiKey": ""
  }
}
```
*注：`publicBaseUrl` 留空时会自动根据访问者的域名/Host动态匹配；填入如 `https://img.yourdomain.com` 则强制全局生效。*

### 2. 启动服务
```yaml
version: '3.8'

services:
  gemini-img:
    image: ghcr.io/lei-rr/gemini-img:latest
    container_name: gemini-img
    restart: always
    ports:
      - "3055:3055"
    volumes:
      - ./config.json:/app/config.json
      - ./images:/app/images
```

```bash
docker compose up -d
```

---

## 📡 API 调用示例

### 1. 浏览器直接出图
```http
GET http://your-domain:3055/image?prompt=a+cute+cyberpunk+cat
```

### 2. OpenAI 标准格式
```bash
curl -X POST http://your-domain:3055/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a magical crystal tree in neon forest",
    "model": "gemini-3.1-flash-image-4K",
    "response_format": "url"
  }'
```

### 3. SD WebUI 格式
```bash
curl -X POST http://your-domain:3055/sdapi/v1/txt2img \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "masterpiece, best quality, a red sports car",
    "negative_prompt": "lowres, bad anatomy"
  }'
```

---

## 📄 License
MIT License.
