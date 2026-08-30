// 打包前把 lib/client-registry.js 同步为 lib/client.js：web 端 client 入口是
// package.json exports 的 "./client" → ./lib/client.js，两份文件必须一致，
// 否则浏览器拿到旧副本而修复看似"无效"。在 prepack 钩子里强制同步。
import { copyFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'lib', 'client-registry.js')
const dst = join(root, 'lib', 'client.js')
copyFileSync(src, dst)
const a = readFileSync(src, 'utf8'); const b = readFileSync(dst, 'utf8')
if (a !== b) { throw new Error('sync-client: client.js 与 client-registry.js 不一致') }
console.log('sync-client: lib/client.js ← lib/client-registry.js (' + a.length + ' bytes)')
