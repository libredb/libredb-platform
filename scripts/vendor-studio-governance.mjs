// Vendors Studio's governance conformance files into tests/fixtures/governance/.
// This script is the only way those files change; nobody edits them by hand.
//
//   node scripts/vendor-studio-governance.mjs 1.2.3
//     downloads the files from the Studio release tag 1.2.3 on GitHub. Studio tags its releases
//     with bare semver, and a tag with a leading v, such as v1.2.3, is downloaded the same way.
//   STUDIO_REPO=../libredb-studio node scripts/vendor-studio-governance.mjs git:<ref>
//     reads the files from a commit of a local Studio clone, for a build cut before its release
//     tag exists, and records the build as git:<full sha>.
//
// For each file it writes the file and a `<name>.sha256` pin in sha256sum format, and it writes the
// release tag as given, or git:<full sha>, into STUDIO_TAG, which the installer's release check
// compares with the Studio image it pins.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'tests', 'fixtures', 'governance')
const RAW_BASE = 'https://raw.githubusercontent.com/libredb/libredb-studio/refs/tags'

// The paths Studio publishes, in the order of the manifest's conformanceFiles.
const STUDIO_FILES = [
  'docs/GOVERNANCE.md',
  'tests/fixtures/governance/contract-v1.json',
  'tests/fixtures/governance/lsb1-vectors.json',
]

const RELEASE_TAG = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function usage() {
  return 'Usage: node scripts/vendor-studio-governance.mjs <X.Y.Z | vX.Y.Z | git:<ref>>'
}

/** Returns the recorded tag and a reader of each Studio path at that tag. */
function resolveSource(arg, env) {
  if (RELEASE_TAG.test(arg)) {
    return {
      tag: arg,
      async read(file) {
        const url = `${RAW_BASE}/${arg}/${file}`
        const response = await fetch(url)
        if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`)
        return Buffer.from(await response.arrayBuffer())
      },
    }
  }
  if (arg.startsWith('git:') && arg.length > 'git:'.length) {
    const repo = env.STUDIO_REPO
    if (!repo) throw new Error('A git:<ref> build needs STUDIO_REPO, the path of a local libredb-studio clone.')
    const git = (args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })
    const sha = git(['rev-parse', '--verify', '--end-of-options', `${arg.slice('git:'.length)}^{commit}`]).toString().trim()
    return {
      tag: `git:${sha}`,
      async read(file) {
        return git(['show', `${sha}:${file}`])
      },
    }
  }
  throw new Error(`"${arg}" is neither a release tag X.Y.Z or vX.Y.Z nor git:<ref>. ${usage()}`)
}

async function main(argv, env) {
  if (argv.length !== 1) throw new Error(usage())
  const source = resolveSource(argv[0], env)

  // Read everything before writing anything, so a failed download leaves the vendored set intact.
  const files = []
  for (const file of STUDIO_FILES) files.push({ name: path.posix.basename(file), content: await source.read(file) })

  const manifest = JSON.parse(files.find((file) => file.name === 'contract-v1.json').content.toString('utf8'))
  if (JSON.stringify(manifest.conformanceFiles) !== JSON.stringify(STUDIO_FILES)) {
    throw new Error(
      `Studio ${source.tag} publishes the conformance files ${JSON.stringify(manifest.conformanceFiles)}, ` +
        `but this script vendors ${JSON.stringify(STUDIO_FILES)}.`,
    )
  }

  for (const { name, content } of files) {
    const digest = createHash('sha256').update(content).digest('hex')
    writeFileSync(path.join(TARGET, name), content)
    writeFileSync(path.join(TARGET, `${name}.sha256`), `${digest}  ${name}\n`)
  }
  writeFileSync(path.join(TARGET, 'STUDIO_TAG'), `${source.tag}\n`)
  console.log(`Vendored Studio ${source.tag} into ${path.relative(ROOT, TARGET)}`)
}

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
