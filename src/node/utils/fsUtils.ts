import path from 'path'
import fs from 'fs-extra'
import LRUCache from 'lru-cache'
import { Context } from '../server'
import { Readable } from 'stream'
import { seenUrls } from '../server/serverPluginServeStatic'
import mime from 'mime-types'
import { HMRWatcher } from '../server/serverPluginHmr'

const getETag = require('etag')

interface CacheEntry {
  lastModified: number
  etag: string
  content: Buffer
}

const fsReadCache = new LRUCache<string, CacheEntry>({
  max: 10000
})

/**
 * Read a file with in-memory cache.
 * Also sets appropriate headers and body on the Koa context.
 * This is exposed on middleware context as `ctx.read` with the `ctx` already
 * bound, so it can be used as `ctx.read(file)`.
 */
export async function cachedRead(
  ctx: Context | null,
  file: string
): Promise<Buffer> {
  const lastModified = fs.statSync(file).mtimeMs // 文件最后一次修改时间
  const cached = fsReadCache.get(file) // 文件缓存
  if (ctx) {
    ctx.set('Cache-Control', 'no-cache')
    ctx.type = mime.lookup(path.extname(file)) || 'application/octet-stream'
  }
  if (cached && cached.lastModified === lastModified) {
    // 缓存存在且未过期
    if (ctx) {
      // a private marker in case the user ticks "disable cache" during dev
      ctx.__notModified = true
      ctx.etag = cached.etag
      ctx.lastModified = new Date(cached.lastModified)
      if (ctx.get('If-None-Match') === ctx.etag && seenUrls.has(ctx.url)) {
        ctx.status = 304
      }
      seenUrls.add(ctx.url)
      ctx.body = cached.content // 若有ctx，则将内容置于body之中（因为这是个utils方法，多个地方用到）
    }
    return cached.content //返回对应内容
  }
  // #395 some file is an binary file, eg. font
  const content = await fs.readFile(file) //读取文件并后续设置缓存
  const etag = getETag(content)
  fsReadCache.set(file, {
    content,
    etag,
    lastModified
  })
  if (ctx) {
    //有ctx情况
    ctx.etag = etag
    ctx.lastModified = new Date(lastModified)
    ctx.body = content
    ctx.status = 200

    // watch the file if it's out of root.
    const { root, watcher } = ctx
    watchFileIfOutOfRoot(watcher, root, file)
  }
  // 无ctx则直接返回
  return content
}

/**
 * Read already set body on a Koa context and normalize it into a string.
 * Useful in post-processing middlewares.
 */
export async function readBody(
  stream: Readable | Buffer | string | null
): Promise<string | null> {
  if (stream instanceof Readable) {
    return new Promise((resolve, reject) => {
      let res = ''
      stream
        .on('data', (chunk) => (res += chunk))
        .on('error', reject)
        .on('end', () => {
          resolve(res)
        })
    })
  } else {
    return !stream || typeof stream === 'string' ? stream : stream.toString()
  }
}

export function lookupFile(
  dir: string,
  formats: string[],
  pathOnly = false
): string | undefined {
  for (const format of formats) {
    const fullPath = path.join(dir, format)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return pathOnly ? fullPath : fs.readFileSync(fullPath, 'utf-8')
    }
  }
  const parentDir = path.dirname(dir)
  if (parentDir !== dir) {
    return lookupFile(parentDir, formats, pathOnly)
  }
}

/**
 * Files under root are watched by default, but with user aliases we can still
 * serve files out of root. Add such files to the watcher (if not node_modules)
 */
export function watchFileIfOutOfRoot(
  watcher: HMRWatcher,
  root: string,
  file: string
) {
  if (!file.startsWith(root) && !/node_modules/.test(file)) {
    watcher.add(file)
  }
}
