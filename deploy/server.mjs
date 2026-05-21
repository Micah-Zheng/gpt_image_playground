import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const distDir = process.env.STATIC_DIR || '/app/dist'
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 80)
const enableAsyncImageProxy = process.env.ENABLE_ASYNC_IMAGE_PROXY === 'true'
const asyncDirectApiUrl = (process.env.ASYNC_IMAGE_DIRECT_API_URL || '').trim()
const jobTtlMs = Number(process.env.ASYNC_IMAGE_JOB_TTL_SECONDS || 1800) * 1000
const upstreamTimeoutMs = Number(process.env.ASYNC_IMAGE_UPSTREAM_TIMEOUT_SECONDS || 900) * 1000
const maxRequestBytes = Number(process.env.ASYNC_IMAGE_MAX_REQUEST_MB || 40) * 1024 * 1024
const jobs = new Map()

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(input)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const v1Index = pathSegments.indexOf('v1')
  const normalizedSegments = v1Index >= 0
    ? pathSegments.slice(0, v1Index + 1)
    : pathSegments.length
      ? [...pathSegments, 'v1']
      : []
  url.pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function buildApiUrl(baseUrl, path) {
  const endpointPath = String(path || '').replace(/^\/+/, '')
  if (!/^(v1\/)?images\/(generations|edits)$/i.test(endpointPath)) {
    throw new Error('Forbidden: async image proxy only allows images/generations or images/edits')
  }

  const normalizedBaseUrl = normalizeBaseUrl(asyncDirectApiUrl || baseUrl)
  if (!normalizedBaseUrl) throw new Error('Missing API base URL')
  const apiPath = normalizedBaseUrl.endsWith('/v1') ? endpointPath.replace(/^v1\//, '') : endpointPath
  return `${normalizedBaseUrl}/${apiPath}`
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) throw new Error('Invalid image data URL')
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const data = match[3] || ''
  const bytes = isBase64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf8')
  return new Blob([bytes], { type: mime })
}

function buildMultipartBody(multipart) {
  if (!multipart || typeof multipart !== 'object') return null
  const formData = new FormData()
  const fields = multipart.fields && typeof multipart.fields === 'object' && !Array.isArray(multipart.fields)
    ? multipart.fields
    : {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    formData.append(key, String(value))
  }

  const images = Array.isArray(multipart.images) ? multipart.images : []
  for (let i = 0; i < images.length; i++) {
    const image = images[i] || {}
    const blob = dataUrlToBlob(image.dataUrl)
    formData.append('image[]', blob, image.filename || `input-${i + 1}.png`)
  }

  if (multipart.mask?.dataUrl) {
    formData.append('mask', dataUrlToBlob(multipart.mask.dataUrl), multipart.mask.filename || 'mask.png')
  }
  return formData
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxRequestBytes) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function redactError(value) {
  return String(value || 'Unknown error').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]')
}

async function runJob(job) {
  try {
    const url = buildApiUrl(job.baseUrl, job.path)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs)
    try {
      const multipartBody = buildMultipartBody(job.multipart)
      const headers = {
        Authorization: `Bearer ${job.apiKey}`,
      }
      let body
      if (multipartBody) {
        body = multipartBody
      } else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(job.body)
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        payload = { message: text }
      }

      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || payload?.detail || `HTTP ${response.status}`
        throw new Error(Array.isArray(message) ? message.join('\n') : String(message))
      }

      job.status = 'done'
      job.payload = payload
      job.finishedAt = Date.now()
      log('async-image job done', job.id, `status=${response.status}`, `elapsedMs=${job.finishedAt - job.createdAt}`)
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    job.status = 'error'
    job.error = redactError(err instanceof Error ? err.message : err)
    job.finishedAt = Date.now()
    log('async-image job error', job.id, `elapsedMs=${job.finishedAt - job.createdAt}`, job.error)
  }
}

function cleanupJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > jobTtlMs) jobs.delete(id)
  }
}

async function handleCreateJob(req, res) {
  if (!enableAsyncImageProxy) {
    sendJson(res, 404, { error: 'Async image proxy is disabled' })
    return
  }

  try {
    const input = await readJsonBody(req)
    if (!input || typeof input !== 'object') throw new Error('Invalid request body')
    if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Missing API key')
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) throw new Error('Invalid image request body')
    if (input.multipart != null && (typeof input.multipart !== 'object' || Array.isArray(input.multipart))) throw new Error('Invalid multipart image request body')

    const jobId = randomUUID()
    const job = {
      id: jobId,
      status: 'running',
      baseUrl: input.baseUrl,
      path: input.path,
      apiKey: input.apiKey,
      body: input.body,
      multipart: input.multipart,
      createdAt: Date.now(),
      finishedAt: null,
      payload: null,
      error: null,
    }
    jobs.set(jobId, job)
    log('async-image job accepted', jobId, `path=${String(input.path || '')}`, `model=${String(input.body.model || '')}`, `size=${String(input.body.size || '')}`)
    void runJob(job)
    cleanupJobs()
    sendJson(res, 202, { jobId })
  } catch (err) {
    sendJson(res, 400, { error: redactError(err instanceof Error ? err.message : err) })
  }
}

function handleGetJob(req, res, url) {
  if (!enableAsyncImageProxy) {
    sendJson(res, 404, { error: 'Async image proxy is disabled' })
    return
  }

  const match = url.pathname.match(/^\/async-image\/jobs\/([^/]+)$/)
  const job = match ? jobs.get(decodeURIComponent(match[1])) : null
  if (!job) {
    sendJson(res, 404, { error: 'Job not found' })
    return
  }

  if (job.status === 'running') {
    sendJson(res, 200, { status: 'running' })
    return
  }
  if (job.status === 'done') {
    sendJson(res, 200, { status: 'done', payload: job.payload })
    return
  }
  sendJson(res, 200, { status: 'error', error: job.error || 'Async image job failed' })
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname)
  const relative = decoded === '/' ? '/index.html' : decoded
  const target = normalize(join(distDir, relative))
  const root = resolve(distDir)
  if (!target.startsWith(root)) return null
  return target
}

async function serveStatic(req, res, url) {
  let filePath = safeStaticPath(url.pathname)
  if (!filePath) {
    sendText(res, 403, 'Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(distDir, 'index.html')
  }

  const ext = extname(filePath)
  try {
    await stat(filePath)
  } catch {
    sendText(res, 404, 'Not Found')
    return
  }

  const headers = {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
  }
  if (url.pathname.startsWith('/assets/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else if (ext === '.html' || filePath.endsWith('/index.html') || ext === '.js' && filePath.endsWith('/sw.js')) {
    headers['Cache-Control'] = 'no-store'
  }

  res.writeHead(200, headers)
  createReadStream(filePath).pipe(res)
}

async function injectRuntimeEnv() {
  const defaultApiUrl = process.env.DEFAULT_API_URL || process.env.API_URL || 'https://api.openai.com/v1'
  const dockerLegacyApiUrlUsed = process.env.API_URL ? 'true' : 'false'
  const apiProxyAvailable = process.env.ENABLE_API_PROXY === 'true' ? 'true' : 'false'
  const apiProxyLocked = process.env.ENABLE_API_PROXY === 'true' && process.env.LOCK_API_PROXY === 'true' ? 'true' : 'false'
  const asyncImageProxyAvailable = enableAsyncImageProxy ? 'true' : 'false'

  const assetsDir = join(distDir, 'assets')
  const files = await readdir(assetsDir).catch(() => [])
  await Promise.all(files.filter((file) => file.endsWith('.js')).map(async (file) => {
    const path = join(assetsDir, file)
    let content = await readFile(path, 'utf8')
    content = content
      .replaceAll('__VITE_DEFAULT_API_URL_PLACEHOLDER__', defaultApiUrl)
      .replaceAll('__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__', apiProxyAvailable)
      .replaceAll('__VITE_API_PROXY_LOCKED_PLACEHOLDER__', apiProxyLocked)
      .replaceAll('__VITE_ASYNC_IMAGE_PROXY_AVAILABLE_PLACEHOLDER__', asyncImageProxyAvailable)
      .replaceAll('__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__', 'true')
      .replaceAll('__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__', dockerLegacyApiUrlUsed)
    await writeFile(path, content)
  }))
}

await injectRuntimeEnv()
setInterval(cleanupJobs, Math.min(jobTtlMs, 60_000)).unref()

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'POST' && url.pathname === '/async-image/jobs') {
    void handleCreateJob(req, res)
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/async-image/jobs/')) {
    handleGetJob(req, res, url)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed')
    return
  }
  void serveStatic(req, res, url)
}).listen(port, host, () => {
  console.log(`gpt-image-playground listening on ${host}:${port}`)
})
