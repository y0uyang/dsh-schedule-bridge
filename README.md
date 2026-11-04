# dsh-schedule-bridge

将 DSH 定时提醒（schedule）转发到 IM 渠道（微信、飞书等）。

## 功能

- **自动转发**：监测 `schedule.json` 的新投递，自动转发到指定 IM 机器人。
- **失败重试**：微信会话过期时自动重试（最多 3 次）。
- **防重复**：基线登记机制，避免旧提醒重复转发。
- **一键安装**：通过 DSH 插件市场或 GitHub 一键安装。

## 安装

### 方式一：DSH 插件市场（推荐）

1. 打开 DSH 桌面端 → 设置 → 插件
2. 点击「添加插件」
3. 输入：`github:y0uyang/dsh-schedule-bridge`
4. 点击「安装」

### 方式二：命令行

```bash
npx -y github:y0uyang/dsh-schedule-bridge install
```

## 配置

安装后编辑 `config.json`（插件目录下的配置文件），填入：

- `botId`：从 DSH IM 机器人设置页复制（如 `wx_e25daae0b3bc790ca828b3e2`）
- `targetId`：从 DSH IM 机器人设置页复制（如 `tgt_eb31391bb49f9e12`）

这两个值在 DSH 的「IM 机器人 → 复制调用参数」中可以找到。

## 用法

| 命令 | 说明 |
|------|------|
| `node bridge.js` | 持续运行（后台守护） |
| `node bridge.js --once` | 只轮询一次（调试用） |
| `node bridge.js --test` | 发送测试消息验证链路 |
| `node bridge.js --port 51677` | 覆盖 DSH 端口 |
| `node bridge.js --reset` | 清空转发状态（慎用） |

## 原理

1. DSH 的 schedule 提醒每次投递都会写入 `~/.dsh/storages/schedule.json` 的 `lastDelivery`。
2. 本插件轮询该文件，发现新的投递后调用 `@xmanrui/dsh-im` 插件的主动投递 HTTP 接口，把提醒推送到配置的 IM 机器人。

## 要求

- Node.js >= 18.0.0
- 已安装并配置好 `@xmanrui/dsh-im` 插件
- DSH 桌面端正在运行

## 许可证

MIT
