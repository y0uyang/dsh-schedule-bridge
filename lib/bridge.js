#!/usr/bin/env node
/**
 * dsh-schedule-bridge — 把 DSH 定时提醒（schedule）转发到 IM 渠道（微信、飞书等）。
 *
 * 原理：
 *   1. DSH 的 schedule 提醒每次投递都会写入 ~/.dsh/storages/schedule.json 的 lastDelivery。
 *   2. 本脚本轮询该文件，发现新的投递记录后，调用 @xmanrui/dsh-im 插件
 *      的主动投递 HTTP 接口 POST /api/dsh-im/delivery/messages，
 *      把提醒文本推送到已配置的 botId + targetId（例如微信私聊）。
 *
 * 无第三方依赖，需要 Node.js 18+（内置 fetch）。
 *
 * 用法：
 *   node bridge.js             持续运行（daemon）
 *   node bridge.js --once      只轮询一次（调试）
 *   node bridge.js --test      发送一条测试消息到目标（验证链路）
 *   node bridge.js --port 51677  覆盖宿主机端口
 *   node bridge.js --reset     清空转发状态（下次将重新处理全部现存提醒，慎用）
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const STATE_PATH = path.join(__dirname, '..', 'state.json')
const LOG_PATH = path.join(__dirname, '..', 'logs', 'bridge.log')

const argv = process.argv.slice(2)
const FLAG = (name) => argv.includes(name)
const FLAG_VALUE = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------- 日志 ----------

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  const out = level === 'error' ? process.stderr : process.stdout
  out.write(line + '\n')
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, line + '\n')
    const st = statSync(LOG_PATH)
    if (st.size > 2 * 1024 * 1024) {
      const data = readFileSync(LOG_PATH, 'utf8')
      writeFileSync(LOG_PATH, data.slice(-512 * 1024))
    }
  } catch { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 配置与状态 ----------

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
if (FLAG_VALUE('--port')) config.port = Number(FLAG_VALUE('--port'))
// 展开 ~ 路径
if (typeof config.schedulePath === 'string' && config.schedulePath.startsWith('~')) {
  config.schedulePath = path.join(process.env.HOME || '', config.schedulePath.slice(1))
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { firstRun: true, tasks: {} }
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

// ---------- DSH 宿主端口发现 ----------

const portCache = { port: null, at: 0 }

function hostPids() {
  // 支持多种 DSH 进程名（原生桌面端 + Electron 版）
  const procs = [
    'dsh-desktop-host/lib/index.js',
    'deepseek-harness',
    'DeepSeek Harness',
  ]
  for (const p of procs) {
    const r = spawnSync('pgrep', ['-f', p], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim().split('\n').filter(Boolean)
    }
  }
  return []
}

function listeningPorts(pid) {
  const r = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-p', pid], { encoding: 'utf8' })
  const ports = new Set()
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/:(\d+)\s+\(LISTEN\)/)
    if (m) ports.add(Number(m[1]))
  }
  return [...ports]
}

async function probeDeliveryRoute(port) {
  try {
    const res = await fetch(`http://${config.host}:${port}/api/dsh-im/delivery/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: '__probe__', targetId: '__probe__', text: 'x' }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.text()
    return body.includes('"error"') && body.includes('"code"')
  } catch {
    return false
  }
}

async function resolvePort() {
  const now = Date.now()
  if (config.port > 0) return config.port
  if (portCache.port && now - portCache.at < config.portCacheMs) return portCache.port
  for (const pid of hostPids()) {
    for (const port of listeningPorts(pid)) {
      if (await probeDeliveryRoute(port)) {
        portCache.port = port
        portCache.at = now
        log('info', `发现 DSH 宿主投递端口: ${port} (pid ${pid})`)
        return port
      }
    }
  }
  return null
}

// ---------- 投递 ----------

async function deliverOnce(port, text) {
  const res = await fetch(`http://${config.host}:${port}/api/dsh-im/delivery/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId: config.botId, targetId: config.targetId, text, format: 'plain' }),
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.text()
  let json = null
  try { json = JSON.parse(body) } catch { /* 非 JSON */ }
  if (res.ok && json?.sent === true) return { ok: true }
  const detail = json?.error
    ? `${json.error.code}: ${json.error.message}${json.error.details ? ' ' + JSON.stringify(json.error.details) : ''}`
    : `HTTP ${res.status} ${body.slice(0, 200)}`
  return { ok: false, detail }
}

async function deliverWithRetry(text) {
  let result = { ok: false, detail: '未尝试' }
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.retryDelaysMs[attempt - 1] ?? 30000
      log('warn', `第 ${attempt} 次重试（${delay}ms 后），上次: ${result.detail}`)
      await sleep(delay)
    }
    let port = null
    try {
      port = await resolvePort()
    } catch (e) {
      result = { ok: false, detail: `端口发现异常: ${e.message}` }
      continue
    }
    if (!port) {
      result = { ok: false, detail: '未找到 DSH 宿主投递端口（DSH 桌面端未运行？）' }
      continue
    }
    try {
      result = await deliverOnce(port, text)
    } catch (e) {
      result = { ok: false, detail: `请求异常: ${e.message}` }
    }
    if (result.ok) break
  }
  return result
}

// ---------- 主循环 ----------

function readSchedules() {
  let raw
  try {
    raw = readFileSync(config.schedulePath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function pollOnce(state) {
  const data = readSchedules()
  if (!data) return
  const tasks = data?.tables?.tasks ?? {}

  for (const [taskId, task] of Object.entries(tasks)) {
    const ld = task?.lastDelivery
    if (!ld?.messageId) continue

    const seen = state.tasks[taskId]
    if (seen && seen.messageId === ld.messageId) {
      if (seen.success === false && seen.failCount < config.maxRetries + 1 && !seen.gaveUp) {
        log('info', `重试之前失败的提醒 "${task?.record?.title ?? taskId}" (failCount=${seen.failCount + 1})`)
      } else {
        continue
      }
    }

    if (state.firstRun) {
      state.tasks[taskId] = {
        messageId: ld.messageId,
        scheduledAt: ld.scheduledAt,
        note: 'first-run baseline',
      }
      continue
    }

    const title = task?.record?.title ?? '定时提醒'
    const prompt = task?.record?.prompt ?? ''
    const text = `${config.prefix}\n\n${prompt}`
    log('info', `发现新提醒 "${title}" (task ${taskId})，开始转发…`)

    const result = await deliverWithRetry(text)
    const failCount = result.ok ? 0 : ((seen?.failCount ?? 0) + 1)
    state.tasks[taskId] = {
      messageId: ld.messageId,
      scheduledAt: ld.scheduledAt,
      forwardedAt: new Date().toISOString(),
      success: result.ok,
      failCount,
      ...(failCount > config.maxRetries ? { gaveUp: true } : {}),
      ...(result.ok ? {} : { lastError: result.detail }),
    }
    saveState(state)
    if (result.ok) {
      log('info', `已转发到 ${config.targetId}: "${title}"`)
    } else {
      log('error', `转发失败 "${title}": ${result.detail}`)
    }
  }
}

async function main() {
  if (FLAG('--reset')) {
    rmSync(STATE_PATH, { force: true })
    log('warn', 'state.json 已清空；下次运行将把现存提醒登记为基线（不会补发）。')
  }

  if (FLAG('--test')) {
    const port = await resolvePort()
    if (!port) {
      log('error', '未找到 DSH 宿主投递端口。')
      process.exit(1)
    }
    const result = await deliverOnce(port, '🌉 dsh-schedule-bridge 链路测试：如果你在 IM 里看到这条消息，转发链路就是通的。')
    if (result.ok) {
      log('info', '测试消息已发送。')
    } else {
      log('error', `测试失败: ${result.detail}`)
      process.exit(1)
    }
    return
  }

  // 检查必要配置
  if (!config.botId || !config.targetId) {
    log('error', '配置文件中缺少 botId 或 targetId。请从 DSH IM 机器人设置页复制并填入 config.json。')
    process.exit(1)
  }

  log('info', `dsh-schedule-bridge 启动 (botId=${config.botId}, targetId=${config.targetId}, poll=${config.pollMs}ms)`)

  let state = loadState()
  if (FLAG('--once')) {
    await pollOnce(state)
    saveState(state)
    return
  }

  if (state.firstRun) {
    await pollOnce(state)
    state.firstRun = false
    saveState(state)
    log('info', '基线登记完成，后续新提醒将被转发。')
  }

  for (;;) {
    try {
      await pollOnce(state)
    } catch (e) {
      log('error', `轮询异常: ${e.message}`)
    }
    await sleep(config.pollMs)
  }
}

main().catch((e) => {
  log('error', `致命错误: ${e.stack ?? e.message}`)
  process.exit(1)
})
