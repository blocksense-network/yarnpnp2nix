import { execa, execaSync } from 'execa';
import PackCommand from './PackCommand'

let getExistingManifestNix = require('../../lib/getExistingManifest.nix.txt')

const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')
const { spawnSync } = require('child_process')
const { generateInlinedScript } = require('@yarnpkg/pnp')

let _nixCurrentSystem: string

function getByValue(map, searchValue) {
  for (let [key, value] of map.entries()) {
    if (value === searchValue)
      return key;
  }
}

export function nixCurrentSystem() {
  if (!!_nixCurrentSystem) return _nixCurrentSystem
  const res = JSON.parse(execaSync('nix', [
    'eval',
    '--impure',
    '--json',
    '--expr',
    'builtins.currentSystem',
  ]).stdout)
  _nixCurrentSystem = res
  return res
}

export async function getExistingYarnManifest(manifestPath: string) {
  try {
    const nixArgs = [
      'eval',
      '--json',
      '--impure',
      '--expr',
      getExistingManifestNix +
        '\n' +
        `
        getPackages (import ${manifestPath}).packages
      `,
    ]
    const { stdout } = await execa('nix', nixArgs, { stderr: 'ignore' })
    return JSON.parse(stdout)
  } catch (ex) {
    return null
  }
}

import { Configuration, Project, Cache, StreamReport, Manifest, tgzUtils, hashUtils, structUtils, miscUtils, scriptUtils, Workspace } from "@yarnpkg/core";
import { BaseCommand } from '@yarnpkg/cli';
import { xfs, CwdFS, PortablePath, VirtualFS } from '@yarnpkg/fslib';
import { ZipOpenFS } from '@yarnpkg/libzip';
import { getPnpPath, pnpUtils } from '@yarnpkg/plugin-pnp';
import { fileUtils } from '@yarnpkg/plugin-file';
import { Option } from 'clipanion';
import t = require('typanion');

class FetchCommand extends BaseCommand {
  static paths = [['nix', 'fetch-by-locator']]

  locator = Option.String({validator: t.isString()})
  outDirectory = Option.String({validator: t.isString()})

  async execute() {
    const configuration = await Configuration.find(process.cwd(), this.context.plugins);
    const {project, workspace} = await Project.find(configuration, process.cwd());

    const fetcher = configuration.makeFetcher()

    const installReport = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
      includeLogs: !this.context.quiet,
    }, async report => {
      configuration.values.set('enableMirror', false) // disable global cache as we want to output to outDirectory

      let locator = {
        ...(JSON.parse(this.locator)),
        locatorHash: '',
        identHash: '',
      }

      if (structUtils.isVirtualLocator(locator)) {
        locator = structUtils.devirtualizeLocator(locator)
      }

      const fetchOptions = { checksums: new Map(), project, cache: new Cache(this.outDirectory, { check: false, configuration, immutable: false }), fetcher, report }
      const fetched = await fetcher.fetch(locator, fetchOptions)

      fs.renameSync(fetched.packageFs.target, path.join(this.outDirectory, 'output.zip'))
    });
  }
}

const YARNNIX_DEBUG = process.env.YARNNIX_DEBUG === '1' || (process.env.DEBUG || '').includes('yarnpnp2nix')

function hostMatchesPackageConditions(conditions?: string | null): boolean {
  try {
    if (!conditions) return true
    // Very small parser for strings like: "os=linux & cpu=x64" (joined by &)
    const parts = conditions.split('&').map(s => s.trim())
    for (const part of parts) {
      const [k, v] = part.split('=').map(s => s.trim())
      if (!k || !v) continue
      if (k === 'os') {
        const map: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'win32', freebsd: 'freebsd', openbsd: 'openbsd', netbsd: 'netbsd', sunos: 'sunos', android: 'android' }
        if ((map[process.platform] || process.platform) !== v) return false
      } else if (k === 'cpu') {
        const map: Record<string, string> = { x64: 'x64', ia32: 'ia32', arm64: 'arm64', arm: 'arm', ppc64: 'ppc64', s390x: 's390x', loong64: 'loong64', riscv64: 'riscv64' }
        if ((map[process.arch] || process.arch) !== v) return false
      } else if (k === 'libc') {
        // Only check for musl vs glibc if requested; conservatively assume glibc on most systems
        const libc = process.env.LIBC || 'glibc'
        if (libc !== v) return false
      }
    }
    return true
  } catch {
    return true
  }
}

class CreateLockFileCommand extends BaseCommand {
  static paths = [['nix', 'create-lockfile']]

  packageRegistryDataPath = Option.String({validator: t.isString()})

  async execute() {
    const configuration = await Configuration.find(process.cwd(), this.context.plugins);

    const project = new Project(process.cwd(), { configuration })
    await project.setupResolutions()

    const packageRegistryData = JSON.parse(fs.readFileSync(this.packageRegistryDataPath, 'utf8'))

    const packageRegistryPackages: any[] = Object.values(packageRegistryData).filter(pkg => !!pkg?.manifest)

    for (const _package of packageRegistryPackages) {
      const pkg = Object.assign({}, _package.manifest, { name: _package.name, reference: _package.reference })
      //  {
      //   identHash: '9ca470fa61f45e067b8912c4342a3400ef0a72ba40cc23c2c0b328fe2213be1f145c35685252f614b708022def6c86380b66b07686cf36dd332caae8d849136f',
      //   scope: null,
      //   name: 'typescript',
      //   locatorHash: '9c0a3355115b252fc54c3916c6fcccf92c84041e4ac48c6ff1334782d6b0b707fd13645250cee7bae78e22cc73b5b806db08dd49dd0afa0ffcb6adeb10543ad6',
      //   reference: 'npm:4.8.4',
      //   version: '4.8.4',
      //   languageName: 'node',
      //   linkType: 'HARD',
      //   conditions: null,
      //   dependencies: Map(0) {},
      //   peerDependencies: Map(0) {},
      //   dependenciesMeta: Map(0) {},
      //   peerDependenciesMeta: Map(0) {},
      //   bin: Map(2) { 'tsc' => 'bin/tsc', 'tsserver' => 'bin/tsserver' }
      // }

      const dependencies = new Map()
      const bin = new Map(Object.entries(pkg.bin ?? {}))

      const ident = structUtils.makeIdent(pkg.scope, pkg.flatName)
      const locator = structUtils.makeLocator(ident, pkg.reference)
      const descriptor = structUtils.makeDescriptor(ident, pkg.descriptorRange)

      pkg.locatorHash = locator.locatorHash
      pkg.descriptorHash = descriptor.descriptorHash
      _package.manifest.locatorHash = locator.locatorHash
      _package.manifest.descriptorHash = descriptor.descriptorHash

      const origPackage = {
        ...locator,
        languageName: pkg.languageName,
        linkType: pkg.linkType,
        conditions: null,
        dependencies,
        bin,
      }
      project.originalPackages.set(pkg.locatorHash, origPackage)

      // storedResolutions is a map of descriptorHash -> locatorHash
      project.storedResolutions.set(pkg.descriptorHash, pkg.locatorHash)

      // storedChecksums is a map of locatorHash -> checksum
      if (pkg.checksum != null) project.storedChecksums.set(pkg.locatorHash, pkg.checksum)

      project.storedDescriptors.set(pkg.descriptorHash, descriptor)
    }

    for (const _package of packageRegistryPackages) {
      const pkg = project.originalPackages.get(_package.manifest.locatorHash)
      if (!pkg) continue

      const pkgDependencies = _package.packageDependencies ?? {}

      for (const dependencyName of Object.keys(pkgDependencies)) {
        const [depPkgName, depPkgReference] = pkgDependencies[dependencyName]
        const depPkg = packageRegistryPackages.find(pkg => pkg?.name === depPkgName && pkg?.reference === depPkgReference)
        if (depPkg?.manifest?.descriptorHash != null) {
          const depPkgDescriptor = project.storedDescriptors.get(depPkg.manifest.descriptorHash)
          if (depPkgDescriptor != null) {
            pkg.dependencies.set(depPkg.manifest.descriptorHash, depPkgDescriptor)
          }
        }
      }
    }

    project.storedPackages = project.originalPackages

    await project.persistLockfile()
  }
}

class ConvertToZipCommand extends BaseCommand {
  static paths = [['nix', 'convert-to-zip']]

  locator = Option.String({validator: t.isString()})
  tgzPath = Option.String({validator: t.isString()})
  outPath = Option.String({validator: t.isString()})

  async execute() {
    const configuration = await Configuration.find(process.cwd(), this.context.plugins);
    const {project, workspace} = await Project.find(configuration, process.cwd());

    const locator = {
      ...(JSON.parse(this.locator)),
      locatorHash: '',
      identHash: '',
    }

    const { path } = await tgzUtils.convertToZip(fs.readFileSync(this.tgzPath), {
      compressionLevel: project.configuration.get(`compressionLevel`),
      prefixPath: structUtils.getIdentVendorPath(locator),
      stripComponents: 1,
    })
    fs.copyFileSync(path, this.outPath)
  }
}

class GeneratePnpFile extends BaseCommand {
  static paths = [['nix', 'generate-pnp-file']]

  outDirectory = Option.String({validator: t.isString()})
  packageRegistryDataPath = Option.String({validator: t.isString()})
  topLevelPackageLocator = Option.String({validator: t.isString()})

  async execute() {
    const configuration = await Configuration.find(process.cwd(), this.context.plugins);
    const {project, workspace} = await Project.find(configuration, process.cwd());

    const pnpPath = getPnpPath({ cwd: this.outDirectory });

    const pnpFallbackMode = project.configuration.get(`pnpFallbackMode`);

    const dependencyTreeRoots = [] //project.workspaces.map(({anchoredLocator}) => ({name: structUtils.stringifyIdent(anchoredLocator), reference: anchoredLocator.reference}));
    const enableTopLevelFallback = pnpFallbackMode !== `none`;
    const fallbackPool = new Map();
    const ignorePattern = miscUtils.buildIgnorePattern([`.yarn/sdks/**`, ...project.configuration.get(`pnpIgnorePatterns`)]);
    const shebang = project.configuration.get(`pnpShebang`);

    const packageRegistry = new Map()

    const packageRegistryData = JSON.parse(fs.readFileSync(this.packageRegistryDataPath, 'utf8'))

    let topLevelPackage = null

    const outDirectoryReal = fs.realpathSync(this.outDirectory)

    for (const pkgIdent of Object.keys(packageRegistryData)) {
      const pkg = packageRegistryData[pkgIdent]
      if (!pkg) continue

      const ident = structUtils.makeIdent(pkg.manifest.scope, pkg.manifest.flatName)
      const locator = structUtils.makeLocator(ident, pkg.reference)

      const isVirtual = structUtils.isVirtualLocator(pkg);

      const packageDependencies = new Map()
      const packagePeers = new Set()

      for (const descriptor of pkg.manifest?.packagePeers ?? []) {
        packageDependencies.set(descriptor, null);
        packagePeers.add(descriptor);
      }

      if (pkg.packageDependencies != null) {
        for (const dep of Object.keys(pkg.packageDependencies)) {
          packageDependencies.set(dep, pkg.packageDependencies[dep]);
        }
      }

      // For virtual packages in Nix environment, use the canonical package's location
      // because virtual packages are not built as separate derivations, they use the canonical package
      let packageLocation: string
      if (isVirtual) {
        // For virtual packages, check if they have a canonicalPackage reference
        // This is more reliable than trying to find by devirtualized key
        if (pkg.canonicalPackage) {
          // Use the canonical package's location from the manifest
          const canonicalPackageLocationAbs = pkg.canonicalPackage.packageLocation ??
            (pkg.canonicalPackage.drvPath + '/node_modules/' + pkg.canonicalPackage.name)
          const relativeCanonicalPackageLocation = path.relative(outDirectoryReal, canonicalPackageLocationAbs)
          packageLocation = (relativeCanonicalPackageLocation.startsWith('../') ? relativeCanonicalPackageLocation : ('./' + relativeCanonicalPackageLocation)) + '/'
        } else {
          // Fallback: try to find canonical package by devirtualizing
          const canonicalLocator = structUtils.devirtualizeLocator(locator)
          const canonicalPackageKey = `${structUtils.stringifyIdent(canonicalLocator)}@${canonicalLocator.reference}`
          const canonicalPackage = packageRegistryData[canonicalPackageKey]

          if (canonicalPackage) {
            const canonicalPackageLocationAbs = canonicalPackage.packageLocation ?? (canonicalPackage.drvPath + '/node_modules/' + canonicalPackage.name)
            const relativeCanonicalPackageLocation = path.relative(outDirectoryReal, canonicalPackageLocationAbs)
            packageLocation = (relativeCanonicalPackageLocation.startsWith('../') ? relativeCanonicalPackageLocation : ('./' + relativeCanonicalPackageLocation)) + '/'
          } else {
            // Final fallback: use the virtual package's own location
            // This can happen when packages only exist as virtual packages due to peer dependency resolution
            if (YARNNIX_DEBUG) {
              console.warn(`Warning: Cannot find canonical package ${canonicalPackageKey} for virtual package ${pkg.name}@${pkg.reference}, using virtual package location as fallback`)
            }
            const packageLocationAbs = pkg.packageLocation ?? (pkg.drvPath + '/node_modules/' + pkg.name)
            const relativePackageLocation = path.relative(outDirectoryReal, packageLocationAbs)
            packageLocation = (relativePackageLocation.startsWith('../') ? relativePackageLocation : ('./' + relativePackageLocation)) + '/'
          }
        }
      } else {
        const packageLocationAbs = pkg.packageLocation ?? (pkg.drvPath + '/node_modules/' + pkg.name)
        const relativePackageLocation = path.relative(outDirectoryReal, packageLocationAbs)
        packageLocation = (relativePackageLocation.startsWith('../') ? relativePackageLocation : ('./' + relativePackageLocation)) + '/'
      }

      const packageData = {
        packageLocation,
        packageDependencies,
        packagePeers,
        linkType: pkg.linkType,
        // discardFromLookup: fetchResult.discardFromLookup || false,
      }

      miscUtils.getMapWithDefault(packageRegistry, pkg.name).set(pkg.reference, packageData);

      if (locator.reference.startsWith('workspace:')) {
        dependencyTreeRoots.push({
          name: structUtils.stringifyIdent(locator),
          reference: locator.reference,
        })
      }

      if (`${pkg.name}@${pkg.reference}` === this.topLevelPackageLocator) {
        topLevelPackage = packageData
      }
    }

    if (topLevelPackage != null) {
      miscUtils.getMapWithDefault(packageRegistry, null).set(null, topLevelPackage);

      // For workspace packages being built, add an entry for workspace:. resolution
      // This allows the build scripts to resolve the current package when running from its directory
      const topLevelPkgData = packageRegistryData[this.topLevelPackageLocator]
      if (topLevelPkgData && topLevelPkgData.reference && topLevelPkgData.reference.startsWith('workspace:')) {
        // Add an entry for @package-name@workspace:. that points to the same package data
        // This allows resolution when the build runs from within the package directory
        const workspaceDotReference = 'workspace:.'
        const workspaceDotLocator = `${topLevelPkgData.name}@${workspaceDotReference}`

        // Create a modified package data that uses workspace:. as the reference
        const workspaceDotPackageData = {
          ...topLevelPackage,
          packageLocation: './', // Current directory since we're building from within the package
        }

        // Add this entry to the package registry
        miscUtils.getMapWithDefault(packageRegistry, topLevelPkgData.name).set(workspaceDotReference, workspaceDotPackageData)

        // Also add to dependencyTreeRoots if it's a workspace package
        dependencyTreeRoots.push({
          name: topLevelPkgData.name,
          reference: workspaceDotReference,
        })
      }
    } else {
      throw new Error('Could not determine topLevelPackage, this is NEEDED for the .pnp.cjs to be correctly generated')
    }

    const pnpSettings = {
      dependencyTreeRoots,
      enableTopLevelFallback,
      fallbackExclusionList: pnpFallbackMode === `dependencies-only` ? dependencyTreeRoots : [],
      fallbackPool,
      ignorePattern,
      packageRegistry,
      shebang,
    }

    const loaderFile = generateInlinedScript(pnpSettings);

    await xfs.changeFilePromise(pnpPath.cjs, loaderFile, {
      automaticNewlines: true,
      mode: 0o755,
    });
  }
}

class MakePathWrappers extends BaseCommand {
  static paths = [['nix', 'make-path-wrappers']]

  binWrappersOutDirectory = Option.String({validator: t.isString()})
  pnpOutDirectory = Option.String({validator: t.isString()})
  packageRegistryDataPath = Option.String({validator: t.isString()})
  topLevelPackageLocator = Option.String({validator: t.isString()})

  async execute() {
    const packageRegistryData = JSON.parse(fs.readFileSync(this.packageRegistryDataPath, 'utf8'))

    const outDirectoryReal = fs.realpathSync(this.pnpOutDirectory)

    for (const pkgIdent of Object.keys(packageRegistryData)) {
      const pkg = packageRegistryData[pkgIdent]
      if (!pkg) continue

      const ident = structUtils.makeIdent(pkg.manifest.scope, pkg.manifest.flatName)
      const locator = structUtils.makeLocator(ident, pkg.reference)

      const isVirtual = structUtils.isVirtualLocator(pkg);

      const packageLocationAbs = pkg.packageLocation ?? (pkg.drvPath + '/node_modules/' + pkg.name)
      const relativePackageLocation = path.relative(outDirectoryReal, packageLocationAbs)
      let packageLocation = packageLocationAbs

      const isTopLevelPackage = `${pkg.name}@${pkg.reference}` === this.topLevelPackageLocator
      if (isTopLevelPackage) continue

      if (isVirtual) {
        packageLocation = path.join(outDirectoryReal, VirtualFS.makeVirtualPath('./.yarn/__virtual__', structUtils.slugifyLocator(locator), relativePackageLocation))
      }

      for (const bin of Object.keys(pkg?.manifest?.bin ?? {})) {
        const resolvedBinPath = path.join(packageLocation, pkg.manifest.bin[bin])
        await xfs.writeFilePromise(path.join(this.binWrappersOutDirectory, bin), `node ${resolvedBinPath} "$@"`, {
          mode: 0o755,
        })
      }
    }
  }
}

class RunBuildScriptsCommand extends BaseCommand {
  static paths = [['nix', 'run-build-scripts']]

  locator = Option.String({validator: t.isString()})
  pnpRootDirectory = Option.String({validator: t.isString()})
  packageDirectory = Option.String({validator: t.isString()})

  async execute() {
    const configuration = await Configuration.find(process.cwd(), this.context.plugins);
    const {project, workspace} = await Project.find(configuration, process.cwd());

    const _locator = JSON.parse(this.locator)
    const ident = structUtils.makeIdent(_locator.scope, _locator.name)
    const locator = structUtils.makeLocator(ident, _locator.reference)

    const pkg = project.originalPackages.get(locator.locatorHash)

    project.cwd = this.pnpRootDirectory

    // Note: We use originalPackages directly without restoring install state
    // This works because we're just reading package information, not modifying it
    project.storedPackages = project.originalPackages

    const manifest = await ZipOpenFS.openPromise(async (zipOpenFs) => {
      const linkers = project.configuration.getLinkers();
      const linkerOptions = {project, report: new StreamReport({stdout: new PassThrough(), configuration})};

      const linker = linkers.find(linker => linker.supportsPackage(pkg, linkerOptions));
      if (!linker)
        throw new Error(`The package ${structUtils.prettyLocator(project.configuration, pkg)} isn't supported by any of the available linkers`);

      const packageLocation = await linker.findPackageLocation(pkg, linkerOptions);
      const packageFs = new CwdFS(packageLocation, {baseFs: zipOpenFs});
      const manifest = await Manifest.find(PortablePath.dot, {baseFs: packageFs});

      return manifest
    })

    for (const scriptName of [`preinstall`, `install`, `postinstall`]) {
      if (!manifest.scripts.has(scriptName)) continue

      const exitCode = await scriptUtils.executePackageScript(pkg, scriptName, [], {cwd: this.packageDirectory, project, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr});

      if (exitCode > 0) {
        return exitCode
      }
    }
  }
}

export default {
  hooks: {
    afterAllInstalled: async (project: Project, opts) => {
      const linkers = project.configuration.getLinkers();
      const linkerOptions = {project, report: null};

      // const existingManifest = await getExistingYarnManifest(path.join(project.cwd, 'yarn-manifest.nix'))

      const installers = new Map(linkers.map(linker => {
        const installer = linker.makeInstaller(linkerOptions);

        const customDataKey = linker.getCustomDataKey();
        const customData = project.linkersCustomData.get(customDataKey);
        if (typeof customData !== `undefined`)
          installer.attachCustomData(customData);

        return [linker, installer] as [Linker, Installer];
      }));

      const cache = await Cache.find(project.configuration);


      const fetcher = project.configuration.makeFetcher();
      const fetchOptions = { checksums: new Map(), project, cache: null, fetcher, report: null }

      const resolver = project.configuration.makeResolver();
      const resolveOptions = {project, report: opts.report, resolver}

      const packageManifest: any = {}

      for (const [__, pkg] of project.storedPackages) {
        // include virtual packages so that peerDependencies work easily
        const isVirtual = structUtils.isVirtualLocator(pkg)
        // if (structUtils.isVirtualLocator(pkg)) {
        //   continue
        // }

        const canonicalPackage = isVirtual
          ? project.storedPackages.get(structUtils.devirtualizeLocator(pkg).locatorHash)
          : pkg

        const linker = linkers.find(linker => linker.supportsPackage(canonicalPackage, linkerOptions));
        const installer = installers.get(linker)

        let localPath = fetcher.getLocalPath(canonicalPackage, fetchOptions)

        if (!localPath) {
          const fileParsedSpec = fileUtils.parseSpec(canonicalPackage.reference)
          if (fileParsedSpec?.parentLocator != null && fileParsedSpec?.path != null) {
            const parentLocalPath = fetcher.getLocalPath(fileParsedSpec.parentLocator, fetchOptions)
            const resolvedPath = path.resolve(parentLocalPath, fileParsedSpec.path)
            if (resolvedPath != null) {
              localPath = resolvedPath
            }
          }
        }

        const localPathRelative = localPath != null ? './' + path.relative(project.cwd, localPath) : null

        const src = pkg.reference.startsWith('workspace:') ? `./${pkg.reference.substring('workspace:'.length)}` : (localPathRelative != null ? localPathRelative : null)
        const bin = pkg.bin != null ? Object.fromEntries(pkg.bin) : null

        const shouldBeUnplugged = src != null ? true : (installer?.shouldBeUnplugged != null ? installer.customData.store.get(pkg.locatorHash) != null ? installer.shouldBeUnplugged(pkg, installer.customData.store.get(pkg.locatorHash), project.getDependencyMeta(structUtils.isVirtualLocator(pkg) ? structUtils.devirtualizeLocator(pkg) : pkg, pkg.version)) : false : true)
        const willOutputBeZip = !src && !shouldBeUnplugged

        const isSourcePatch = src != null && pkg.reference.startsWith('patch:')

        let installCondition = null

        if (pkg.conditions != null) {
          const conditions = pkg.conditions.split('&').map(part => part.trim().split('='))
          let nixConditions = []

          for (const condition of conditions) {
            const key = condition[0]
            const v = condition[1]
            if (key === 'os') {
              if (v === 'linux') {
                nixConditions.push('stdenv.isLinux')
              } else if (v === 'darwin') {
                nixConditions.push('stdenv.isDarwin')
              } else {
                nixConditions.push('false')
              }
            } else if (key === 'cpu') {
              const cpuMapping: any = {
                'ia32': 'stdenv.isi686',
                'x64': 'stdenv.isx86_64',
                'arm': 'stdenv.isAarch32',
                'arm64': 'stdenv.isAarch64',
              }
              if (cpuMapping[v] != null) {
                nixConditions.push(cpuMapping[v])
              } else {
                nixConditions.push('false')
              }
            } else if (key === 'libc') {
              if (v !== 'glibc') {
                // only glibc is supported on Nix, other implementations like musl are not supported
                nixConditions.push('false')
              }
            }
          }

          if (nixConditions.length > 0) {
            installCondition = `stdenv: ${nixConditions.map(cond => `(${cond})`).join(' && ')}`
          }
        }

        let pkgDependencies = pkg.dependencies
        let pkgDevDependencies = new Map()

        const shouldLookupDevDependencies = canonicalPackage.reference.startsWith('workspace:')

        // lookup devDependencies from manifests for workspace: packages
        if (shouldLookupDevDependencies) {
          const manifest = await ZipOpenFS.openPromise(async (zipOpenFs) => {
            const linkers = project.configuration.getLinkers();
            const linkerOptions = {project, report: new StreamReport({stdout: new PassThrough(), configuration: project.configuration})};

            const linker = linkers.find(linker => linker.supportsPackage(canonicalPackage, linkerOptions));
            if (!linker)
              throw new Error(`The package ${structUtils.prettyLocator(project.configuration, pkg)} isn't supported by any of the available linkers`);

            const packageLocation = await linker.findPackageLocation(canonicalPackage, linkerOptions);
            const packageFs = new CwdFS(packageLocation, {baseFs: zipOpenFs});
            const manifest = await Manifest.find(PortablePath.dot, {baseFs: packageFs});

            return manifest
          })

          if (manifest != null) {
            pkgDependencies = new Map()
            pkgDevDependencies = new Map()

            if (manifest.devDependencies) {
              Array.from(manifest.devDependencies).map(([key, value]) => pkgDevDependencies.set(key, pkg.dependencies.get(key)))
              Array.from(pkg.dependencies).map(([key, value]) =>
                !pkgDevDependencies.has(key) ? pkgDependencies.set(key, value) : null
              )
            }
          }
        }

        const dependencies = (await Promise.all(Array.from(pkgDependencies).map(async ([key, value]) => {
          const resolutionHash = project.storedResolutions.get(value.descriptorHash)
          let resolvedPkg = resolutionHash != null ? project.storedPackages.get(resolutionHash) :
            null
          if (!resolvedPkg) {
            // Skip unresolved packages (can happen with optional dependencies)
            return null
          }
          return {
            key,
            name: structUtils.stringifyIdent(value),
            packageManifestId: structUtils.stringifyIdent(resolvedPkg) + '@' + resolvedPkg.reference,
          }
        }))).filter(pkg => !!pkg)

        const devDependencies = (await Promise.all(Array.from(pkgDevDependencies).map(async ([key, value]) => {
          const resolutionHash = project.storedResolutions.get(value.descriptorHash)
          let resolvedPkg = resolutionHash != null ? project.storedPackages.get(resolutionHash) :
            null
          if (!resolvedPkg) {
            // Skip unresolved packages (can happen with optional dependencies)
            return null
          }
          return {
            key,
            name: structUtils.stringifyIdent(value),
            packageManifestId: structUtils.stringifyIdent(resolvedPkg) + '@' + resolvedPkg.reference,
          }
        }))).filter(pkg => !!pkg)

        const packagePeers = []

        // For virtual packages, get peer dependencies from the canonical package
        const peerDependencySource = isVirtual ? canonicalPackage : pkg
        for (const descriptor of peerDependencySource.peerDependencies.values()) {
          packagePeers.push(structUtils.stringifyIdent(descriptor));
        }

        const manifestPackageId = structUtils.stringifyIdent(pkg) + '@' + pkg.reference

        // const packageInExistingManifest = existingManifest?.[manifestPackageId]

        let outputHash = null
        let outputHashByPlatform: any = null

        await (async function() {
          if (src != null && !isSourcePatch) {
            // no outputHash for when a src is provided as the build will be completed locally.
            outputHash = null
            outputHashByPlatform = null
            return
          } else if (willOutputBeZip) {
            // simple, use the hash of the zip file
            const checksum = project.storedChecksums.get(pkg.locatorHash)
            if (checksum != null) {
              // Remove version prefix (e.g., "10/", "c0/", "10c0/", etc.) - everything before and including the last slash
              outputHash = checksum.includes('/') ? checksum.substring(checksum.lastIndexOf('/') + 1) : checksum
            } else {
              outputHash = null
            }
            outputHashByPlatform = null
            return
          } else if (shouldBeUnplugged) {
            // Package needs to be unplugged (native modules, etc.)
            const checksum = project.storedChecksums.get(pkg.locatorHash);
            // Remove version prefix (e.g., "10/", "c0/", "10c0/", etc.) - everything before and including the last slash
            outputHash = checksum && checksum.includes('/') ? checksum.substring(checksum.lastIndexOf('/') + 1) : checksum;
            if (!outputHash) {
              // Skip attempting to hash platform-incompatible prebuilt packages (noisy and not needed)
              if (!hostMatchesPackageConditions((pkg as any).conditions)) {
                if (YARNNIX_DEBUG) console.warn('skip hashing incompatible package', pkg.name, pkg.reference)
              } else {
                try {
                  const cachePath = cache.getLocatorPath(pkg as any, null)
                  outputHash = await hashUtils.checksumFile(cachePath)
                } catch (error: any) {
                  if (YARNNIX_DEBUG) console.warn('error getting outputHash', error?.message)
                }
              }
            }
            outputHashByPlatform = null
            return
          } else {
            outputHash = null
            outputHashByPlatform = null
            return
          }
        })()

        const descriptorHash = getByValue(project.storedResolutions, pkg.locatorHash)
        const descriptor = project.storedDescriptors.get(descriptorHash)
        const rawChecksum = project.storedChecksums.get(pkg.locatorHash)
        // Normalize checksum by removing version prefixes like "10c0/", "c0/", etc.
        const yarnChecksum = rawChecksum && rawChecksum.includes('/') ? rawChecksum.substring(rawChecksum.lastIndexOf('/') + 1) : rawChecksum

        packageManifest[manifestPackageId] = {
          isVirtual,
          canonicalPackage,
          name: structUtils.stringifyIdent(pkg),
          reference: pkg.reference,
          linkType: pkg.linkType, // HARD package links are the most common, and mean that the target location is fully owned by the package manager. SOFT links, on the other hand, typically point to arbitrary user-defined locations on disk.
          outputName: [structUtils.stringifyIdent(pkg), pkg.version, pkg.locatorHash.substring(0, 10)].filter(part => !!part).join('-').replace(/@/g, '').replace(/[\/]/g, '-'),
          outputHash,
          outputHashByPlatform,
          src,
          shouldBeUnplugged,
          installCondition,
          bin,

          // other things necessary for recreating lock file that we don't necessarily use
          flatName: pkg.name,
          descriptor: descriptor,
          languageName: pkg.languageName,
          scope: pkg.scope,
          checksum: yarnChecksum,

          dependencies,
          devDependencies,
          packagePeers,
        }
      }

      let manifestNix: string[] = []

      const manifestSettings = {
        compressionLevel: project.configuration.get(`compressionLevel`),
      }

      manifestNix.push('# This file is generated by running "yarn install" inside your project.')
      manifestNix.push('# It is essentially a version of yarn.lock that Nix can better understand')
      manifestNix.push('# Manual changes WILL be lost - proceed with caution!')
      manifestNix.push('let')
      manifestNix.push('  settings = {')
      for (const key of Object.keys(manifestSettings)) {
        manifestNix.push(`    ${key} = ${JSON.stringify(manifestSettings[key])};`)
      }
      manifestNix.push('  };')
      manifestNix.push('  packages = {')

      function writeDependencies(key: string, dependencies: any[]) {
        if (dependencies.length > 0) {
          manifestNix.push(`      ${key} = {`)
          for (const dep of dependencies) {
            manifestNix.push(`        ${JSON.stringify(dep.name)} = packages.${JSON.stringify(dep.packageManifestId)};`)
          }
          manifestNix.push(`      };`)
        }
      }

      const alphabeticalKeys =
        Object.keys(packageManifest).sort((a, b) => a.localeCompare(b))

      for (const key of alphabeticalKeys) {
        const pkg = packageManifest[key]
        manifestNix.push(`    "${key}" = {`)
        manifestNix.push(`      name = ${JSON.stringify(pkg.name)};`)
        manifestNix.push(`      reference = ${JSON.stringify(pkg.reference)};`)
        if (pkg.isVirtual && pkg.canonicalPackage != null) {
          manifestNix.push(`      canonicalPackage = packages.${JSON.stringify(`${structUtils.stringifyIdent(pkg.canonicalPackage)}@${pkg.canonicalPackage.reference}`)};`)
        }
        if (!pkg.isVirtual) {
          manifestNix.push(`      linkType = ${JSON.stringify(pkg.linkType)};`)
          manifestNix.push(`      outputName = ${JSON.stringify(pkg.outputName)};`)
          if (pkg.outputHash != null)
            manifestNix.push(`      outputHash = ${JSON.stringify(pkg.outputHash)};`)
          if (pkg.outputHashByPlatform && Object.keys(pkg.outputHashByPlatform).length > 0) {
            manifestNix.push(`      outputHashByPlatform = {`)
            for (const outputHashByPlatform of Object.keys(pkg.outputHashByPlatform)) {
              manifestNix.push(`        ${JSON.stringify(outputHashByPlatform)} = ${JSON.stringify(pkg.outputHashByPlatform[outputHashByPlatform])};`)
            }
            manifestNix.push(`      };`)
          }
          if (pkg.src) {
            const storeForbiddenCharacterRegexp = /[^a-zA-Z0-9/+.=_-]/g;
            // Is the src a valid path that can be copied to the store? If not, escape the path by interpolating it as a string, and use `builtins.path` to replace the illegal characters by `__`.
            const nixPathExpr =
              storeForbiddenCharacterRegexp.test(pkg.src)
              ? `builtins.path { name = "${
                path.basename(pkg.src).replace(storeForbiddenCharacterRegexp, "__")
              }"; path = ./\${"${
                pkg.src.replace(/"/g, '\\"')
              }"}; }`
              : pkg.src
            manifestNix.push(`      src = ${nixPathExpr};`)
          }
          if (pkg.shouldBeUnplugged)
            manifestNix.push(`      shouldBeUnplugged = ${pkg.shouldBeUnplugged};`)
          if (pkg.installCondition)
            manifestNix.push(`      installCondition = ${pkg.installCondition};`)

          // other things necessary for recreating lock file that we don't necessarily use
          manifestNix.push(`      flatName = ${JSON.stringify(pkg.flatName)};`)
          manifestNix.push(`      languageName = ${JSON.stringify(pkg.languageName)};`)
          manifestNix.push(`      scope = ${JSON.stringify(pkg.scope)};`)
          manifestNix.push(`      descriptorRange = ${JSON.stringify(pkg.descriptor.range)};`)
          if (pkg.checksum)
            manifestNix.push(`      checksum = ${JSON.stringify(pkg.checksum)};`)

          if (pkg.bin && Object.keys(pkg.bin).length > 0) {
            manifestNix.push(`      bin = {`)
            for (const bin of Object.keys(pkg.bin)) {
              manifestNix.push(`        ${JSON.stringify(bin)} = ${JSON.stringify(pkg.bin[bin])};`)
            }
            manifestNix.push(`      };`)
          }
        }

        writeDependencies('dependencies', pkg.dependencies)
        writeDependencies('devDependencies', pkg.devDependencies)

        if (pkg.packagePeers && pkg.packagePeers.length > 0) {
          manifestNix.push(`      packagePeers = [`)
          for (const peer of pkg.packagePeers) {
            manifestNix.push(`        ${JSON.stringify(peer)}`)
          }
          manifestNix.push(`      ];`)
        }

        manifestNix.push(`    };`)
      }

      manifestNix.push('  };')
      manifestNix.push('in')
      manifestNix.push('{ inherit packages; inherit settings; }')
      manifestNix.push('')

      fs.writeFileSync(path.join(project.cwd, 'yarn-manifest.nix'), manifestNix.join('\n'), 'utf8')
    },
    populateYarnPaths: async (project: Project) => {
      const packageRegistryDataPath = process.env.YARNNIX_PACKAGE_REGISTRY_DATA_PATH
      if (!!packageRegistryDataPath) {
        const packageRegistryData = JSON.parse(fs.readFileSync(packageRegistryDataPath, 'utf8'))
        const packageRegistryPackages: any[] = Object.values(packageRegistryData).filter(pkg => !!pkg?.manifest)

        for (const pkg of packageRegistryPackages) {
          if (pkg.canonicalReference.startsWith('workspace:')) {
            if (pkg.drvPath !== '/dev/null' && pkg.drvPath !== process.env.out) {
              const workspaceCwd = pkg.packageLocation ?? path.join(pkg.drvPath, 'node_modules', pkg.name)
              const workspace = new Workspace(workspaceCwd, { project })
              await workspace.setup()
              await project.addWorkspace(workspace)
            }
          }
        }
      }
    },
  },
  commands: [
    CreateLockFileCommand,
    FetchCommand,
    ConvertToZipCommand,
    GeneratePnpFile,
    MakePathWrappers,
    RunBuildScriptsCommand,
    PackCommand,
  ],
}
