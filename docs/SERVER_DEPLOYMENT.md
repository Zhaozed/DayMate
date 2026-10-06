# Daymate 服务端部署与客户端连接指南

本文档指导如何将 Daymate 服务端部署至阿里云 Linux ECS，并配置 Mac 桌面客户端远程连接。

---

## 架构说明

* **云端守护进程 (`src/server`)**：常驻运行在阿里云 Linux 服务器上，负责 24 小时自动轮询 Gmail / 163 邮箱、执行大模型 Agent、调度例程，并将数据保存在云端 SQLite 数据库。
* **本地桌面端 (`src/renderer` + `src/main`)**：Mac 桌面常驻的悬浮挂件与工作台界面，通过 WebSocket 实时接收云端推送并展示数据，调用接口操作云端。

---

## 第一部分：阿里云服务器部署

### 1. 安装基础依赖
在服务器上安装 Node.js (≥ 20) 和 pnpm：
```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3

# 安装 pnpm
npm install -g pnpm
```

### 2. 上传代码与构建
将代码克隆或上传到服务器（例如 `/opt/daymate`）：
```bash
cd /opt/daymate
pnpm install
pnpm rebuild:node
pnpm server:build
```
> `rebuild:node` 会将 SQLite 底层 C++ 扩展编译为服务器当前 Node.js 的本地二进制。
> `server:build` 会使用 esbuild 将纯服务端代码打包至 `out/server/index.js`。

### 3. 配置环境变量
在 `/opt/daymate/.env` 配置服务参数：
```bash
cp .env.server.example .env
vim .env
```
配置示例：
```ini
PORT=3210
HOST=0.0.0.0
DAYMATE_SERVER_TOKEN=your-random-token-here   # 桌面客户端连接所需的通信密钥
DAYMATE_SECRET_KEY=your-32-char-secret-key    # 用于云端 AES-256 加密敏感凭据
DAYMATE_DATA_DIR=/var/lib/daymate             # 数据库与凭据持久化目录

# 国内服务器直连 Google 会超时，必须配置服务器本地代理（如 Clash 监听在 7890 端口）：
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
```

### 4. 国内 ECS 代理配置说明（针对 Gmail 轮询）
* 在阿里云国内 ECS 上，安装运行轻量代理客户端（如 Clash / Xray / Sing-box），配置好境外节点订阅，并开启本地 HTTP 代理端口 `127.0.0.1:7890`。
* Daymate 服务端内置了 ProxyAgent 智能路由，**只有请求 Google API 时走代理，163 邮箱与天气等国内流量自动直连**。
* *(注：如果服务器是中国香港、新加坡等海外地域，则无需配置任何代理)*。

### 5. 使用 Systemd 启动守护进程
```bash
sudo cp scripts/daymate-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daymate-server

# 查看运行状态与日志
sudo systemctl status daymate-server
sudo journalctl -u daymate-server -f
```

---

## 第二部分：桌面客户端连接远程服务器

### 1. 配置桌面端连接地址
在你的本地 Mac 电脑上，进入 Daymate 目录，在 `.env` 中加入：
```ini
DAYMATE_SERVER_URL=http://<你的服务器IP或Tailscale内网IP>:3210
DAYMATE_SERVER_TOKEN=your-random-token-here
```
> **安全免备案推荐（Tailscale 虚拟组网）**：
> 强烈推荐在阿里云服务器与 Mac 上安装 Tailscale，直接使用 Tailscale 内网 IP（如 `http://100.x.y.z:3210`），**服务器对外防火墙端口完全无需开放**，既免去 ICP 备案困扰，又免受公网扫描攻击。

### 2. 启动桌面端
```bash
pnpm dev
# 或打包生产版本安装：pnpm dist
```
桌面端启动时会检测到 `DAYMATE_SERVER_URL`，自动连接云端服务器，控制台输出：
```
[bootstrap] Operating in REMOTE mode. Target server: http://...
[remote-client] Connected to remote Daymate server: http://...
```

### 3. 连接与同步 Gmail（免公网域名/免备案流程）
1. 在桌面端打开「集成与设置」页面，填入 Google OAuth Client ID 与 Client Secret。
2. 点击「连接 Gmail」，桌面端会在本地 Mac 唤起浏览器完成 Google 登录授权。
3. 授权完成后，桌面端自动将获得的凭据同步推送到云端服务器。
4. 云端服务器接管并持久化保存凭证，以后每隔几分钟在云端后台自动拉取 Gmail 新邮件，即使你的 Mac 关机，云端轮询也不会中断！
