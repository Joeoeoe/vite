import { ServerPlugin } from '.'
import path from 'path'
import LRUCache from 'lru-cache'
import MagicString from 'magic-string'
import {
  init as initLexer,
  parse as parseImports,
  ImportSpecifier
} from 'es-module-lexer'
import {
  InternalResolver,
  resolveBareModuleRequest,
  jsSrcRE
} from '../resolver'
import {
  debugHmr,
  importerMap,
  importeeMap,
  ensureMapEntry,
  rewriteFileWithHMR,
  hmrDirtyFilesMap,
  latestVersionsMap
} from './serverPluginHmr'
import { clientPublicPath } from './serverPluginClient'
import {
  readBody,
  cleanUrl,
  isExternalUrl,
  bareImportRE,
  removeUnRelatedHmrQuery,
  cachedRead
} from '../utils'
import chalk from 'chalk'
import { isCSSRequest } from '../utils/cssUtils'
import { envPublicPath } from './serverPluginEnv'

const debug = require('debug')('vite:rewrite')

const rewriteCache = new LRUCache({ max: 1024 })

// Plugin for rewriting served js.
// - Rewrites named module imports to `/@modules/:id` requests, e.g.
//   "vue" => "/@modules/vue"
// - Rewrites files containing HMR code (reference to `import.meta.hot`) to
//   inject `import.meta.hot` and track HMR boundary accept whitelists.
// - Also tracks importer/importee relationship graph during the rewrite.
//   The graph is used by the HMR plugin to perform analysis on file change.
export const moduleRewritePlugin: ServerPlugin = ({
  root,
  app,
  watcher,
  resolver
}) => {
  app.use(async (ctx, next) => {
    await next()

    if (ctx.status === 304) {
      return
    }

    // we are doing the js rewrite after all other middlewares have finished;
    // this allows us to post-process javascript produced by user middlewares
    // regardless of the extension of the original files.
    const publicPath = ctx.path
    if (
      ctx.body &&
      ctx.response.is('js') &&
      !isCSSRequest(ctx.path) &&
      !ctx.url.endsWith('.map') &&
      // skip internal client
      publicPath !== clientPublicPath &&
      // need to rewrite for <script>\<template> part in vue files
      !((ctx.path.endsWith('.vue') || ctx.vue) && ctx.query.type === 'style') // 重写含<scipt><template>的vue组件，同时要排除style类型文件
    ) {
      const content = await readBody(ctx.body)
      const cacheKey = publicPath + content
      const isHmrRequest = !!ctx.query.t
      if (!isHmrRequest && rewriteCache.has(cacheKey)) {
        // 若不是HMR同时缓存有效就直接用缓存
        debug(`(cached) ${ctx.url}`)
        ctx.body = rewriteCache.get(cacheKey)
      } else {
        await initLexer //  ESM词法分析器 初始化，后续可以用于获得es module import 和 export 的 模块名 https://github.com/guybedford/es-module-lexer
        // dynamic import may contain extension-less path,
        // (.e.g import(runtimePathString))
        // so we need to normalize importer to ensure it contains extension
        // before we perform hmr analysis.
        // on the other hand, static import is guaranteed to have extension
        // because they must all have gone through module rewrite.
        const importer = removeUnRelatedHmrQuery(
          resolver.normalizePublicPath(ctx.url)
        ) // importer表示请求文件
        ctx.body = rewriteImports(
          //重写代码中的 import语句
          root,
          content!,
          importer,
          resolver,
          ctx.query.t
        )
        if (!isHmrRequest) {
          rewriteCache.set(cacheKey, ctx.body)
        }
      }
    } else {
      debug(`(skipped) ${ctx.url}`)
    }
  })

  // bust module rewrite cache on file change
  watcher.on('change', async (filePath) => {
    const publicPath = resolver.fileToRequest(filePath)
    const cacheKey = publicPath + (await cachedRead(null, filePath)).toString()
    debug(`${publicPath}: cache busted`)
    rewriteCache.del(cacheKey)
  })
}

export function rewriteImports(
  root: string,
  source: string,
  importer: string,
  resolver: InternalResolver,
  timestamp?: string
) {
  try {
    let imports: ImportSpecifier[] = []
    try {
      imports = parseImports(source)[0] // 解析代码中的import语句。imports数组包含所有import语句
    } catch (e) {
      console.error(
        chalk.yellow(
          `[vite] failed to parse ${chalk.cyan(
            importer
          )} for import rewrite.\nIf you are using ` +
            `JSX, make sure to named the file with the .jsx extension.`
        )
      )
    }
    const hasHMR = source.includes('import.meta.hot')
    const hasEnv = source.includes('import.meta.env')

    if (imports.length || hasHMR || hasEnv) {
      // 遍历imports数组中的import语句
      debug(`${importer}: rewriting`)
      const s = new MagicString(source)
      let hasReplaced = false

      const prevImportees = importeeMap.get(importer)
      const currentImportees = new Set<string>()
      importeeMap.set(importer, currentImportees)

      // 遍历此importer文件中import相关语句
      for (let i = 0; i < imports.length; i++) {
        const { s: start, e: end, d: dynamicIndex } = imports[i] //s与e为代码字符串中的下表
        let id = source.substring(start, end) // 获取import from 后的字符串内容
        let hasLiteralDynamicId = false
        if (dynamicIndex >= 0) {
          // 动态import
          const literalIdMatch = id.match(/^(?:'([^']+)'|"([^"]+)")$/)
          console.log(literalIdMatch)
          if (literalIdMatch) {
            hasLiteralDynamicId = true
            id = literalIdMatch[1] || literalIdMatch[2]
          }
        }
        if (dynamicIndex === -1 || hasLiteralDynamicId) {
          // 静态import
          // do not rewrite external imports
          if (isExternalUrl(id)) {
            continue
          }

          const resolved = resolveImport(
            root,
            importer,
            id,
            resolver,
            timestamp
          ) // resolve 模块路径

          if (resolved !== id) {
            debug(`    "${id}" --> "${resolved}"`)
            s.overwrite(
              start,
              end,
              hasLiteralDynamicId ? `'${resolved}'` : resolved
            ) //overwrite import 语句
            hasReplaced = true
          }

          // save the import chain for hmr analysis
          // TODO这里不大懂
          const importee = cleanUrl(resolved) // 清除#、?后的符号
          if (
            importee !== importer &&
            // no need to track hmr client or module dependencies
            importee !== clientPublicPath
          ) {
            currentImportees.add(importee)
            debugHmr(`        ${importer} imports ${importee}`)
            ensureMapEntry(importerMap, importee).add(importer)
          }
        } else if (id !== 'import.meta') {
          debug(`[vite] ignored dynamic import(${id})`)
        }
      }

      if (hasHMR) {
        debugHmr(`rewriting ${importer} for HMR.`)
        rewriteFileWithHMR(root, source, importer, resolver, s)
        hasReplaced = true
      }

      if (hasEnv) {
        debug(`    injecting import.meta.env for ${importer}`)
        s.prepend(
          `import __VITE_ENV__ from "${envPublicPath}"; ` +
            `import.meta.env = __VITE_ENV__; `
        )
        hasReplaced = true
      }

      // since the importees may have changed due to edits,
      // check if we need to remove this importer from certain importees
      if (prevImportees) {
        prevImportees.forEach((importee) => {
          if (!currentImportees.has(importee)) {
            const importers = importerMap.get(importee)
            if (importers) {
              importers.delete(importer)
            }
          }
        })
      }

      if (!hasReplaced) {
        debug(`    nothing needs rewriting.`)
      }

      return hasReplaced ? s.toString() : source
    } else {
      debug(`${importer}: no imports found.`)
    }

    return source
  } catch (e) {
    console.error(
      `[vite] Error: module imports rewrite failed for ${importer}.\n`,
      e
    )
    debug(source)
    return source
  }
}

export const resolveImport = (
  root: string,
  importer: string,
  id: string,
  resolver: InternalResolver,
  timestamp?: string
): string => {
  id = resolver.alias(id) || id

  // 非. / 开头，即node_modules模块
  if (bareImportRE.test(id)) {
    // directly resolve bare module names to its entry path so that relative
    // imports from it (including source map urls) can work correctly
    id = `/@modules/${resolveBareModuleRequest(root, id, importer, resolver)}`
  } else {
    // 开发者编写模块

    // 1. relative to absolute
    //    ./foo -> /some/path/foo
    //    举例：./App.vue ——> /App.vue ，原因：服务基于Koa
    let { pathname, query } = resolver.resolveRelativeRequest(importer, id)

    // 2. resolve dir index and extensions.
    pathname = resolver.normalizePublicPath(pathname) // index文件与扩展名

    // 3. mark non-src imports
    if (!query && path.extname(pathname) && !jsSrcRE.test(pathname)) {
      query += `?import`
      debugger // TODO 什么是非src imports？
    }

    id = pathname + query
  }

  // 4. force re-fetch dirty imports by appending timestamp
  if (timestamp) {
    const dirtyFiles = hmrDirtyFilesMap.get(timestamp)
    const cleanId = cleanUrl(id)
    // only rewrite if:
    if (dirtyFiles && dirtyFiles.has(cleanId)) {
      // 1. this is a marked dirty file (in the import chain of the changed file)
      id += `${id.includes(`?`) ? `&` : `?`}t=${timestamp}`
    } else if (latestVersionsMap.has(cleanId)) {
      // 2. this file was previously hot-updated and has an updated version
      id += `${id.includes(`?`) ? `&` : `?`}t=${latestVersionsMap.get(cleanId)}`
    }
  }
  return id
}
