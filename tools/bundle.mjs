/**
 * Bundle this package into one self-contained ESM file for a preset directory.
 *
 * A user preset under `~/.dsh/.agent-presets` sits outside the harness's
 * `node_modules` walk and cannot resolve `@deepseek-ai/*`, so the preset ships
 * the plugin as one file. The entry is `index.js`; every relative static import
 * is inlined, and Node builtins stay external.
 *
 * Deliberately a small inliner rather than a general bundler: the inputs are
 * this package's own ESM, whose relative imports are static, top-level, and
 * free of dynamic imports.
 *
 * Usage: node tools/bundle.mjs [outFile]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * The plugin entry as authored. The build writes the generated
 * `lib/index.js` beside it, which is what the preset row loads; the plugin
 * resolves its own directory one level up from `lib/`.
 */
const DEFAULT_ENTRY = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control', 'lib', 'entry.js')

/** One static `import ... from '...'` clause. */
const IMPORT_PATTERN = /^[ \t]*import\b([^'"]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm
/** One `export ... from '...'` clause. */
const EXPORT_FROM_PATTERN = /^[ \t]*export\b([^'"]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm
/** `export default <expression>` (the plugin defines none, kept for completeness). */
const EXPORT_DEFAULT_PATTERN = /^[ \t]*export\s+default\s+/gm
/** `export const|let|var|class|function|async function <name>`. */
const EXPORT_DECL_PATTERN = /^([ \t]*)export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
/** `export { a, b as c }` without a source. */
const EXPORT_LIST_PATTERN = /^([ \t]*)export\s*{([^}]*)}[ \t]*;?[ \t]*$/gm

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/** Strip a UTF-8 BOM so the first line still matches the line-anchored patterns. */
function readModuleSource(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
}

/**
 * Collect the module graph in dependency order (every dependency comes first).
 * External imports stay inside each module's factory function, where ESM scopes
 * their bindings per module and one module's `existsSync` cannot collide with
 * another's.
 * @param {string} entry - absolute entry path.
 * @returns {{ modules: object[], entryId: number }}
 */
function collect(entry) {
  const modules = []
  const index = new Map()
  const visit = (path) => {
    const known = index.get(path)
    if (known !== undefined) return known
    const source = readModuleSource(path)
    const specifiers = []
    const external = []
    for (const pattern of [IMPORT_PATTERN, EXPORT_FROM_PATTERN]) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        if (isRelative(match[3])) specifiers.push(match[3])
        else external.push({ statement: match[0].trim(), specifier: match[3] })
      }
    }
    // Dependencies are visited (and therefore registered) before this module,
    // so every module body can initialize its own bindings immediately.
    const deps = new Map()
    for (const specifier of specifiers) {
      if (!deps.has(specifier)) deps.set(specifier, visit(resolve(dirname(path), specifier)))
    }
    const id = modules.length
    index.set(path, id)
    modules.push({ id, path, source, deps, external })
    return id
  }
  const entryId = visit(entry)
  return { modules, entryId }
}

/**
 * One top-level `import` per external specifier, carrying the union of the
 * names every module imports from it.
 *
 * An `import` declaration is only legal at a module's top level, so external
 * imports are lifted out of the module scopes. Several modules import the same
 * builtin with overlapping name lists (`{ existsSync }` and
 * `{ copyFileSync, existsSync }`); merging them into one declaration keeps each
 * binding visible to every module body without redeclaring it. A genuine
 * conflict (one local name bound to two sources) is a bundling error.
 */
function hoistExternalImports(modules) {
  const groups = new Map()
  const hoisted = new Set()
  for (const record of modules) {
    for (const { statement, specifier } of record.external) {
      hoisted.add(statement)
      const named = statement.match(/\{([^}]*)\}/)
      if (!named) throw new Error(`unsupported external import: ${statement}`)
      const names = named[1].split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const [from, to] = entry.split(/\s+as\s+/)
        return to ? { imported: from.trim(), local: to.trim() } : { imported: entry, local: entry }
      })
      const group = groups.get(specifier) ?? { names: new Map(), source: specifier }
      for (const { imported, local } of names) {
        const bound = group.names.get(local)
        if (bound !== undefined && bound !== imported) throw new Error(`import name "${local}" is bound to both ${bound} and ${imported} from ${specifier}`)
        group.names.set(local, imported)
      }
      groups.set(specifier, group)
    }
  }
  const statements = []
  for (const [specifier, group] of groups) {
    for (const [local, imported] of group.names) {
      if (/\bdefault\b/.test(local)) throw new Error(`default imports are unsupported: ${specifier}`)
    }
    const list = [...group.names].map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`))
    statements.push(`import { ${list.join(', ')} } from '${specifier}'`)
  }
  return { statements, isHoisted: (statement) => hoisted.has(statement.trim()) }
}

/** Replace relative imports with destructuring off the dependency's exports. */
function rewriteImports(source, path, deps) {
  const replace = (match, bindings, quote, specifier) => {
    if (!isRelative(specifier)) return match
    const target = deps.get(specifier)
    const trimmed = bindings.trim().replace(/,$/, '')
    if (trimmed === '') return `/* side-effect import of ${specifier} inlined */`
    if (trimmed.startsWith('{')) {
      // Destructuring an object gives the LOCAL binding: `import { a as b }`
      // becomes `const { a: b } = exports`.
      const names = trimmed.slice(1, -1).split(',').map((name) => name.trim()).filter(Boolean)
        .map((name) => {
          const [exported, local] = name.split(/\s+as\s+/)
          return local ? `${exported.trim()}: ${local.trim()}` : name
        })
      return `const { ${names.join(', ')} } = __modules[${target}].exports;`
    }
    if (trimmed.startsWith('*')) {
      return `const ${trimmed.replace(/^\*\s*as\s*/, '').trim()} = __modules[${target}].exports;`
    }
    return `const ${trimmed} = __modules[${target}].exports.default;`
  }
  return source.replace(IMPORT_PATTERN, replace)
}

/**
 * Final per-module transform: inline relative imports and rewrite `export`.
 *
 * `import.meta.url` becomes the module function's `url` parameter, which the
 * file head sets to the BUNDLE's own location — never the build machine's source
 * path. A preset copy therefore reports the preset directory as its own.
 */
function rewriteModule(record) {
  let output = rewriteImports(record.source, record.path, record.deps)
  output = output.replace(/import\.meta\.url/g, 'url')
  output = output.replace(EXPORT_DEFAULT_PATTERN, 'exports.default = ')
  output = normalizeExportLists(output)
  output = rewriteExportedDeclarations(output)
  if (/^[ \t]*export\b/m.test(output)) {
    const offender = output.match(/^[ \t]*export\b.*$/m)?.[0]
    throw new Error(`unsupported export form in ${relative(PACKAGE_DIR, record.path)}: ${JSON.stringify(offender)}`)
  }
  return output
}

/** Rewrite `export { a, b as c }` (no source) into plain `exports` assignments. */
function normalizeExportLists(source) {
  return source.replace(EXPORT_LIST_PATTERN, (match, indent, list) => {
    const assignments = list.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [from, to] = entry.split(/\s+as\s+/)
      return `exports.${(to ?? from).trim()} = ${from.trim()}`
    })
    return `${indent}${assignments.join('; ')}`
  })
}

/**
 * Rewrite `export <declaration>` into one `const <name> = exports.<name> = <value>`
 * statement.
 *
 * The single statement matters: the wrapping module function's closing brace also
 * sits at column 0, so splitting the export assignment onto its own line after a
 * multi-line declaration would let a declaration's own closing brace terminate
 * the module function early and break every following statement.
 */
function rewriteExportedDeclarations(source) {
  return source.replace(EXPORT_DECL_PATTERN, (match, indent, kind, name) => {
    if (kind === 'const' || kind === 'let' || kind === 'var') return `${indent}${kind} ${name} = exports.${name}`
    return `${indent}const ${name} = exports.${name} = ${kind} ${name}`
  })
}

export function bundle(entry = DEFAULT_ENTRY) {
  const { modules, entryId } = collect(entry)
  const externals = hoistExternalImports(modules)
  const lines = [
    '// Generated by tools/bundle.mjs — do not edit.',
    '// Source of truth: index.js + lib/ in the dsh-comfyui-control repository.',
    '// Self-contained ESM so the 绘图模式 preset can load it without the harness packages.',
    '// Every module receives the BUNDLE\'s own URL, so a preset copy resolves its',
    '// own directory instead of the machine that built it.',
  ]
  for (const statement of externals.statements) lines.push(statement)
  lines.push('')
  lines.push('const __moduleInit = []')
  for (const record of modules) {
    // One named function per module: the name is bound inside the function
    // scope, which is what keeps a module's own top-level declarations visible
    // to its exported functions, and `exports` is its export surface.
    lines.push(`__moduleInit[${record.id}] = function module${record.id}(exports, url) {`)
    // External imports are merged into the file head; delete them here so the
    // module body is not a second import declaration.
    lines.push(rewriteModule(record).replace(IMPORT_PATTERN, (match, bindings, quote, specifier) => (isRelative(specifier) ? match : `/* import from ${specifier} is hoisted to the file head */`)))
    lines.push('}')
  }
  lines.push('const __modules = []')
  lines.push('export const __bundleUrl = import.meta.url')
  lines.push('for (const [id, init] of __moduleInit.entries()) {')
  lines.push('  const exports = {}')
  lines.push('  __modules[id] = { exports }')
  lines.push('  init(exports, __bundleUrl)')
  lines.push('}')
  lines.push('')
  lines.push(`export const apply = __modules[${entryId}].exports.apply`)
  lines.push(`export const inject = __modules[${entryId}].exports.inject`)
  lines.push(`export const name = __modules[${entryId}].exports.name`)
  lines.push(`export const toolList = __modules[${entryId}].exports.toolList`)
  lines.push(`export const defineTool = __modules[${entryId}].exports.defineTool`)
  lines.push(`export const ToolArgsError = __modules[${entryId}].exports.ToolArgsError`)
  lines.push(`export const validateArgs = __modules[${entryId}].exports.validateArgs`)
  lines.push('')
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control.js')
  writeFileSync(out, bundle(), 'utf8')
  process.stdout.write(`${out}\n`)
}
