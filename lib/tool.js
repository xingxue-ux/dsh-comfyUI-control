/**
 * The value-schema DSL and tool definition used by every tool in this plugin.
 *
 * This mirrors the enforced subset of `@deepseek-ai/dsh-tools` (compile an
 * author schema to raw JSON Schema, validate model arguments against it) so the
 * plugin loads from a preset directory that ships only these files — a user
 * preset sits outside the harness's `node_modules` walk, so importing the
 * harness package there is not guaranteed.
 *
 * `test/harness-schema.test.js` compiles and validates every tool in this
 * package with both implementations and fails if they disagree.
 */

/** Schema types the subset supports. */
const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json']
/** Annotation keys allowed on any schema node. */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
/** Keys only valid on an object node. */
const OBJECT_KEYS = ['properties', 'required', 'additionalProperties']
/** Keys only valid on an array node. */
const ARRAY_KEYS = ['items']
/** Keys only valid on a scalar node. */
const SCALAR_KEYS = ['enum', 'const']

/** Invalid model-generated tool arguments. */
export class ToolArgsError extends Error {
  constructor(violations) {
    super('invalid arguments: ' + violations.join('; '))
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLosslessJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  let ok = true
  if (Array.isArray(value)) {
    for (const item of value) if (!isLosslessJson(item, seen)) ok = false
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) if (!isLosslessJson(value[key], seen)) ok = false
  } else {
    ok = false
  }
  seen.delete(value)
  return ok
}

function scalarMatches(type, value) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  return value === null
}

/** Compile one author value node; `required` is only legal as a property flag. */
function compileValue(spec, path, allowRequired) {
  if (!isRecord(spec)) throw new Error(`${path} must be a value schema object`)
  const node = {}
  for (const key of Object.keys(spec)) {
    if (key === 'required' && allowRequired) continue
    if (!ANNOTATIONS.includes(key) && key !== 'type' && key !== 'oneOf' && !OBJECT_KEYS.includes(key) && !ARRAY_KEYS.includes(key) && !SCALAR_KEYS.includes(key)) {
      throw new Error(`${path}.${key} is not supported by the value schema DSL`)
    }
  }
  for (const key of ANNOTATIONS) if (Object.hasOwn(spec, key)) node[key] = spec[key]
  const hasType = Object.hasOwn(spec, 'type')
  const hasOneOf = Object.hasOwn(spec, 'oneOf')
  if (hasType && hasOneOf) throw new Error(`${path} cannot declare both type and oneOf`)
  if (!hasType && !hasOneOf) throw new Error(`${path} must declare type or oneOf`)
  if (hasOneOf) {
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) throw new Error(`${path}.oneOf must be an array of at least two schemas`)
    node.oneOf = spec.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false))
    return node
  }
  const type = spec.type
  if (!TYPES.includes(type)) throw new Error(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  if (type === 'json') return node
  node.type = type
  if (type === 'object') {
    if (!Object.hasOwn(spec, 'additionalProperties') || typeof spec.additionalProperties !== 'boolean') throw new Error(`${path}.additionalProperties must be a boolean on an object schema`)
    node.additionalProperties = spec.additionalProperties
    if (spec.additionalProperties === false && !Object.hasOwn(spec, 'properties')) throw new Error(`${path} needs properties when additionalProperties is false`)
    if (Object.hasOwn(spec, 'properties')) {
      if (!isRecord(spec.properties)) throw new Error(`${path}.properties must be an object of value schemas`)
      const properties = {}
      const required = []
      for (const [key, property] of Object.entries(spec.properties)) {
        if (!isRecord(property)) throw new Error(`${path}.properties.${key} must be a value schema object`)
        if (Object.hasOwn(property, 'required')) {
          if (property.required !== true) throw new Error(`${path}.properties.${key}.required must be true when present`)
          required.push(key)
        }
        properties[key] = compileValue(property, `${path}.properties.${key}`, true)
      }
      node.properties = properties
      if (required.length > 0) node.required = required
    }
    return node
  }
  if (type === 'array') {
    if (Object.hasOwn(spec, 'items')) node.items = compileValue(spec.items, `${path}.items`, false)
    return node
  }
  if (Object.hasOwn(spec, 'enum')) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0 || !spec.enum.every((entry) => scalarMatches(type, entry))) {
      throw new Error(`${path}.enum must be a non-empty array of ${type} values`)
    }
    node.enum = [...spec.enum]
  }
  if (Object.hasOwn(spec, 'const')) {
    if (!scalarMatches(type, spec.const)) throw new Error(`${path}.const must be a ${type} value`)
    node.const = spec.const
  }
  return node
}

/** Compile an implicit parameter root to its raw JSON Schema object. */
export function parameterSchema(spec) {
  if (!isRecord(spec)) throw new Error('parameters must be an object of value schemas')
  const properties = {}
  const required = []
  for (const [key, property] of Object.entries(spec)) {
    if (!isRecord(property)) throw new Error(`parameters.${key} must be a value schema object`)
    if (Object.hasOwn(property, 'required')) {
      if (property.required !== true) throw new Error(`parameters.${key}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValue(property, `parameters.${key}`, true)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

function diagnostic(path) {
  return path === '' ? 'arguments' : path
}

function propertyPath(path, key) {
  return path === '' ? key : `${path}.${key}`
}

function checkScalar(node, value, path) {
  if (Object.hasOwn(node, 'enum') && !node.enum.includes(value)) return [`"${diagnostic(path)}" must be one of ${JSON.stringify(node.enum)}`]
  if (Object.hasOwn(node, 'const') && value !== node.const) return [`"${diagnostic(path)}" must be ${JSON.stringify(node.const)}`]
  return []
}

/** Validate one value against a compiled raw schema. */
export function checkJsonSchema(schema, value, path = 'value') {
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch) => checkJsonSchema(branch, value, path).length === 0).length
    return matched === 1 ? [] : [`"${diagnostic(path)}" must match exactly one oneOf branch (matched ${matched})`]
  }
  if (schema.type === undefined) return isLosslessJson(value) ? [] : [`"${diagnostic(path)}" must be a lossless JSON value`]
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return [`"${diagnostic(path)}" must be an object`]
      const violations = []
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${propertyPath(path, key)}"`)
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...checkJsonSchema(child, value[key], propertyPath(path, key)))
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`)
        }
      }
      if (violations.length === 0 && !isLosslessJson(value)) violations.push(`"${diagnostic(path)}" must be a lossless JSON object`)
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${diagnostic(path)}" must be an array`]
      const violations = []
      if (schema.items) value.forEach((entry, index) => violations.push(...checkJsonSchema(schema.items, entry, `${path}[${index}]`)))
      if (violations.length === 0 && !isLosslessJson(value)) violations.push(`"${diagnostic(path)}" must be a dense lossless JSON array`)
      return violations
    }
    case 'string':
      return typeof value === 'string' ? checkScalar(schema, value, path) : [`"${diagnostic(path)}" must be a string`]
    case 'number':
      return typeof value !== 'number' ? [`"${diagnostic(path)}" must be a number`] : !Number.isFinite(value) ? [`"${diagnostic(path)}" must be a finite JSON number`] : checkScalar(schema, value, path)
    case 'integer':
      return !Number.isInteger(value) ? [`"${diagnostic(path)}" must be an integer`] : checkScalar(schema, value, path)
    case 'boolean':
      return typeof value === 'boolean' ? checkScalar(schema, value, path) : [`"${diagnostic(path)}" must be a boolean`]
    case 'null':
      return value === null ? checkScalar(schema, value, path) : [`"${diagnostic(path)}" must be null`]
    default:
      return [`"${diagnostic(path)}" has an unsupported schema type`]
  }
}

/** Validate model arguments against an implicit parameter schema. */
export function validateArgs(spec, args) {
  return checkJsonSchema(parameterSchema(spec), args, '')
}

/** The active definition factory: the harness one once `plugin.js` swaps it in. */
let factory = (options) => buildTool(options)

function buildTool(options) {
  const parameters = parameterSchema(options.parameters)
  const outputSchema = options.output.schema.type === 'json' ? {} : compileValue(options.output.schema, 'output.schema', false)
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
    },
    execute: async (args, exec) => {
      const violations = checkJsonSchema(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return options.execute(args, exec)
    },
  }
  if (options.output.presentationMeta) tool.output.presentationMeta = options.output.presentationMeta
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
    tool.timeoutMs = options.timeoutMs
  }
  if (options.isConcurrencySafe !== undefined) {
    if (typeof options.isConcurrencySafe !== 'function') throw new Error(`defineTool(${options.name}): isConcurrencySafe must be a predicate taking the args`)
    tool.isConcurrencySafe = options.isConcurrencySafe
  }
  if (options.presentCall) tool.presentCall = options.presentCall
  if (options.presentResult) tool.presentResult = options.presentResult
  // Author-side schema kept off the enumerable definition; the conformance test
  // re-compiles a tool through the harness factory from exactly these options.
  Object.defineProperty(tool, '__options', { value: options, enumerable: false })
  return tool
}

/**
 * Define one harness tool.
 *
 * The definition is built here rather than handed to the harness factory,
 * because a user preset cannot resolve `@deepseek-ai/dsh-tools`;
 * `test/harness-schema.test.js` compiles and validates every tool both ways and
 * fails if the two disagree.
 */
export function defineTool(options) {
  return factory(options)
}
