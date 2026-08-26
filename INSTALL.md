# 下载与安装

Daymate 以预编译的 **universal** 安装包分发：同一个 `.dmg` 同时支持
Apple Silicon（M 系列）和 Intel Mac。仅支持 macOS。

## 1. 下载

从 [GitHub Releases](https://github.com/Zhaozed/DayMate/releases) 下载最新的
`Daymate-<版本>-universal.dmg`。

## 2. 安装

1. 双击打开 `.dmg`，把 **Daymate** 拖进「应用程序」文件夹。
2. **首次打开需要绕过 Gatekeeper**——应用目前**未签名/未公证**
   （签名需要付费的 Apple Developer ID，见下方「已知限制」）：

   方式一（推荐，终端一行命令）：

   ```bash
   xattr -cr /Applications/Daymate.app
   ```

   方式二（图形界面）：

   - macOS Ventura 及以下：在「应用程序」里 **右键点击 Daymate → 打开**，
     在弹窗中再点「打开」。
   - macOS Sequoia 及以上：右键打开已不可用，请到
     **系统设置 → 隐私与安全性**，页面底部会出现「已阻止 Daymate」，
     点击 **仍要打开**。

3. 之后正常从启动台或应用程序文件夹打开即可。

> 如果 macOS 提示「已损坏，无法打开」，就是 Gatekeeper 隔离属性导致的，
> 用上面的 `xattr -cr` 命令即可解决。

## 3. 首次配置（凭证全部自备、本地加密存储）

Daymate 不分发任何密钥，也不依赖任何账号体系。打开应用后进入
**集成与设置** 页面按需配置：

| 集成 | 需要准备什么 | 说明 |
|---|---|---|
| **智能助手 LLM** | Anthropic / OpenAI / DeepSeek 任一 API 密钥 | 密钥加密存储（safeStorage）且**只写不回显**。不填也能用：智能步骤退化为确定性桩，邮件分类/必读等核心流程照常 |
| **Gmail** | 你自己的 Google OAuth 客户端（client_id + client_secret） | 见下方 [Gmail OAuth 客户端创建步骤](#gmail-oauth-客户端创建步骤) |
| **163 邮箱** | 163 邮箱的 IMAP/SMTP **授权码**（不是登录密码） | 在网页版 163 邮箱「设置 → POP3/SMTP/IMAP」里开启并获取 |
| **天气城市** | 城市名（可选） | 首页今日天气卡片用 |

所有凭证只存本机（Keychain / safeStorage 加密 / 本地 SQLite），
绝不上传，也绝不暴露给渲染进程。

### Gmail OAuth 客户端创建步骤

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，
   新建（或选择）一个项目。
2. 「API 和服务 → 库」中启用 **Gmail API**。
3. 「API 和服务 → OAuth 同意屏幕」：用户类型选 **外部**，
   填写应用名称，把自己加为**测试用户**即可（个人使用无需发布）。
4. 「API 和服务 → 凭据 → 创建凭据 → **OAuth 客户端 ID**」：
   应用类型选 **桌面应用**（Desktop app），创建后复制
   client_id 和 client_secret。
5. 回到 Daymate「集成与设置」填入 client_id/secret，点击连接，
   浏览器会弹出 Google 授权页（走本机 loopback 回调，无需公网地址）。

> 注意：OAuth 同意屏幕处于「测试」模式时，授权令牌 7 天后过期，
> 届时重新点一次连接即可（refresh token 已存 Keychain，通常会自动续期）。

## 4. 数据与隐私

- 邮件、任务、投递、记忆全部存本地 SQLite；邮件令牌存 Keychain。
- 没有云同步、没有账号、没有遥测。
- 所有对外写操作（发邮件、建草稿等）遵循审批闸：草稿自动进你自己的
  草稿箱（R1 例外），**实际发送必须你手动确认**（R3 预览 + 审批）。

## 已知限制

- **仅 macOS**（Windows/Linux 不在当前范围内）。
- **未签名**：首次打开需按上文绕过 Gatekeeper；正式签名 + 公证需要
  付费 Apple Developer ID，是后续里程碑。
- 飞书日历为骨架，填入飞书应用凭证后才会激活。

## 从源码运行（开发者）

见 [README → Local setup](./README.md#local-setup)。
