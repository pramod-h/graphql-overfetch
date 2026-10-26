import { existsSync } from 'fs';
import path from 'path';
import { ts, SourceFile } from 'ts-morph';

/** `paths` from the project's tsconfig, resolved to absolute directories. */
export interface PathAliases {
  baseDir: string;
  paths: Record<string, string[]>;
}

/** Read `compilerOptions.paths` (following `extends`); null when there's no tsconfig. */
export function loadPathAliases(root: string): PathAliases | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    const { paths, baseUrl } = parsed.options;
    if (!paths) return null;
    const baseDir = baseUrl ?? (parsed.options as { pathsBasePath?: string }).pathsBasePath ?? root;
    return { baseDir, paths };
  }
  return null;
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Resolve an import specifier to a file in the project, or null when it can't
 * be resolved (a package, or an alias we can't map). Cheap on purpose: no type
 * checker, just relative paths and tsconfig `paths` wildcards.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
  aliases: PathAliases | null
): string | null {
  const bases: string[] = [];
  if (specifier.startsWith('.')) {
    bases.push(path.resolve(path.dirname(fromFile), specifier));
  } else if (aliases) {
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
      const star = pattern.indexOf('*');
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? '' : pattern.slice(star + 1);
      if (star === -1 ? specifier !== pattern : !(specifier.startsWith(prefix) && specifier.endsWith(suffix))) continue;
      const matched = star === -1 ? '' : specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const target of targets) bases.push(path.resolve(aliases.baseDir, target.replace('*', matched)));
    }
  }
  for (const base of bases) {
    for (const ext of EXTENSIONS) {
      if (files.has(base + ext)) return base + ext;
    }
  }
  return null;
}

export interface ImportedName {
  /** The name as exported by the source module. */
  imported: string;
  /** Absolute path of the source file, or '?' when it can't be resolved. */
  from: string;
}

/** Imported local names (and namespace aliases) → where they come from. */
export function importSources(
  sf: SourceFile,
  files: Set<string>,
  aliases: PathAliases | null
): { named: Map<string, ImportedName>; namespaces: Map<string, string> } {
  const named = new Map<string, ImportedName>();
  const namespaces = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const from = resolveImport(sf.getFilePath(), imp.getModuleSpecifierValue(), files, aliases) ?? '?';
    for (const ni of imp.getNamedImports()) {
      const imported = ni.getNameNode().getText();
      named.set((ni.getAliasNode() ?? ni.getNameNode()).getText(), { imported, from });
    }
    const def = imp.getDefaultImport();
    if (def) named.set(def.getText(), { imported: 'default', from });
    const ns = imp.getNamespaceImport();
    if (ns) namespaces.set(ns.getText(), from);
  }
  return { named, namespaces };
}
