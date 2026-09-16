import { parse, type Node } from 'acorn'
import { randomUUID } from 'node:crypto'

export interface ReplBinding {
  name: string
  kind: 'const' | 'let' | 'var' | 'function' | 'class'
}

interface SyntaxNode extends Node {
  [key: string]: unknown
}

function syntaxNode(value: unknown): value is SyntaxNode {
  return !!value && typeof value === 'object' && typeof (value as Node).type === 'string'
}

function children(node: SyntaxNode): SyntaxNode[] {
  return Object.values(node).flatMap(value => {
    if (syntaxNode(value)) {
      return [value]
    }
    if (Array.isArray(value)) {
      return value.filter(syntaxNode)
    }
    return []
  })
}

function bindingNames(pattern: SyntaxNode): string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name as string]
    case 'RestElement':
      return bindingNames(pattern.argument as SyntaxNode)
    case 'AssignmentPattern':
      return bindingNames(pattern.left as SyntaxNode)
    case 'ArrayPattern':
      return (pattern.elements as unknown[]).filter(syntaxNode).flatMap(bindingNames)
    case 'ObjectPattern':
      return (pattern.properties as SyntaxNode[]).flatMap(property =>
        bindingNames((property.type === 'RestElement' ? property.argument : property.value) as SyntaxNode),
      )
    default:
      throw new Error(`Unsupported REPL binding pattern: ${pattern.type}`)
  }
}

function assignmentNames(target: SyntaxNode): string[] {
  if (target.type === 'MemberExpression') {
    return []
  }
  if (target.type === 'ObjectPattern') {
    return (target.properties as SyntaxNode[]).flatMap(property =>
      assignmentNames((property.type === 'RestElement' ? property.argument : property.value) as SyntaxNode),
    )
  }
  if (target.type === 'ArrayPattern') {
    return (target.elements as unknown[]).filter(syntaxNode).flatMap(assignmentNames)
  }
  if (target.type === 'AssignmentPattern') {
    return assignmentNames(target.left as SyntaxNode)
  }
  if (target.type === 'RestElement') {
    return assignmentNames(target.argument as SyntaxNode)
  }
  return target.type === 'Identifier' ? [target.name as string] : []
}

function reassignedPriorConstants(ast: SyntaxNode, names: Set<string>) {
  const assigned = new Set<string>()
  function visit(node: SyntaxNode, outer: Set<string>) {
    const shadowed = new Set(outer)
    const addPattern = (pattern: SyntaxNode) => {
      for (const name of bindingNames(pattern)) {
        shadowed.add(name)
      }
    }
    if (node.type === 'BlockStatement') {
      for (const statement of node.body as SyntaxNode[]) {
        if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
          for (const declaration of statement.declarations as SyntaxNode[]) {
            addPattern(declaration.id as SyntaxNode)
          }
        } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
          addPattern(statement.id as SyntaxNode)
        }
      }
    }
    if (/Function/.test(node.type)) {
      if (syntaxNode(node.id)) {
        addPattern(node.id)
      }
      for (const parameter of node.params as SyntaxNode[]) {
        addPattern(parameter)
      }
      const collectVars = (body: SyntaxNode) => {
        if (/Function/.test(body.type) || body.type === 'StaticBlock') {
          return
        }
        if (body.type === 'VariableDeclaration' && body.kind === 'var') {
          for (const declaration of body.declarations as SyntaxNode[]) {
            addPattern(declaration.id as SyntaxNode)
          }
        }
        for (const child of children(body)) {
          collectVars(child)
        }
      }
      collectVars(node.body as SyntaxNode)
    }
    if (node.type === 'CatchClause' && syntaxNode(node.param)) {
      addPattern(node.param)
    }
    if (node.type.startsWith('For')) {
      const declaration = node.init ?? node.left
      if (syntaxNode(declaration) && declaration.type === 'VariableDeclaration' && declaration.kind !== 'var') {
        for (const item of declaration.declarations as SyntaxNode[]) {
          addPattern(item.id as SyntaxNode)
        }
      }
    }
    let target: unknown
    if (node.type === 'AssignmentExpression') {
      target = node.left
    }
    if (node.type === 'UpdateExpression') {
      target = node.argument
    }
    if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && (node.left as SyntaxNode).type !== 'VariableDeclaration') {
      target = node.left
    }
    if (syntaxNode(target)) {
      for (const name of assignmentNames(target)) {
        if (names.has(name) && !shadowed.has(name)) {
          assigned.add(name)
        }
      }
    }
    for (const child of children(node)) {
      visit(child, shadowed)
    }
  }
  visit(ast, new Set())
  return assigned
}

interface SourceEdit { start: number; end: number; text: string }

/** Rewrite free references through the persistent program scope. Native
 * declarations remain intact, including destructuring initialization and TDZ.
 * A realm-local accessor resolves the same lexical slot for old closures and
 * new cells. Local scopes must never be rewritten into that shared namespace.
 */
function persistentReferences(ast: SyntaxNode, scope: string): SourceEdit[] {
  const edits: SourceEdit[] = []
  const addPattern = (target: Set<string>, pattern: SyntaxNode) => {
    for (const name of bindingNames(pattern)) target.add(name)
  }
  const blockNames = (body: SyntaxNode[], outer: Set<string>) => {
    const result = new Set(outer)
    for (const node of body) {
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') {
        for (const declaration of node.declarations as SyntaxNode[]) addPattern(result, declaration.id as SyntaxNode)
      } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        addPattern(result, node.id as SyntaxNode)
      }
    }
    return result
  }
  function functionVars(node: SyntaxNode, target: Set<string>) {
    if (/Function/.test(node.type) || node.type === 'StaticBlock') return
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declaration of node.declarations as SyntaxNode[]) addPattern(target, declaration.id as SyntaxNode)
    }
    for (const child of children(node)) functionVars(child, target)
  }
  function patternExpressions(pattern: SyntaxNode, shadowed: Set<string>) {
    if (pattern.type === 'AssignmentPattern') {
      patternExpressions(pattern.left as SyntaxNode, shadowed)
      visit(pattern.right as SyntaxNode, shadowed)
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties as SyntaxNode[]) {
        if (property.type === 'RestElement') patternExpressions(property.argument as SyntaxNode, shadowed)
        else {
          if (property.computed) visit(property.key as SyntaxNode, shadowed)
          patternExpressions(property.value as SyntaxNode, shadowed)
        }
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const element of (pattern.elements as unknown[]).filter(syntaxNode)) patternExpressions(element, shadowed)
    } else if (pattern.type === 'RestElement') patternExpressions(pattern.argument as SyntaxNode, shadowed)
  }
  function visit(node: SyntaxNode, outer: Set<string>, parent?: SyntaxNode, key?: string, shorthand?: string) {
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && (node.argument as SyntaxNode).type === 'Identifier') {
      const name = (node.argument as SyntaxNode).name as string
      if (!outer.has(name)) {
        edits.push({ start: node.start, end: node.end, text: `${scope}.typeOf(${JSON.stringify(name)})` })
        return
      }
    }
    if (node.type === 'Identifier') {
      const name = node.name as string
      if (outer.has(name)) return
      let text = `${scope}.values[${JSON.stringify(name)}]`
      // Preserve an ordinary lexical call's undefined receiver. A member call
      // would otherwise expose the private accessor object as `this`.
      if ((parent?.type === 'CallExpression' && key === 'callee') || (parent?.type === 'TaggedTemplateExpression' && key === 'tag')) text = `(0, ${text})`
      if (shorthand) text = `${shorthand}: ${text}`
      edits.push({ start: node.start, end: node.end, text })
      return
    }
    if (/Function/.test(node.type)) {
      const parameters = new Set(outer)
      if (node.type !== 'ArrowFunctionExpression') parameters.add('arguments')
      if (node.type === 'FunctionExpression' && syntaxNode(node.id)) addPattern(parameters, node.id)
      for (const parameter of node.params as SyntaxNode[]) addPattern(parameters, parameter)
      for (const parameter of node.params as SyntaxNode[]) patternExpressions(parameter, parameters)
      const bodyScope = new Set(parameters)
      functionVars(node.body as SyntaxNode, bodyScope)
      visit(node.body as SyntaxNode, bodyScope)
      return
    }
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations as SyntaxNode[]) {
        patternExpressions(declaration.id as SyntaxNode, outer)
        if (syntaxNode(declaration.init)) visit(declaration.init, outer)
      }
      return
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const classScope = new Set(outer)
      if (syntaxNode(node.id)) addPattern(classScope, node.id)
      if (syntaxNode(node.superClass)) visit(node.superClass, classScope)
      visit(node.body as SyntaxNode, classScope)
      return
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
      const scope = blockNames(node.body as SyntaxNode[], outer)
      if (node.type === 'StaticBlock') for (const item of node.body as SyntaxNode[]) functionVars(item, scope)
      for (const statement of node.body as SyntaxNode[]) visit(statement, scope)
      return
    }
    if (node.type === 'CatchClause') {
      const scope = new Set(outer)
      if (syntaxNode(node.param)) {
        addPattern(scope, node.param)
        patternExpressions(node.param, scope)
      }
      visit(node.body as SyntaxNode, scope)
      return
    }
    let shadowed = outer
    if (node.type.startsWith('For')) {
      const declaration = node.init ?? node.left
      if (syntaxNode(declaration) && declaration.type === 'VariableDeclaration' && declaration.kind !== 'var') {
        shadowed = new Set(outer)
        for (const item of declaration.declarations as SyntaxNode[]) addPattern(shadowed, item.id as SyntaxNode)
      }
    }
    if (node.type === 'SwitchStatement') {
      visit(node.discriminant as SyntaxNode, outer)
      const cases = node.cases as SyntaxNode[]
      const scope = blockNames(cases.flatMap(item => item.consequent as SyntaxNode[]), outer)
      for (const item of cases) visit(item, scope)
      return
    }
    if (node.type === 'Property') {
      if (node.computed) visit(node.key as SyntaxNode, shadowed)
      const value = node.value as SyntaxNode
      if (node.shorthand) {
        const name = (node.key as SyntaxNode).name as string
        if (value.type === 'AssignmentPattern') {
          visit(value.left as SyntaxNode, shadowed, value, 'left', name)
          visit(value.right as SyntaxNode, shadowed, value, 'right')
        } else visit(value, shadowed, node, 'value', name)
      } else visit(value, shadowed, node, 'value')
      return
    }
    for (const [childKey, value] of Object.entries(node)) {
      if ((node.type === 'MemberExpression' && childKey === 'property' && !node.computed)
        || ((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && childKey === 'key' && !node.computed)
        || ((node.type === 'LabeledStatement' || node.type === 'BreakStatement' || node.type === 'ContinueStatement') && childKey === 'label')) continue
      if (syntaxNode(value)) visit(value, shadowed, node, childKey)
      else if (Array.isArray(value)) for (const child of value.filter(syntaxNode)) visit(child, shadowed, node, childKey)
    }
  }
  visit(ast, new Set())
  return edits
}

/**
 * Compile a cell into an async function while retaining real lexical bindings.
 * Native lexical accessors are shared with later cells and prior closures;
 * new declarations may replace prior names, as in a notebook. Accessors registered
 * before execution let the worker retain initialized bindings after an error.
 * This is our own small AST transform, not the official Node REPL compiler.
 */
export function compileReplCell(code: string, prior: readonly ReplBinding[]) {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as SyntaxNode
  const current = new Map<string, ReplBinding>()
  const identifiers = new Set<string>()
  const hoistedDeclarations: Array<{ node: SyntaxNode; parent?: SyntaxNode }> = []
  const insertions: Array<{ position: number; text: string }> = []

  function inspect(node: SyntaxNode, depth: number, inFunctionScope: boolean, parent?: SyntaxNode) {
    // A free call becomes `(0, scope.values[name])(...)`. Its new leading
    // parenthesis can undo ASI after the preceding expression, initializer,
    // return, or throw. Preserve boundaries from the original parsed program,
    // including nested function bodies, without altering for-loop headers.
    const variableStatement = node.type === 'VariableDeclaration'
      && !(parent?.type === 'ForStatement' && parent.init === node)
      && !((parent?.type === 'ForOfStatement' || parent?.type === 'ForInStatement') && parent.left === node)
    if ((variableStatement || node.type === 'ExpressionStatement' || node.type === 'ReturnStatement' || node.type === 'ThrowStatement')
      && code[node.end - 1] !== ';') {
      insertions.push({ position: node.end, text: ';' })
    }
    if (node.type === 'Identifier') {
      identifiers.add(node.name as string)
    }
    const importMeta = node.type === 'MetaProperty' && (node.meta as SyntaxNode).name === 'import'
    if (node.type.startsWith('Import') || node.type.startsWith('Export') || importMeta) {
      throw new Error('Module imports and exports are not available in Computer Use JavaScript')
    }
    if (node.type === 'VariableDeclaration' && !inFunctionScope && (depth === 1 || node.kind === 'var')) {
      for (const declaration of node.declarations as SyntaxNode[]) {
        for (const name of bindingNames(declaration.id as SyntaxNode)) {
          current.set(name, { name, kind: node.kind as ReplBinding['kind'] })
        }
      }
      if (node.kind === 'var') {
        hoistedDeclarations.push({ node, parent })
      }
    }
    if (depth === 1 && (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration')) {
      const name = (node.id as SyntaxNode).name as string
      current.set(name, { name, kind: node.type === 'FunctionDeclaration' ? 'function' : 'class' })
      if (node.type === 'FunctionDeclaration') {
        hoistedDeclarations.push({ node, parent })
      }
    }
    const nestedScope = inFunctionScope || /Function/.test(node.type) || node.type === 'StaticBlock'
    for (const child of children(node)) {
      inspect(child, depth + 1, nestedScope, node)
    }
  }
  inspect(ast, 0, false)

  const carried = prior.filter(binding => !current.has(binding.name))
  const priorConstants = new Set(carried.filter(binding => binding.kind === 'const').map(binding => binding.name))
  const reassigned = reassignedPriorConstants(ast, priorConstants)
  const warnedNames = new Set(reassigned)
  for (const binding of current.values()) {
    if (binding.kind === 'const' && prior.some(previous => previous.name === binding.name && previous.kind === 'const')) {
      warnedNames.add(binding.name)
    }
  }
  const bindings = [...carried, ...current.values()]
  let prefix: string
  do {
    prefix = `__cu_cell_${randomUUID().replaceAll('-', '_')}`
  } while ([`${prefix}_scopeFactory`, `${prefix}_scope`, `${prefix}_register`, `${prefix}_mark`, `${prefix}_value`].some(name => identifiers.has(name)))
  const scopeFactory = `${prefix}_scopeFactory`
  const scope = `${prefix}_scope`
  const register = `${prefix}_register`
  const mark = `${prefix}_mark`
  const value = `${prefix}_value`
  const registrations = [...current.values()].map(binding =>
    `[${JSON.stringify(binding.name)}, ${JSON.stringify(binding.kind)}, () => ${binding.name}, ${value} => { ${binding.name} = ${value} }, ${binding.kind === 'var' || binding.kind === 'function'}]`,
  ).join(',\n')

  // Hoisted values exist before their declaration executes. In a failed cell,
  // only reached declarations should replace saved bindings. Insert markers
  // without rewriting user initializers, destructuring or nested function code.
  let markerCounter = 0
  for (const { node, parent } of hoistedDeclarations) {
    if (node.type === 'FunctionDeclaration') {
      insertions.push({ position: node.end, text: `;${mark}(${JSON.stringify((node.id as SyntaxNode).name)});` })
      continue
    }
    const iteration = parent && (parent.type === 'ForOfStatement' || parent.type === 'ForInStatement') && parent.left === node
    if (iteration) {
      const names = (node.declarations as SyntaxNode[]).flatMap(declaration => bindingNames(declaration.id as SyntaxNode))
      const marker = `${mark}(${names.map(name => JSON.stringify(name)).join(',')});`
      const body = parent.body as SyntaxNode
      if (body.type === 'BlockStatement') {
        insertions.push({ position: body.start + 1, text: marker })
      } else {
        insertions.push({ position: body.start, text: `{${marker}` })
        insertions.push({ position: body.end, text: '}' })
      }
      continue
    }
    for (const declaration of node.declarations as SyntaxNode[]) {
      const names = bindingNames(declaration.id as SyntaxNode)
      insertions.push({
        position: declaration.end,
        text: `, ${prefix}_reached_${markerCounter++} = ${mark}(${names.map(name => JSON.stringify(name)).join(',')})`,
      })
    }
  }
  // Direct writes can initialize a hoisted var before its declaration site.
  // Keep those writes on failure too. A logical assignment marks only when
  // its RHS actually evaluates, preserving short-circuit behavior.
  const futureVars = new Map<string, number>()
  for (const { node } of hoistedDeclarations) {
    if (node.type !== 'VariableDeclaration') {
      continue
    }
    for (const declaration of node.declarations as SyntaxNode[]) {
      for (const name of bindingNames(declaration.id as SyntaxNode)) {
        futureVars.set(name, Math.min(futureVars.get(name) ?? Infinity, declaration.start))
      }
    }
  }
  for (const statement of ast.body as SyntaxNode[]) {
    if (statement.type !== 'ExpressionStatement') {
      continue
    }
    const expression = statement.expression as SyntaxNode
    const target = expression.type === 'AssignmentExpression' ? expression.left
      : expression.type === 'UpdateExpression' ? expression.argument : undefined
    if (!syntaxNode(target)) {
      continue
    }
    const names = assignmentNames(target).filter(name => (futureVars.get(name) ?? -1) > expression.start)
    if (names.length === 0) {
      continue
    }
    const marker = `${mark}(${names.map(name => JSON.stringify(name)).join(',')})`
    if (['&&=', '||=', '??='].includes(expression.operator as string)) {
      const right = expression.right as SyntaxNode
      const value = `${prefix}_value`
      insertions.push({ position: right.start, text: `((${value}) => (${marker}, ${value}))(` })
      insertions.push({ position: right.end, text: ')' })
    } else {
      insertions.push({ position: statement.end, text: `;${marker};` })
    }
  }
  let instrumented = code
  const edits = [
    ...persistentReferences(ast, scope),
    ...insertions.map(({ position, text }) => ({ start: position, end: position, text })),
  ]
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end)
  }

  return {
    bindings,
    warnings: [...warnedNames].map(name => `${name} was declared with const; use let for reassignable variables.`),
    source: `(async (${scopeFactory}, ${register}, ${mark}) => {\n"use strict";\nconst ${scope} = ${scopeFactory}(${JSON.stringify([...reassigned])});\n${register}([${registrations}]);\n${instrumented}\n})`,
  }
}
