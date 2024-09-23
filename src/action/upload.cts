import * as yaml from 'yaml'
import { readFileSync, writeFileSync } from 'fs'

type BulkRequest = import('../app/artifact/upload/signed-url/route').BulkRequest
type BulkResponse = import('../app/artifact/upload/signed-url/route').BulkResponse

type UploadParams = {
  inputs: {
    origin: string
    path: string
    name: string
    'github-token': string
  }
  context: ScriptContext
  glob: Globber
  dependencies: {
    fs: typeof import('fs')
    fsPromises: typeof import('fs/promises')
    mimeTypes: typeof import('mime-types')
    vercelBlobClient: typeof import('@vercel/blob/client')
  }
}

export const actionScript = () => {
  const fnSrc = doupload.toString()//.split(';').join(';\n')
  // eslint-disable-next-line unicorn/template-indent
  return [
    `const cwd = process.cwd()`,
    `process.chdir('tmp/artifact.ci')`,
    `const inputs = \${{ toJson(inputs) }}`,
    `const dependencies = {fs: require('fs/promises'), mime: require('mime-types'), vercelBlob: require('@vercel/blob/client')}`,
    `process.chdir(cwd)`,
    `${fnSrc}`,
    `await doupload({context, glob, inputs, dependencies})`,
  ].join('\n')
}

export async function doupload(
  {context, glob, inputs, dependencies}: UploadParams,
  // context: {github: {ref_name: string; sha: string; run_id: string}},
  // commit: {ref: string; sha: string; actions_run_id: string},
) {
  const cwd = process.cwd()
  process.chdir('tmp/artifact.ci')

  const {mimeTypes, fsPromises: fs, fs: fsSync, vercelBlobClient} = dependencies

  process.chdir(cwd)

  
  const githubToken = inputs['github-token']
  const pathPrefix = '${{ github.repository }}/${{ github.run_id }}/' + inputs.name

  const refName = context.ref.replace('refs/heads/', '')
  console.log({refName, pathPrefix, inputs})
  if (pathPrefix.startsWith('mmkal/artifact.ci') && refName !== 'main') {
    const oldOrigin = inputs.origin
    inputs.origin = `https://artifactci-git-${refName.replaceAll('/', '-')}-mmkals-projects.vercel.app`
    console.log(`uploading to ${inputs.origin} instead of ${oldOrigin} because ref is ${refName}`)
  }

  // console.log({githubToken, inputs, pathPrefix})

  // console.log('lazy url:')
  // console.log(`${inputs.origin}/artifact/browse/${pathPrefix}`)

  Object.assign(global, {
    window: {location: new URL(inputs.origin)}, // create a global `window` object to trick @vercel/blob/client into working. for some reason it refuses to run outside of the browser but it's just a `fetch` wrapper
  })

  const stat = await fs.stat(inputs.path).catch(e => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  const globPattern = stat?.isDirectory() ? `${inputs.path}/**/*` : inputs.path
  // console.log({globPattern})

  if (Math.random()) {
    const globber = await glob.create(globPattern)
    const files = await globber.glob()

    const filesWithPathnames = files.flatMap(f => {
      if (!fsSync.statSync(f).isFile()) return []
      return {
        localPath: f,
        pathname: pathPrefix + f.replace(process.cwd(), ''),
        contentType: mimeTypes.lookup(f) || 'text/plain',
        multipart: false,
      }
    })
    const pathnameToFile = new Map(filesWithPathnames.map(f => [f.pathname, f]))

    const bulkRequest = {
      type: 'bulk',
      files: filesWithPathnames,
      callbackUrl: `${inputs.origin}/artifact/upload/signed-url`,
      clientPayload: {
        githubToken,
        commit: {ref: context.ref, sha: context.sha, actions_run_id: context.runId.toString()},
        context,
      },
    } satisfies BulkRequest

    console.log('inputs.origin::::', inputs.origin)
    console.log('bulkRequest::::', bulkRequest)
    const res = await fetch(`${inputs.origin}/artifact/upload/signed-url`, {
      method: 'POST',
      body: JSON.stringify(bulkRequest),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'artifact.ci/action',
      },
    })
    console.log('res::::', res.status, res.statusText)
    const response = await res.clone().text()
    try {
      const data = (await res.json()) as BulkResponse
      console.log('data::::', data)
      for (const result of data.results) {
        const file = pathnameToFile.get(result.pathname)
        if (!file) throw new Error(`file not found for pathname ${result.pathname}`)
        console.log('uploading file', file.localPath)
        await vercelBlobClient.put(result.pathname, await fs.readFile(file.localPath), {
          access: 'public',
          token: result.clientToken,
          multipart: file.multipart,
          contentType: file.contentType,
        })
        console.log('uploaded file', result.pathname)
      }
      console.log('done')
      return
    } catch (e) {
      console.log('response::::', res.status, response)
      console.log('error::::', e)
      throw e
    }
  }

  const results = {}
  const globber = await glob.create(globPattern)
  for await (const filepath of globber.globGenerator()) {
    const fileStat = await fs.stat(filepath)
    if (fileStat.isDirectory()) continue
    const blobPath = pathPrefix + filepath.replace(process.cwd(), '')
    // console.log(`uploading file ${filepath} to ${blobPath}`)

    const content = await fs.readFile(filepath)
    const result = await vercelBlobClient.upload(blobPath, content, {
      access: 'public', // todo: allow access level override?
      handleUploadUrl: '/artifact/upload/signed-url',
      contentType: mimeTypes.lookup(filepath) || 'text/plain', // todo: allow mime type override?
      clientPayload: JSON.stringify({
        githubToken,
        commit: {
          ref: context.ref,
          sha: context.sha,
          actions_run_id: context.runId,
        },
      }),
    })
    // console.log(`uploaded file ${filepath} to ${blobPath}`, result)
    results[blobPath] = result
  }

  if (Object.keys(results).length === 0) {
    throw new Error('no files uploaded')
  }

  console.log(`View your files here:`)

  Object.keys(results).forEach(blobPath => {
    console.log(`${inputs.origin}/artifact/blob/${blobPath}`)
  })
}

export type Globber = {
  create: (pattern: string) => Promise<{
    globGenerator: () => AsyncGenerator<string, void, unknown>
    glob: () => Promise<string[]>
  }>
}

/* eslint-disable unicorn/numeric-separators-style */
export type ScriptContext = typeof _exampleScriptContext
const _exampleScriptContext = {
  payload: {} as Record<string, unknown>,
  eventName: 'push',
  sha: 'f7767c385252ae7d911923a4a8b29aac4be7cec6',
  ref: 'refs/heads/bulk',
  workflow: 'Recipes',
  action: '__self',
  actor: 'mmkal',
  job: 'mocha',
  runNumber: 31,
  runId: 10963802899,
  apiUrl: 'https://api.github.com',
  serverUrl: 'https://github.com',
  graphqlUrl: 'https://api.github.com/graphql',
}

if (require.main === module) {
  const actionPath = process.cwd() + '/upload/action.yml'
  const yml = readFileSync(actionPath, 'utf8')
  const parsed = yaml.parse(yml)
  const scriptStep = parsed.runs.steps.find(s => s.name === 'upload blob')
  scriptStep.with.script = actionScript()
  writeFileSync(actionPath, yaml.stringify(parsed, {lineWidth: 0}))
}
