#!/usr/bin/env node
/** Zero-dependency ESM TypeScript -> JS builder using Node's native stripTypeScriptTypes. */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function buildPackage(pkgDir, extraRewrite = (code) => code) {
  const srcDir = join(pkgDir, 'src')
  const distDir = join(pkgDir, 'dist')
  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
  for (const file of files) {
    const srcPath = join(srcDir, file)
    const outPath = join(distDir, file.replace(/\.ts$/u, '.js'))
    const raw = readFileSync(srcPath, 'utf8')
    const stripped = stripTypeScriptTypes(raw, { mode: 'strip' })
    const rewritten = extraRewrite(
      stripped.replace(/(from\s+['"][^'"]+?)\.ts(['"])/g, '$1.js$2').replace(/(import\(['"][^'"]+?)\.ts(['"]\))/g, '$1.js$2'),
    )
    writeFileSync(outPath, rewritten, 'utf8')
  }
  return files.length
}

const coreDir = join(ROOT, 'packages', 'memory-core')
const dshDir = join(ROOT, 'packages', 'dsh-memory')

const coreCount = buildPackage(coreDir)
const dshCount = buildPackage(dshDir, (code) =>
  code.replace(/from\s+['"]\.\.\/\.\.\/memory-core\/src\/index\.js['"]/g, "from './core/index.js'"),
)

// Bundle self-contained compiled memory-core runtime into dsh-memory/dist/core so
// DSH's symlinked Electron/Node 24 loader resolves zero workspace symlinks at runtime.
cpSync(join(coreDir, 'dist'), join(dshDir, 'dist', 'core'), { recursive: true })

console.log(`Built ${coreCount} memory-core modules and ${dshCount} self-contained dsh-memory modules`)
