/**
 * EmotionCore (internal id: soulcore-settings) settings surface (Host half).
 *
 * The browser half renders the settings.section page. This half owns the
 * read/write boundary and runs local EmotionCore commands on demand.
 *
 * Security: loopback only; mutations require same-origin + JSON.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'soulcore-settings'
export const inject = ['webServer']

const ROOT = process.env.EMOTIONCORE_ROOT
  ? path.resolve(process.env.EMOTIONCORE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = path.join(ROOT, 'data')
const SURFCORE_ROOT = process.env.SURFCORE_ROOT || path.join(process.env.USERPROFILE || '', '.dsh', 'surfcore')
// The bridge writes prompt artifacts under the SurfCore working root, not the
// character directory. Keep them separate: character data vs runtime state.
const STATE_DIR = process.env.SURFCORE_STATE_DIR || path.join(process.env.USERPROFILE || '', 'surfcore', 'state')
const SETTINGS_PATH = path.join(DATA, 'soul-bridge-settings.json')
const VERSION_PATH = path.join(ROOT, 'VERSION')
const CALL_LOG = path.join(DATA, 'memory-tool-calls.jsonl')
const CAPABILITIES_PATH = path.join(DATA, 'capabilities.json')
const BODY_PATH = path.join(DATA, 'body-state.json')
const BALANCE_PATH = path.join(DATA, 'balance.json')
const BUDGET_PATH = path.join(DATA, 'session-budget.json')
const SLEEP_PATH = path.join(DATA, 'sleep-farewell.json')
const HANDOFF_PATH = path.join(DATA, 'handoff.md')
const EPISODE_INDEX = path.join(STATE_DIR, 'episode-index.json')
const EPISODE_CARDS = path.join(STATE_DIR, 'episode-cards.md')
const SKILL_MANIFEST = path.join(STATE_DIR, 'skill-manifest.md')
const SIDECAR_FALLBACK = path.join(SURFCORE_ROOT, 'characters', 'current', 'memory', 'memory-card-full.soulcore.jsonl')

// 鱼鱼找鸡（QQ 反查插件）运行器：随 SoulCore 一起启停。
// 运行器本身在 ~/.dsh/surfcore/yuyu-fish/，只连 SnowLuma 的 OneBot，只理 SurfCore 白名单。
const FISH_DIR = process.env.SOULCORE_FISH_DIR || path.join(SURFCORE_ROOT, 'yuyu-fish')
const FISH_RUNNER = path.join(FISH_DIR, 'runner.mjs')
const FISH_LOG = path.join(FISH_DIR, 'runner.log')
const FISH_PID = path.join(FISH_DIR, 'runner.pid')

const DEFAULTS = {
  enabled: true,
  shadowEnabled: true,
  memoryTool: true,
  memoryResolve: false,
  fishRunner: false,
  mark: false,
  timeoutMs: 4000,
  maxInflight: 2,
  pythonPath: process.env.SOULCORE_PYTHON || 'python',
  nodePath: 'node',
  dbPath: path.join(DATA, 'soulcore.db'),
}

async function sidecarPath() {
  try {
    const raw = JSON.parse(await readFile(path.join(SURFCORE_ROOT, 'characters', 'current.json'), 'utf8'))
    const dir = raw?.dir
    if (dir) return path.join(dir, 'memory', 'memory-card-full.soulcore.jsonl')
  } catch {}
  return SIDECAR_FALLBACK
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  })
  res.end(body)
}

function loopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  return origin === `http://${host}` || origin === `https://${host}`
}

async function readBody(req, limit = 64 * 1024) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw new Error('body too large')
  }
  return raw ? JSON.parse(raw) : {}
}

function cleanSettings(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key]
    if (value === undefined) continue
    if (typeof DEFAULTS[key] === 'boolean') out[key] = value === true
    else if (typeof DEFAULTS[key] === 'number') out[key] = Math.max(1, Math.min(120000, Number(value) || DEFAULTS[key]))
    else out[key] = String(value).slice(0, 500)
  }
  return { ...DEFAULTS, ...out }
}

async function loadSettings() {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
    return cleanSettings(raw)
  } catch {
    return { ...DEFAULTS }
  }
}

async function saveSettings(settings) {
  const next = cleanSettings(settings)
  await mkdir(DATA, { recursive: true })
  const tmp = `${SETTINGS_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, SETTINGS_PATH)
  return next
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, filePath)
  return value
}

function parseJsonOutput(result) {
  if (!result?.ok) return null
  try { return JSON.parse(result.output) } catch { return null }
}

// ── 鱼鱼找鸡运行器：宿主侧启停 ────────────────────────────────────────────────
let fishChild = null

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function fishStatus() {
  let pid = pidAlive(fishChild?.pid) ? fishChild.pid : null
  if (!pid) {
    try { pid = Number(String(await readFile(FISH_PID, 'utf8')).trim()) || null } catch {}
  }
  const running = pidAlive(pid)
  let logTail = ''
  try {
    const text = await readFile(FISH_LOG, 'utf8')
    logTail = text.split('\n').filter(Boolean).slice(-8).join('\n')
  } catch {}
  return {
    running,
    pid: running ? pid : null,
    dir: FISH_DIR,
    runnerExists: (await fileInfo(FISH_RUNNER)).exists,
    logTail,
  }
}

/**
 * 真 node.exe。Electron 里 process.execPath 是 Harness.exe，直接拿来跑脚本会再拉一个 DSH。
 * 顺序：环境变量 → 设置里的绝对路径 → 常见安装位置 → 随 DSH 内置的 node。
 */
function resolveNode(settings = {}) {
  const explicit = String(settings.nodePath || '').trim()
  const candidates = [
    process.env.SOULCORE_NODE,
    process.env.DSH_NODE,
    path.isAbsolute(explicit) ? explicit : null,
    'F:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  ]
  for (const candidate of candidates) {
    try { if (candidate && existsSync(candidate)) return candidate } catch {}
  }
  return 'node'
}

function startFish(settings = {}) {
  try {
    const child = spawn(resolveNode(settings), [FISH_RUNNER], {
      cwd: FISH_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    })
    child.unref()
    fishChild = child
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function stopFish() {
  const status = await fishStatus()
  if (!status.pid) { fishChild = null; return { ok: true } }
  await new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(status.pid), '/f', '/t'], { windowsHide: true }, () => resolve())
  })
  fishChild = null
  // taskkill 是硬杀，运行器来不及自己删 pid 文件；这里补一刀，免得下次状态读到陈旧 pid。
  try { await rm(FISH_PID, { force: true }) } catch {}
  return { ok: true }
}

function runPython(settings, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(
      settings.pythonPath,
      ['-m', 'soulcore', '--db', settings.dbPath, ...args],
      {
        cwd: ROOT,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONPATH: ROOT, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: String(stderr || stdout || error.message || error).slice(0, 4000) })
          return
        }
        resolve({ ok: true, output: String(stdout || '').slice(0, 12000) })
      },
    )
  })
}

async function tailCalls(limit = 8) {
  try {
    const text = await readFile(CALL_LOG, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    }).reverse()
  } catch {
    return []
  }
}

async function fileInfo(filePath) {
  try {
    const info = await stat(filePath)
    return { exists: true, bytes: info.size, mtime: info.mtime.toISOString() }
  } catch {
    return { exists: false, bytes: 0, mtime: null }
  }
}

async function sidecarInfo() {
  try {
    const file = await sidecarPath()
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    let enrichment = 0
    let extension = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (item.schema === 'soulcore.enrichment.v1') enrichment += 1
        if (item.schema === 'soulcore.extension.v1') extension += 1
      } catch {}
    }
    return { exists: true, bytes: info.size, mtime: info.mtime.toISOString(), enrichment, extension }
  } catch {
    return { exists: false, bytes: 0, mtime: null, enrichment: 0, extension: 0 }
  }
}

async function state(ctx) {
  const settings = await loadSettings()
  const tools = ctx.get('tools')
  const toolRegistered = Boolean(tools?.get?.('soulcore_memory'))
  const statsResult = await runPython(settings, ['memory-stats'], 20000)
  const memory = parseJsonOutput(statsResult)
  let version = '0.3.1'
  try { version = (await readFile(VERSION_PATH, 'utf8')).trim() || version } catch {}
  return {
    ok: true,
    version,
    root: ROOT,
    settingsPath: SETTINGS_PATH,
    settings,
    toolRegistered,
    fish: await fishStatus(),
    db: await fileInfo(settings.dbPath),
    memory,
    memoryError: memory ? null : (statsResult.error || 'memory-stats failed'),
    capabilities: await readJson(CAPABILITIES_PATH, {}),
    body: await readJson(BODY_PATH, null),
    balance: await readJson(BALANCE_PATH, null),
    budget: await readJson(BUDGET_PATH, null),
    sleep: await readJson(SLEEP_PATH, null),
    handoff: await fileInfo(HANDOFF_PATH),
    episodeIndex: await fileInfo(EPISODE_INDEX),
    episodeCards: await fileInfo(EPISODE_CARDS),
    skillManifest: await fileInfo(SKILL_MANIFEST),
    sidecar: await sidecarInfo(),
    calls: await tailCalls(8),
    recentCallCount: (await tailCalls(500)).length,
  }
}

async function action(ctx, body) {
  const settings = await loadSettings()
  const kind = String(body?.action || '')
  if (kind === 'save') {
    const next = await saveSettings(body.settings)
    return { ok: true, settings: next, message: '设置已保存' }
  }
  if (kind === 'capability') {
    const key = String(body.key || '')
    const allowed = new Set(['qq', 'pet', 'bili', 'l2', 'inject', 'memory_prompt'])
    if (!allowed.has(key)) return { ok: false, error: `unknown capability: ${key}` }
    const caps = await readJson(CAPABILITIES_PATH, {})
    caps[key] = body.value === true
    await writeJson(CAPABILITIES_PATH, caps)
    return { ok: true, capabilities: caps, message: '能力开关已更新' }
  }
  if (kind === 'rebuild-fts') {
    const result = await runPython(settings, ['fts-rebuild'], 30000)
    return { ...result, message: result.ok ? 'FTS 索引已重建' : 'FTS 重建失败' }
  }
  if (kind === 'episode-cards') {
    const result = await runPython(settings, ['episode-cards'], 30000)
    return { ...result, message: result.ok ? 'L2 事件卡已重建' : 'L2 重建失败' }
  }
  if (kind === 'test') {
    const query = String(body.query || 'AI').slice(0, 100)
    const result = await runPython(settings, ['memory', '--mode', 'search', '--query', query, '--limit', '3'])
    return { ...result, message: result.ok ? '查询完成' : '查询失败' }
  }
  if (kind === 'export') {
    const result = await runPython(settings, ['export-surfcore'])
    return { ...result, message: result.ok ? 'sidecar 已导出' : '导出失败' }
  }
  if (kind === 'appraise') {
    const limit = Math.max(1, Math.min(5, Number(body.limit) || 1))
    const result = await runPython(settings, ['appraise', '--limit', String(limit)], 180000)
    return { ...result, message: result.ok ? '本地评价完成' : '评价失败' }
  }
  if (kind === 'repair') {
    const result = await runPython(settings, ['repair-identities'])
    return { ...result, message: result.ok ? '身份回填完成' : '身份回填失败' }
  }
  if (kind === 'fish') {
    const on = body?.on === true
    const next = await saveSettings({ ...settings, fishRunner: on })
    const result = on ? startFish(next) : await stopFish()
    if (!result.ok) {
      return { ok: false, settings: next, fish: await fishStatus(), error: result.error, message: '鱼鱼找鸡运行器启动失败' }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const fish = await fishStatus()
    return {
      ok: true,
      settings: next,
      fish,
      message: on ? (fish.running ? `鱼鱼找鸡已启动（pid ${fish.pid}）` : '已启动，但还没看到进程，稍后刷新看日志') : '鱼鱼找鸡已停止',
    }
  }
  if (kind === 'refresh') {
    return state(ctx)
  }
  return { ok: false, error: `unknown action: ${kind}` }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/soulcore-settings/api/state',
    handler: async (req, res) => {
      if (!loopback(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return }
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
      try { json(res, 200, await state(ctx)) }
      catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/soulcore-settings/api/action',
    handler: async (req, res) => {
      if (!loopback(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
      if (!sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return }
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        json(res, 415, { ok: false, error: '写操作必须是 application/json' })
        return
      }
      try {
        const result = await action(ctx, await readBody(req))
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }))

  // 随 SoulCore 一起启停：激活时按设置自动拉起鱼鱼找鸡运行器；插件卸载 / DSH 退出时停掉。
  ctx.effect(() => () => { void stopFish() })
  void (async () => {
    try {
      const settings = await loadSettings()
      if (settings.fishRunner !== true) return
      const fish = await fishStatus()
      if (!fish.running) startFish(settings)
    } catch {
      // 自动拉起失败不影响设置页本身
    }
  })()
}
