import type { Program } from "estree";
import fs from "fs";
import { isBuiltin } from "module";
import { URL } from "url";

// We don't want to add eslint to our deps just to get this type.
// import type { Rule } from "eslint";
type RuleModule = any;
type RuleContext = any;

// @chatwing

const log = (...args: any[]) => {}; // console.log;

export default {
  rules: {
    checker: {
      meta: {
        type: "problem",
        docs: {
          description: "Detect project-specific issues",
          category: "Possible Errors",
          recommended: true,
        },
      },
      create(context: RuleContext) {
        return {
          Program(node: any) {
            const start = Date.now();
            checkFile(context, node);
            log("Checked in", Date.now() - start, "ms");
          },
        };
      },
    } satisfies RuleModule,
  },
};

// Get location of this file (in the lib directory).
const projectRoot = new URL("../../", import.meta.url).pathname;

// Only check files in the packages directory.
const INCLUDED = ["^packages/.*\\.tsx?$"];

// We want to ignore files matching these regex patterns.
// We ignore Storybook stories because they can bring in deps from random
// spots - in particular, `cloud` stories use components from `client`.
const IGNORED = ["^packages/.*\\.stories\\.tsx?$", "^packages/.*/stories/.*"];

function checkFile(context: RuleContext, prog: Program) {
  const checkers: LineChecker[] = [
    checkRelativeImports,
    checkEsmDayJs,
    checkImportInPackageJson,
    checkExportPageLayout,
    checkSuspense,
  ];

  const sourceCode = context.sourceCode.text;
  const lines = sourceCode.split("\n");
  const filename = context.filename;
  const filepath = filename.substring(projectRoot.length);

  const isIncluded = INCLUDED.some((re) => new RegExp(re).test(filepath));
  const isIgnored = IGNORED.some((re) => new RegExp(re).test(filepath));

  if (!isIncluded) {
    // console.log("Not included", filepath);
    return;
  }

  if (isIgnored) {
    // console.log("Ignored", filepath);
    return;
  }

  for (const line of lines) {
    for (const checker of checkers) {
      const error = checker(filepath, line, lines);
      if (error) {
        context.report({
          node: prog,
          message: error,
          loc: {
            start: {
              line: context.sourceCode.lines.indexOf(line) + 1,
              column: 0,
            },
            end: {
              line: context.sourceCode.lines.indexOf(line) + 1,
              column: line.length,
            },
          },
        });
      }
    }
  }
}

type LineChecker = (file: string, line: string, lines: string[]) => string | void;

const checkRelativeImports: LineChecker = (file, line) => {
  // Grab the import path if this is a relative import.
  const match = line.match(/from\s+['"](\.{2}\/.*)['"]/);
  if (!match) return;

  const path = match[1];

  // What directory is `file` in?
  let fileFolder = file.split("/").slice(0, -1).join("/");

  // Track folders visited during traversal (used for redundancy detection).
  const foldersVisited = [fileFolder];

  // Walk the import path. We drop the last segment (the filename) and only
  // look at directory traversals.
  for (const part of path.split("/").slice(0, -1)) {
    if (part === "..") {
      fileFolder = fileFolder.split("/").slice(0, -1).join("/");
      foldersVisited.push(fileFolder);
    } else {
      fileFolder = fileFolder ? fileFolder + "/" + part : part;
      // Re-entering a folder we already passed through means the path has
      // redundant ".." parts (e.g. `../foo/...` from inside `foo`).
      if (foldersVisited.includes(fileFolder)) {
        return "Import should not have redundant '..' parts.";
      }
      foldersVisited.push(fileFolder);
    }
  }

  // The resolved folder is in `fileFolder` now. Only flag cross-workspace-
  // package imports: source is inside `packages/<A>/...` and the resolved
  // path lands in `packages/<B>/...` where B != A. Reaches outside `packages/`
  // entirely (e.g. into monorepo-root `data/` or `.tools/`) are intentional —
  // those are non-workspace resources.
  if (file.startsWith("packages/")) {
    const sourcePkg = file.split("/").slice(0, 2).join("/");
    const landsInPackages = fileFolder === "packages" || fileFolder.startsWith("packages/");
    const landsInOwnPkg = fileFolder === sourcePkg || fileFolder.startsWith(sourcePkg + "/");
    if (landsInPackages && !landsInOwnPkg) {
      return "Import should be relative to package root.";
    }
  }
};

const checkEsmDayJs: LineChecker = (file, line) => {
  const match = line.match(/from\s+['"]dayjs\/esm+/);
  if (match) {
    return "Import should be from 'dayjs' (not 'dayjs/esm') to avoid ESM issues.";
  }

  // Also check for importing a dayjs plugin without adding .js to the end.
  const match2 = line.match(/from\s+['"]dayjs\/plugin\/[^.]+['"]/);
  if (match2) {
    return "Import should be from 'dayjs/plugin/...js' to avoid ESM issues.";
  }
};

const IGNORED_PACKAGES = [/^vitest$/, /^@storybook/, /^storybook/];

const checkImportInPackageJson: LineChecker = (file, line) => {
  let match = line.match(/^import\s.*\sfrom\s+['"](.+)['"]/);

  if (!match) {
    // Check for multiline import.
    match = line.match(/^} from\s+['"](.+)['"]/);
  }

  if (match) {
    const path = match[1];
    const parts = path.split("/");

    let importName = parts[0];

    // Check for relative import and skip.
    if (importName.startsWith(".")) {
      return;
    }

    // Is this a native Node.js module?
    if (isBuiltin(importName)) {
      return;
    }

    // Is this package to be ignored explicitly? (for project-level tools).
    if (IGNORED_PACKAGES.some((re) => re.test(importName))) {
      return;
    }

    // Check for scoped package and add the next part.
    if (importName.startsWith("@")) {
      importName += "/" + parts[1];
    }

    const packageJson = getPackageJson(file);

    // Are you importing your own package?
    if (packageJson.name === importName) {
      return "Import should not be from your own package; use relative import.";
    }

    // Is this a type-only import? As in "import type"
    if (line.includes("import type")) {
      return;
    }

    const deps = Object.keys(packageJson.dependencies ?? {});

    // Add in peerDependencies.
    deps.push(...Object.keys(packageJson.peerDependencies ?? {}));

    // Allow dev dependencies if this file ends with ".test.tsx?" or
    // ".stories.tsx?" or ".config.tsx?" or is a "generator" dev script.
    // Or if the file lives in the "packages/cloud/cli" directory.
    const allowDevDependencies =
      file.match(/\.(test|stories|config)\.tsx?$/) ||
      file.match(/^packages\/[^/]+\/gen\/[^.]+\.ts/) ||
      file.match(/^packages\/cloud\/cli\/.*/);

    if (allowDevDependencies) {
      deps.push(...Object.keys(packageJson.devDependencies ?? {}));
    }

    if (!deps.includes(importName)) {
      const or = allowDevDependencies ? " or devDependencies" : "";
      return `Imported package "${importName}" should be in nearest package.json dependencies${or}.`;
    }
  }
};

const checkExportPageLayout: LineChecker = (file, line) => {
  let match = line.match(/export\s+const\s+PageLayout\s+=/);
  if (match) {
    return "By convention, PageLayout components should not be exported.";
  }
  // Also check for "ContentLayout" which we use in a few places.
  match = line.match(/export\s+const\s+ContentLayout\s+=/);
  if (match) {
    return "By convention, ContentLayout components should not be exported.";
  }
};

//
// Package.json reading and cache.
//

type CachedPackageJson = {
  package: PackageJson;
  modified: number;
};

const packageJsonCache = new Map<string, CachedPackageJson>();

function getPackageJson(file: string): PackageJson {
  if (packageJsonCache.has(file)) {
    // Has the file changed since we last read it? Only check if it's been
    // more than 500ms since we last read it.
    const cached = packageJsonCache.get(file)!;
    const now = Date.now();
    if (now - cached.modified < 500) {
      return cached.package;
    }
  }

  // Search for the nearest package.json file.
  const parts = file.split("/");
  while (parts.length) {
    const path = parts.join("/") + "/package.json";
    if (fs.existsSync(path) && fs.statSync(path).isFile()) {
      const json = JSON.parse(fs.readFileSync(path, "utf8"));
      packageJsonCache.set(file, {
        package: json,
        modified: Date.now(),
      });
      return json;
    }
    parts.pop();
  }

  throw new Error("Could not find nearest package.json");
}

type PackageJson = {
  name: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

//
// Check <Suspense> is used when lazy() is used.
//

/**
 * If you write " = lazy(" then there should be a "<Suspense" somewhere
 * in the file.
 */
const checkSuspense: LineChecker = (file, line, lines) => {
  // Make sure the line isn't commented out.
  if (line.startsWith("//")) {
    return;
  }

  const match = line.match(/ = lazy\(/);
  if (match) {
    const start = match.index;
    const end = lines.findIndex((line) => line.includes("</Suspense>"));
    if (end === -1) {
      return "Missing <Suspense> when lazy() is used.";
    }
  }
};
