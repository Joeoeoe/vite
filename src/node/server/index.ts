import path from 'path'
import fs from 'fs-extra'
import { RequestListener, Server } from 'http'
import { ServerOptions } from 'https'
import Koa, { DefaultState, DefaultContext } from 'koa'
import chokidar from 'chokidar'
import { createResolver, InternalResolver } from '../resolver'
import { moduleRewritePlugin } from './serverPluginModuleRewrite'
import { moduleResolvePlugin } from './serverPluginModuleResolve'
import { vuePlugin } from './serverPluginVue'
import { hmrPlugin, HMRWatcher } from './serverPluginHmr'
import { serveStaticPlugin } from './serverPluginServeStatic'
import { jsonPlugin } from './serverPluginJson'
import { cssPlugin } from './serverPluginCss'
import { assetPathPlugin } from './serverPluginAssets'
import { esbuildPlugin } from './serverPluginEsbuild'
import { ServerConfig } from '../config'
import { createServerTransformPlugin } from '../transform'
import { htmlRewritePlugin } from './serverPluginHtml'
import { proxyPlugin } from './serverPluginProxy'
import { createCertificate } from '../utils/createCertificate'
import { cachedRead } from '../utils'
import { envPlugin } from './serverPluginEnv'
export { rewriteImports } from './serverPluginModuleRewrite'
import { sourceMapPlugin, SourceMap } from './serverPluginSourceMap'
import { webWorkerPlugin } from './serverPluginWebWorker'
import { wasmPlugin } from './serverPluginWasm'
import { clientPlugin } from './serverPluginClient'

export type ServerPlugin = (ctx: ServerPluginContext) => void

export interface ServerPluginContext {
  root: string
  app: Koa<State, Context>
  server: Server
  watcher: HMRWatcher
  resolver: InternalResolver
  config: ServerConfig & { __path?: string }
  port: number
}

export interface State extends DefaultState {}

export type Context = DefaultContext &
  ServerPluginContext & {
    read: (filePath: string) => Promise<Buffer | string>
    map?: SourceMap | null
  }

export function createServer(config: ServerConfig): Server {
  const {
    root = process.cwd(),
    configureServer = [],
    resolvers = [],
    alias = {},
    transforms = [],
    vueCustomBlockTransforms = {},
    optimizeDeps = {},
    enableEsbuild = true
  } = config // 相关配置

  const app = new Koa<State, Context>()
  const server = resolveServer(config, app.callback()) //创建http、https或http2服务，app.callback()返回app的回调函数
  const watcher = chokidar.watch(root, {
    ignored: [/\bnode_modules\b/, /\b\.git\b/]
  }) as HMRWatcher // 监听文件改变，用于HMR
  const resolver = createResolver(root, resolvers, alias) // 文件解析器，含各种文件相关解析方法

  // context表示ServerPluginContext，包含各plugin需要使用的方法、属性
  const context: ServerPluginContext = {
    root,
    app,
    server,
    watcher,
    resolver,
    config,
    // port is exposed on the context for hmr client connection
    // in case the files are served under a different port
    port: config.port || 3000
  }

  // attach server context to koa context
  app.use((ctx, next) => {
    // ctx扩展context对象
    Object.assign(ctx, context)
    ctx.read = cachedRead.bind(null, ctx) //ctx为方法的预设参数，ctx.read方法用于后续读取对应文件，是个util方法，如果有缓存则返回缓存
    return next() //async/await另一种写法，这样写是因为不需要回到此中间件
  })

  // 每一个plugin均为一个函数可以传入context
  // 每个plugin均为app添加拦截监听
  const resolvedPlugins = [
    // rewrite and source map plugins take highest priority and should be run
    // after all other middlewares have finished
    sourceMapPlugin, // sourceMap plugin，可在中间件后添加soure map
    moduleRewritePlugin, // 对所有中间件产生的js进行处理，使得不需要管原始文件的扩展名
    htmlRewritePlugin,
    // user plugins
    ...(Array.isArray(configureServer) ? configureServer : [configureServer]),
    envPlugin,
    moduleResolvePlugin,
    proxyPlugin,
    clientPlugin,
    hmrPlugin,
    ...(transforms.length || Object.keys(vueCustomBlockTransforms).length
      ? [
          createServerTransformPlugin(
            transforms,
            vueCustomBlockTransforms,
            resolver
          )
        ]
      : []),
    vuePlugin,
    cssPlugin,
    enableEsbuild ? esbuildPlugin : null,
    jsonPlugin,
    assetPathPlugin,
    webWorkerPlugin,
    wasmPlugin,
    serveStaticPlugin
  ]
  resolvedPlugins.forEach((m) => m && m(context))

  // 扩展server.listen写法，可把port传递给context
  const listen = server.listen.bind(server)
  server.listen = (async (port: number, ...args: any[]) => {
    if (optimizeDeps.auto !== false) {
      await require('../optimizer').optimizeDeps(config)
    }
    context.port = port
    return listen(port, ...args)
  }) as any

  // 返回server服务，后续开启监听
  return server
}

function resolveServer(
  { https = false, httpsOptions = {}, proxy }: ServerConfig,
  requestListener: RequestListener
) {
  if (https) {
    if (proxy) {
      // #484 fallback to http1 when proxy is needed.
      return require('https').createServer(
        resolveHttpsConfig(httpsOptions),
        requestListener
      )
    } else {
      return require('http2').createSecureServer(
        {
          ...resolveHttpsConfig(httpsOptions),
          allowHTTP1: true
        },
        requestListener
      )
    }
  } else {
    return require('http').createServer(requestListener)
  }
}

function resolveHttpsConfig(httpsOption: ServerOptions) {
  const { ca, cert, key, pfx } = httpsOption
  Object.assign(httpsOption, {
    ca: readFileIfExists(ca),
    cert: readFileIfExists(cert),
    key: readFileIfExists(key),
    pfx: readFileIfExists(pfx)
  })
  if (!httpsOption.key || !httpsOption.cert) {
    httpsOption.cert = httpsOption.key = createCertificate()
  }
  return httpsOption
}

function readFileIfExists(value?: string | Buffer | any) {
  if (value && !Buffer.isBuffer(value)) {
    try {
      return fs.readFileSync(path.resolve(value as string))
    } catch (e) {
      return value
    }
  }
  return value
}
