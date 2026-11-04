#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { join, homedir, tmpdir } from 'node:path'

const PLUGIN_NAME = 'dsh-schedule-bridge'

function usage() {
  console.log(`Usage:
  dsh-schedule-bridge install [--profile web] [--source <package-spec>]
  dsh-schedule-bridge uninstall [--profile web]

Examples:
  npx -y github:y0uyang/dsh-schedule-bridge install
  dsh-schedule-bridge install --source .`);
}

function runDsh(args) {
  // 尝试多种 dsh 命令路径
  const candidates = ['dsh', '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/cli.mjs']
  let cmd = null
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 3000 })
    if (r.status === 0) { cmd = c; break }
  }
  if (!cmd) {
    // 尝试用 npx
    const r = spawnSync('npx', ['dsh', '--version'], { encoding: 'utf8', timeout: 15000 })
    if (r.status === 0) cmd = 'npx'
  }
  if (!cmd) {
    console.error('找不到 dsh，请先安装 DeepSeek Harness 并确保 dsh 在 PATH 中。')
    process.exit(1)
  }
  const result = spawnSync(cmd, args, { cwd: tmpdir(), stdio: 'inherit', shell: cmd === 'npx' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`dsh 退出，状态码 ${result.status ?? 1}`)
  return result
}

function run(args) {
  const command = args.shift()
  if (!command || command === '--help' || command === '-h') {
    usage()
    process.exit(0)
  }

  let profile = 'web'
  const pIdx = args.indexOf('--profile')
  if (pIdx >= 0) { profile = args[pIdx + 1]; args.splice(pIdx, 2) }

  if (command === 'install') {
    let source = 'github:y0uyang/dsh-schedule-bridge'
    const sIdx = args.indexOf('--source')
    if (sIdx >= 0) { source = args[sIdx + 1]; args.splice(sIdx, 2) }

    runDsh(['plugin', '--profile', profile, 'add', '--save-exact', source])
    console.log(`\n${PLUGIN_NAME} 插件已安装。请重启 DSH 桌面端。`)
  } else if (command === 'uninstall') {
    runDsh(['plugin', '--profile', profile, 'remove', PLUGIN_NAME])
    console.log(`\n${PLUGIN_NAME} 插件已卸载。请重启 DSH 桌面端。`)
  } else {
    throw new Error(`无法识别的命令：${command}`)
  }
}

run(process.argv.slice(2))
