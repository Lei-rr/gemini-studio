FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package.json ./
RUN npm install --production --no-audit --no-fund

# 拷贝代码与静态文件
COPY server.js config.example.json ./
COPY src/ ./src/
COPY public/ ./public/

# 创建图片存储与数据目录
RUN mkdir -p /app/images

# 端口与环境变量
ENV PORT=3055 \
    NODE_ENV=production

EXPOSE 3055

CMD ["node", "server.js"]
