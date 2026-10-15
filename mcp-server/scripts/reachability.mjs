#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const EXPLICIT_SCRIPT_ROOTS = ["scripts/launch-server.mjs", "scripts/tender-daemon.ts"];

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const root = argv[index + 1];
      if (!root) throw new Error("--root requires a directory");
      options.root = path.resolve(root);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function relativeTo(root, filePath) {
  return toPosix(path.relative(root, filePath));
}

function isTestFile(root, filePath) {
  const relative = relativeTo(root, filePath);
  return relative.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
}

function isProductionSource(root, filePath) {
  const relative = relativeTo(root, filePath);
  return relative.startsWith("src/") && !isTestFile(root, filePath) && !relative.endsWith(".d.ts");
}

function listProjectFiles(root) {
  const files = [];
  for (const directory of ["src", "scripts"]) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;
    files.push(
      ...ts.sys.readDirectory(
        absolute,
        SOURCE_EXTENSIONS,
        ["node_modules", "dist", "coverage", ".git"],
      ),
    );
  }
  return [...new Set(files.map((filePath) => path.resolve(filePath)))].sort();
}

function compilerOptions(root) {
  const configPath = path.join(root, "tsconfig.json");
  let options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    }
    options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  }

  return {
    ...options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    rootDir: undefined,
    outDir: undefined,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
  };
}

function sourceCandidates(runtimePath) {
  const extension = path.extname(runtimePath);
  const withoutExtension = extension ? runtimePath.slice(0, -extension.length) : runtimePath;
  const candidates = [runtimePath];

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    candidates.push(
      `${withoutExtension}.ts`,
      `${withoutExtension}.tsx`,
      `${withoutExtension}.mts`,
      `${withoutExtension}.cts`,
    );
  } else if (!extension) {
    for (const candidateExtension of SOURCE_EXTENSIONS) {
      candidates.push(`${runtimePath}${candidateExtension}`);
      candidates.push(path.join(runtimePath, `index${candidateExtension}`));
    }
  }

  return candidates;
}

function resolveEntrypoint(root, token, knownFiles) {
  const cleaned = token.replace(/^\.\//, "").replace(/[),]+$/, "");
  let sourceRelative = cleaned;
  if (cleaned.startsWith("dist/scripts/")) {
    sourceRelative = `scripts/${cleaned.slice("dist/scripts/".length)}`;
  } else if (cleaned.startsWith("dist/")) {
    sourceRelative = `src/${cleaned.slice("dist/".length)}`;
  }

  for (const candidate of sourceCandidates(path.join(root, sourceRelative))) {
    const absolute = path.resolve(candidate);
    if (knownFiles.has(absolute)) return absolute;
  }
  return null;
}

function commandPaths(command) {
  const paths = [];
  const pattern = /(?:^|[\s"'`])((?:\.\/)?(?:dist|src|scripts)\/[^\s"'`;|&]+)/g;
  for (const match of command.matchAll(pattern)) paths.push(match[1]);
  return paths;
}

function discoverEntrypoints(root, knownFiles) {
  const entrypoints = new Set();
  const add = (token) => {
    const resolved = resolveEntrypoint(root, token, knownFiles);
    if (resolved) entrypoints.add(resolved);
  };

  add("src/server.ts");

  const packagePath = path.join(root, "package.json");
  if (existsSync(packagePath)) {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const command of Object.values(manifest.scripts ?? {})) {
      if (typeof command !== "string") continue;
      for (const token of commandPaths(command)) add(token);
    }

    const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const bin of bins) if (typeof bin === "string") add(bin);
  }

  for (const explicitRoot of EXPLICIT_SCRIPT_ROOTS) add(explicitRoot);
  return [...entrypoints].sort();
}

function evaluateStaticStrings(node, environment, depth = 0) {
  if (!node || depth > 12) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) {
    return evaluateStaticStrings(node.expression, environment, depth + 1);
  }
  if (ts.isIdentifier(node)) return [...(environment.get(node.text) ?? [])];
  if (ts.isConditionalExpression(node)) {
    return [
      ...evaluateStaticStrings(node.whenTrue, environment, depth + 1),
      ...evaluateStaticStrings(node.whenFalse, environment, depth + 1),
    ];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticStrings(node.left, environment, depth + 1);
    const right = evaluateStaticStrings(node.right, environment, depth + 1);
    return left.flatMap((leftPart) => right.map((rightPart) => `${leftPart}${rightPart}`));
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const replacements = evaluateStaticStrings(span.expression, environment, depth + 1);
      if (replacements.length === 0) return [];
      values = values.flatMap((prefix) =>
        replacements.map((replacement) => `${prefix}${replacement}${span.literal.text}`),
      );
    }
    return values;
  }
  return [];
}

function staticStringEnvironment(sourceFile) {
  const environment = new Map();
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const values = new Set(evaluateStaticStrings(declaration.initializer, environment));
        if (values.size === 0) continue;
        const previous = environment.get(declaration.name.text);
        if (!previous || [...values].some((value) => !previous.has(value))) {
          environment.set(declaration.name.text, new Set([...(previous ?? []), ...values]));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return environment;
}

function importedSpecifiers(sourceFile) {
  const environment = staticStringEnvironment(sourceFile);
  const specifiers = new Set();

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      for (const value of evaluateStaticStrings(node.arguments[0], environment)) specifiers.add(value);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...specifiers];
}

function resolveLocalModule(specifier, containingFile, knownFiles) {
  if (!specifier.startsWith(".")) return null;

  const runtimePath = path.resolve(path.dirname(containingFile), specifier);
  for (const candidate of sourceCandidates(runtimePath)) {
    const absolute = path.resolve(candidate);
    if (knownFiles.has(absolute)) return absolute;
  }
  return null;
}

function compilerExtension(filePath) {
  const extensions = {
    ".ts": ts.Extension.Ts,
    ".tsx": ts.Extension.Tsx,
    ".mts": ts.Extension.Mts,
    ".cts": ts.Extension.Cts,
    ".js": ts.Extension.Js,
    ".jsx": ts.Extension.Jsx,
    ".mjs": ts.Extension.Mjs,
    ".cjs": ts.Extension.Cjs,
  };
  return extensions[path.extname(filePath)] ?? ts.Extension.Ts;
}

function compilerHost(options, knownFiles) {
  const host = ts.createCompilerHost(options);
  host.resolveModuleNameLiterals = (moduleLiterals, containingFile) =>
    moduleLiterals.map(({ text }) => {
      const resolvedFileName = resolveLocalModule(text, containingFile, knownFiles);
      return {
        resolvedModule: resolvedFileName
          ? {
              resolvedFileName,
              extension: compilerExtension(resolvedFileName),
              isExternalLibraryImport: false,
            }
          : undefined,
      };
    });
  return host;
}

function buildReachableGraph(entrypoints, sourceFiles, knownFiles) {
  const reachable = new Set();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (!filePath || reachable.has(filePath)) continue;
    reachable.add(filePath);
    const sourceFile = sourceFiles.get(filePath);
    if (!sourceFile) continue;

    for (const specifier of importedSpecifiers(sourceFile)) {
      const target = resolveLocalModule(specifier, filePath, knownFiles);
      if (target && !reachable.has(target)) queue.push(target);
    }
  }

  return reachable;
}

function unalias(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function symbolIsCallable(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return true;
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    return (
      ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer) ||
      ts.isClassExpression(declaration.initializer)
    );
  });
}

function collectExports(root, productionFiles, sourceFiles, checker) {
  const records = [];
  const recordsBySymbol = new Map();

  for (const filePath of productionFiles) {
    const sourceFile = sourceFiles.get(filePath);
    if (!sourceFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = unalias(checker, exported);
      if (!symbol || (symbol.flags & ts.SymbolFlags.Value) === 0) continue;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration || path.resolve(declaration.getSourceFile().fileName) !== filePath) continue;

      const location = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
      const record = {
        file: relativeTo(root, filePath),
        absoluteFile: filePath,
        line: location.line + 1,
        name: exported.getName(),
        callable: symbolIsCallable(symbol),
        symbol,
        declaration,
        usage: {
          prodImportFiles: new Set(),
          prodRefs: 0,
          prodCalls: 0,
          testImportFiles: new Set(),
          testRefs: 0,
          testCalls: 0,
        },
      };
      records.push(record);
      const aliases = recordsBySymbol.get(symbol) ?? [];
      aliases.push(record);
      recordsBySymbol.set(symbol, aliases);
    }
  }

  return { records, recordsBySymbol };
}

function collectTopLevelNodes(sourceFiles, checker) {
  const nodesBySymbol = new Map();
  const nodesByDeclaration = new Map();

  const add = (identifier, declaration) => {
    const raw = checker.getSymbolAtLocation(identifier);
    const symbol = raw ? unalias(checker, raw) : null;
    if (!symbol || nodesBySymbol.has(symbol)) return;
    const node = {
      symbol,
      declaration,
      edges: new Set(),
      seeded: false,
    };
    nodesBySymbol.set(symbol, node);
    nodesByDeclaration.set(declaration, node);
  };

  for (const sourceFile of sourceFiles.values()) {
    if (sourceFile.isDeclarationFile) continue;
    for (const statement of sourceFile.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        add(statement.name, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) add(declaration.name, declaration);
        }
      }
    }
  }

  return { nodesBySymbol, nodesByDeclaration };
}

function declarationIdentifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return true;
  }
  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  return false;
}

function typePosition(node) {
  let current = node.parent;
  while (current && !ts.isStatement(current) && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isCallReference(node) {
  let expression = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
    const property = node.parent.name.text;
    if (property === "call" || property === "apply" || property === "bind") expression = node.parent;
  }
  const parent = expression.parent;
  return Boolean(
    (ts.isCallExpression(parent) && parent.expression === expression) ||
      (ts.isNewExpression(parent) && parent.expression === expression) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === expression),
  );
}

function executionOwner(node, sourceFile, nodesByDeclaration) {
  let current = node.parent;
  let insideDeferredBody = false;

  while (current && current !== sourceFile) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      insideDeferredBody = true;
    }

    if (ts.isFunctionDeclaration(current) && current.parent === sourceFile && current.name) {
      return nodesByDeclaration.get(current) ?? null;
    }

    if (ts.isClassDeclaration(current) && current.parent === sourceFile && current.name) {
      if (!insideDeferredBody) return null;
      return nodesByDeclaration.get(current) ?? null;
    }

    if (ts.isVariableDeclaration(current) && current.parent.parent.parent === sourceFile) {
      if (!insideDeferredBody || !ts.isIdentifier(current.name)) return null;
      return nodesByDeclaration.get(current) ?? null;
    }

    current = current.parent;
  }

  return null;
}

function recordImports(sourceFile, checker, recordsBySymbol, kind, originFile) {
  const addImport = (identifier) => {
    const raw = checker.getSymbolAtLocation(identifier);
    if (!raw) return;
    const records = recordsBySymbol.get(unalias(checker, raw));
    if (!records) return;
    for (const record of records) {
      const imports = kind === "prod" ? record.usage.prodImportFiles : record.usage.testImportFiles;
      imports.add(originFile);
    }
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.isTypeOnly) continue;
    if (clause.name) addImport(clause.name);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) addImport(element.name);
      }
    }
  }
}

function recordReferences(
  sourceFile,
  checker,
  recordsBySymbol,
  nodesBySymbol,
  nodesByDeclaration,
  kind,
  originFile,
) {
  const visit = (node) => {
    if (ts.isIdentifier(node) && !declarationIdentifier(node) && !typePosition(node)) {
      const raw = checker.getSymbolAtLocation(node);
      const symbol = raw ? unalias(checker, raw) : null;
      const targetNode = symbol ? nodesBySymbol.get(symbol) : null;
      if (kind === "prod" && targetNode) {
        const owner = executionOwner(node, sourceFile, nodesByDeclaration);
        if (owner && owner !== targetNode) owner.edges.add(targetNode);
        else if (!owner) targetNode.seeded = true;
      }
      const records = symbol ? recordsBySymbol.get(symbol) : null;
      if (records) {
        for (const record of records) {
          const usage = record.usage;
          if (kind === "prod") {
            usage.prodRefs += 1;
            if (originFile !== record.absoluteFile) usage.prodImportFiles.add(originFile);
            if (isCallReference(node)) usage.prodCalls += 1;
          } else {
            usage.testRefs += 1;
            if (originFile !== record.absoluteFile) usage.testImportFiles.add(originFile);
            if (isCallReference(node)) usage.testCalls += 1;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function reachableTopLevelNodes(nodesBySymbol) {
  const reachable = new Set();
  const queue = [...nodesBySymbol.values()].filter((node) => node.seeded);
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || reachable.has(node)) continue;
    reachable.add(node);
    for (const target of node.edges) if (!reachable.has(target)) queue.push(target);
  }
  return reachable;
}

function classifyExports(records, reachableFiles, reachableNodes, nodesBySymbol) {
  const unreachableExports = [];
  const testOnlyExports = [];
  const importedNotCalled = [];

  for (const record of records) {
    const usage = record.usage;
    const productionFileReachable = reachableFiles.has(record.absoluteFile);
    const topLevelNode = nodesBySymbol.get(record.symbol);
    const productionSymbolReachable = topLevelNode
      ? reachableNodes.has(topLevelNode)
      : usage.prodRefs > 0;
    const hasTestUse = usage.testImportFiles.size > 0 || usage.testRefs > 0;
    const base = { file: record.file, line: record.line, name: record.name };

    if (!productionFileReachable && !hasTestUse) {
      unreachableExports.push({ ...base, reason: "unreachable-file" });
    } else if (!productionSymbolReachable && usage.prodImportFiles.size === 0 && hasTestUse) {
      testOnlyExports.push({
        ...base,
        testImports: usage.testImportFiles.size,
        testCalls: usage.testCalls,
      });
    } else if (
      productionFileReachable &&
      !productionSymbolReachable &&
      usage.prodImportFiles.size === 0
    ) {
      unreachableExports.push({ ...base, reason: "no-production-reference" });
    }

    if (record.callable && usage.prodImportFiles.size > 0 && usage.prodCalls === 0) {
      importedNotCalled.push({
        ...base,
        prodImports: usage.prodImportFiles.size,
        prodRefs: usage.prodRefs,
        testCalls: usage.testCalls,
      });
    }
  }

  const byLocation = (left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name);
  unreachableExports.sort(byLocation);
  testOnlyExports.sort(byLocation);
  importedNotCalled.sort(byLocation);
  return { unreachableExports, testOnlyExports, importedNotCalled };
}

function analyze(root) {
  const started = process.hrtime.bigint();
  const files = listProjectFiles(root);
  const knownFiles = new Set(files);
  const options = compilerOptions(root);
  const program = ts.createProgram({
    rootNames: files,
    options,
    host: compilerHost(options, knownFiles),
  });
  const checker = program.getTypeChecker();
  const sourceFiles = new Map();

  for (const sourceFile of program.getSourceFiles()) {
    const absolute = path.resolve(sourceFile.fileName);
    if (knownFiles.has(absolute)) sourceFiles.set(absolute, sourceFile);
  }

  const entrypoints = discoverEntrypoints(root, knownFiles);
  if (entrypoints.length === 0) throw new Error(`no entry points found under ${root}`);
  const reachable = buildReachableGraph(entrypoints, sourceFiles, knownFiles);
  const productionFiles = files.filter((filePath) => isProductionSource(root, filePath));
  const { records, recordsBySymbol } = collectExports(
    root,
    productionFiles,
    sourceFiles,
    checker,
  );
  const { nodesBySymbol, nodesByDeclaration } = collectTopLevelNodes(sourceFiles, checker);

  for (const [filePath, sourceFile] of sourceFiles) {
    const kind = isTestFile(root, filePath) ? "test" : reachable.has(filePath) ? "prod" : null;
    if (!kind) continue;
    recordImports(sourceFile, checker, recordsBySymbol, kind, filePath);
    recordReferences(
      sourceFile,
      checker,
      recordsBySymbol,
      nodesBySymbol,
      nodesByDeclaration,
      kind,
      filePath,
    );
  }

  const reachableNodes = reachableTopLevelNodes(nodesBySymbol);

  const unreachableFiles = productionFiles
    .filter((filePath) => !reachable.has(filePath))
    .map((filePath) => ({ file: relativeTo(root, filePath) }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const categories = classifyExports(
    records,
    reachable,
    reachableNodes,
    nodesBySymbol,
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  return {
    version: 1,
    root,
    entrypoints: entrypoints.map((filePath) => relativeTo(root, filePath)),
    summary: {
      productionFiles: productionFiles.length,
      reachableProductionFiles: productionFiles.length - unreachableFiles.length,
      unreachableFiles: unreachableFiles.length,
      unreachableExports: categories.unreachableExports.length,
      testOnlyExports: categories.testOnlyExports.length,
      importedNotCalled: categories.importedNotCalled.length,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
    },
    unreachableFiles,
    ...categories,
  };
}

function formatReport(report) {
  const lines = [
    "Reachability report",
    `Root: ${report.root}`,
    `Elapsed: ${(report.summary.elapsedMs / 1000).toFixed(2)}s`,
    `Production files: ${report.summary.reachableProductionFiles}/${report.summary.productionFiles} reachable`,
    "",
    `Entry points (${report.entrypoints.length}):`,
    ...report.entrypoints.map((entrypoint) => `ROOT ${entrypoint}`),
    "",
    `Unreachable files (${report.unreachableFiles.length}):`,
    ...report.unreachableFiles.map(({ file }) => `UNREACHABLE_FILE ${file}`),
    "",
    `Unreachable exports (${report.unreachableExports.length}):`,
    ...report.unreachableExports.map(
      ({ file, line, name, reason }) =>
        `UNREACHABLE_EXPORT ${file}:${line} ${name} reason=${reason}`,
    ),
    "",
    `Test-only exports (${report.testOnlyExports.length}):`,
    ...report.testOnlyExports.map(
      ({ file, line, name, testImports, testCalls }) =>
        `TEST_ONLY_EXPORT ${file}:${line} ${name} test-imports=${testImports} test-calls=${testCalls}`,
    ),
    "",
    `Imported but not called outside __tests__ (${report.importedNotCalled.length}):`,
    ...report.importedNotCalled.map(
      ({ file, line, name, prodImports, prodRefs, testCalls }) =>
        `IMPORTED_NOT_CALLED ${file}:${line} ${name} prod-imports=${prodImports} prod-refs=${prodRefs} test-calls=${testCalls}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/reachability.mjs [--root <mcp-server>] [--json]\n");
  } else {
    const report = analyze(options.root);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  }
} catch (error) {
  process.stderr.write(`reachability: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
