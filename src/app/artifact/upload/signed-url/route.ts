import {handleUpload, type HandleUploadBody} from '@vercel/blob/client'
import {lookup as mimeLookup} from 'mime-types'
import {NextResponse} from 'next/server'
import * as path from 'path'
import {ARTIFACT_BLOB_PREFIX} from '../../view/[...slug]/route'
import {client, Id, sql} from '~/db'
import {getJobsWithStatuses as loadWorkflowJobStatuses} from '~/github/job-statuses'
import {
  BulkRequest,
  BulkResponse,
  BulkResponseItem,
  ClientPayload,
  GithubActionsContext,
  tokenPayloadCodec,
} from '~/types'

export const maxDuration = 59

class ResponseError extends Error {
  constructor(readonly response: NextResponse<object>) {
    super()
  }
}

function buildStoragePathname(ctx: GithubActionsContext, localPath: string) {
  return path.join(ctx.repository, ctx.runId.toString(), ctx.runAttempt.toString(), ctx.job, localPath)
}

const getEntrypoints = (pathnames: string[], requestedEntrypoints: string[] = []) => {
  let bestEntrypoint: string | undefined = pathnames[0]

  const aliases = pathnames.map(pathname => {
    bestEntrypoint = bestEntrypoint ?? pathname
    const paths: string[] = [pathname]

    if (pathname.endsWith('.html')) {
      const shortened = pathname.slice(0, -5)
      if (!bestEntrypoint || shortened.length < bestEntrypoint.length) {
        bestEntrypoint = shortened
      }
      paths.push(path.dirname(pathname))
    }

    if (pathname.endsWith('/index.html')) {
      const shortened = path.dirname(pathname)
      if (!bestEntrypoint || shortened.length < bestEntrypoint.length) {
        bestEntrypoint = shortened
      }
      paths.push(path.dirname(pathname))
    }

    return {original: pathname, paths}
  })

  const set = new Set(aliases.flatMap(a => a.paths))

  const entrypoints = requestedEntrypoints.filter(pathname => set.has(pathname))
  if (entrypoints.length === 0 && bestEntrypoint) {
    entrypoints.push(bestEntrypoint)
  }

  return {aliases, entrypoints}
}

const allowedContentTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/xml',
  'application/pdf',
  'application/zip',
  'font/woff2',
  // todo(paid): only allow a subset for free users?
])

const isAllowedContentType = (mimeType: string) => {
  if (allowedContentTypes.has(mimeType)) return true

  console.warn(`New content type - ${mimeType} - pls add to allowed content types. Allowing anyway for now`)
  return true
}

const getMimeType = (pathname: string) => mimeLookup(pathname) || 'text/plain'

export async function POST(request: Request): Promise<NextResponse> {
  const requestBody = (await request.json()) as HandleUploadBody | BulkRequest
  console.log(
    JSON.stringify({url: request.url, body: requestBody, headers: Object.fromEntries(request.headers)}, null, 2),
  )

  if (requestBody.type === 'bulk') {
    const parseResult = BulkRequest.safeParse(requestBody)
    if (!parseResult.success) {
      return NextResponse.json({error: 'Invalid bulk request: ' + parseResult.error.message}, {status: 400})
    }

    const body = parseResult.data

    const ctx = body.clientPayload.context
    const [owner, repo] = ctx.repository.split('/')
    const htmlUrl = `${ctx.githubOrigin}/${owner}/${repo}`

    const jobsResult = await loadWorkflowJobStatuses(ctx, body.clientPayload)
    if (jobsResult.outcome === 'api_failure') {
      const message = `Failed to load job statuses for ${ctx.job}. Did you pass the correct "githubToken"?`
      return NextResponse.json({message, error: jobsResult.response}, {status: 400})
    }
    if (jobsResult.outcome === 'fetch_failure') {
      const message = `Failed to load job statuses for ${ctx.job} on ${htmlUrl}. If this is a private repo, you may need to pass a "githubToken" in the client payload.`
      return NextResponse.json({message, error: jobsResult.response.statusText}, {status: jobsResult.response.status})
    }
    if (jobsResult.outcome !== 'success') {
      const message = `Unexpected outcome ${jobsResult.outcome} when getting job statuses for ${ctx.job} on ${htmlUrl}.`
      return NextResponse.json({message}, {status: 500})
    }

    const {jobs} = jobsResult
    console.log('loadWorkflowJobStatuses result', jobs)

    const matchingJob = jobsResult.jobs[ctx.job]

    if (!matchingJob || matchingJob.status !== 'running') {
      const message = `Job ${ctx.job} not found or was not running. Job info: ${JSON.stringify(jobs, null, 2)}`
      return NextResponse.json({message}, {status: 404})
    }

    const insertedUploadRequest = await client.maybeOne(
      sql<queries.UploadRequest>`
        with repo as (
          insert into repos (owner, name, html_url)
          values (${owner}, ${repo}, ${htmlUrl})
          on conflict (html_url) do update set updated_at = current_timestamp
          returning *
        )
        insert into upload_requests (repo_id, ref, sha, actions_run_id, actions_run_attempt, job_id)
        select repo.id, ${ctx.ref}, ${ctx.sha}, ${ctx.runId}, ${ctx.runAttempt}, ${ctx.job}
        from repo
        where (
          select count(*)
          from upload_requests existing
          where
            existing.repo_id = repo.id
            and existing.actions_run_id = ${ctx.runId}
            and existing.actions_run_attempt = ${ctx.runAttempt}
            and existing.job_id = ${ctx.job}
        ) < 1
        returning upload_requests.*
      `,
    )

    console.log('uploadRequest', insertedUploadRequest)

    if (!insertedUploadRequest) {
      const message = `Upload request not created, this may be due to rate limiting on repo ${htmlUrl} / ${ctx.runId}.`
      return NextResponse.json({message}, {status: 429})
    }

    try {
      const results = await Promise.all(
        body.files.map(async ({localPath, multipart}): Promise<BulkResponseItem> => {
          const storagePathname = buildStoragePathname(ctx, localPath)
          const uploadResponse = await handleUploadSingle(
            request,
            {
              type: 'blob.generate-client-token',
              payload: {
                callbackUrl: body.callbackUrl,
                clientPayload: JSON.stringify(body.clientPayload),
                pathname: storagePathname,
                multipart,
              },
            },
            insertedUploadRequest.id,
          )
          const viewUrl = new URL(request.url).origin + ARTIFACT_BLOB_PREFIX + storagePathname
          return {
            localPath,
            viewUrl,
            pathname: storagePathname,
            clientToken: uploadResponse.clientToken,
            contentType: mimeLookup(localPath) || 'text/plain',
          }
        }),
      )
      console.log('bulk results for ' + body.clientPayload.context.job, results)
      const {entrypoints} = getEntrypoints(results.map(r => r.viewUrl))

      return NextResponse.json({results, entrypoints} satisfies BulkResponse)
    } catch (error) {
      if (error instanceof ResponseError) {
        console.log(error.response.status + ' handling upload', error)
        return error.response
      }
      console.error('Error handling upload', error)
      return NextResponse.json({error: 'Error handling upload: ' + String(error)}, {status: 500})
    }
  }

  try {
    const jsonResponse = await handleUploadSingle(request, requestBody, null)

    return NextResponse.json(jsonResponse)
  } catch (error) {
    if (error instanceof ResponseError) {
      console.log(
        'Sending error response',
        JSON.stringify(
          {
            request: {url: request.url, body: (await request.clone().json()) as {}},
            status: error.response.status,
            response: (await error.response.clone().json()) as {},
          },
          null,
          2,
        ),
      )
      return error.response
    }
    console.error('Error handling upload', error)
    return NextResponse.json(
      {error: 'Error handling upload: ' + String(error)},
      {status: 500}, // The webhook will retry 5 times waiting for a 200
    )
  }
}

const handleUploadSingle = async <Type extends HandleUploadBody['type']>(
  request: Request,
  body: Extract<HandleUploadBody, {type: Type}>,
  uploadRequestId: Id<'upload_requests'> | null,
) => {
  const result = await handleUpload({
    body,
    request,
    onBeforeGenerateToken: async (pathname, payload) => {
      if (!uploadRequestId) {
        const message = 'Unauthorized - no upload request specified in client payload'
        throw new ResponseError(NextResponse.json({message}, {status: 401}))
      }

      const mimeType = getMimeType(pathname)

      if (!isAllowedContentType(mimeType)) {
        throw new ResponseError(
          NextResponse.json(
            {message: `Unsupported content type for ${pathname} - ${mimeType}`}, //
            {status: 400},
          ),
        )
      }

      const parsedClientPayload = ClientPayload.safeParse(typeof payload === 'string' ? JSON.parse(payload) : payload)

      if (!parsedClientPayload.success) {
        throw new ResponseError(
          NextResponse.json(
            {message: 'Invalid client payload', error: parsedClientPayload.error}, //
            {status: 400},
          ),
        )
      }

      return {
        allowedContentTypes: [mimeType],
        addRandomSuffix: true,
        tokenPayload: tokenPayloadCodec.stringify({
          uploadRequestId,
          ...parsedClientPayload.data.commit,
        }),
      }
    },
    onUploadCompleted: async ({blob, tokenPayload}) => {
      const payload = tokenPayloadCodec.parse(tokenPayload || '{}')
      if (!payload?.uploadRequestId) {
        throw new ResponseError(
          NextResponse.json(
            {message: 'Unauthorized - no repo specified in client payload'}, //
            {status: 401},
          ),
        )
      }
      const {aliases} = getEntrypoints([blob.pathname])

      const mimeType = getMimeType(blob.pathname)
      const uploads = await client.many(
        sql<queries.Upload>`
          insert into uploads (pathname, mime_type, blob_url, upload_request_id)
          select pathname, mime_type, blob_url, upload_request_id
          from jsonb_populate_recordset(
            null::uploads,
            ${JSON.stringify(
              aliases.map(pathname => ({
                pathname,
                mime_type: mimeType,
                blob_url: blob.url,
                upload_request_id: payload.uploadRequestId,
              })),
            )}
          )
          returning *
        `,
      )

      console.log('upload inserted:', uploads)

      console.log('blob upload completed', blob, tokenPayload)
    },
  })

  return result as Extract<typeof result, {type: Type}>
}

export declare namespace queries {
  // Generated by @pgkit/typegen

  /** - query: `with repo as ( insert into repos (owner,... [truncated] ... = $11 ) < 1 returning upload_requests.*` */
  export interface UploadRequest {
    /** column: `public.upload_requests.id`, not null: `true`, regtype: `prefixed_ksuid` */
    id: import('~/db').Id<'upload_requests'>

    /** column: `public.upload_requests.repo_id`, not null: `true`, regtype: `prefixed_ksuid` */
    repo_id: string

    /** column: `public.upload_requests.ref`, not null: `true`, regtype: `text` */
    ref: string

    /** column: `public.upload_requests.sha`, not null: `true`, regtype: `text` */
    sha: string

    /** column: `public.upload_requests.actions_run_id`, not null: `true`, regtype: `bigint` */
    actions_run_id: number

    /** column: `public.upload_requests.actions_run_attempt`, not null: `true`, regtype: `integer` */
    actions_run_attempt: number

    /** column: `public.upload_requests.created_at`, not null: `true`, regtype: `timestamp with time zone` */
    created_at: Date

    /** column: `public.upload_requests.updated_at`, not null: `true`, regtype: `timestamp with time zone` */
    updated_at: Date

    /** column: `public.upload_requests.job_id`, not null: `true`, regtype: `text` */
    job_id: string
  }

  /** - query: `insert into uploads (pathname, mime_type... [truncated] ...cordset( null::uploads, $1 ) returning *` */
  export interface Upload {
    /** column: `public.uploads.id`, not null: `true`, regtype: `prefixed_ksuid` */
    id: import('~/db').Id<'uploads'>

    /**
     * looks like `/[owner]/[repo]/[runId]/[...filepath]`
     *
     * column: `public.uploads.pathname`, not null: `true`, regtype: `text`
     */
    pathname: string

    /** column: `public.uploads.mime_type`, not null: `true`, regtype: `text` */
    mime_type: string

    /** column: `public.uploads.blob_url`, not null: `true`, regtype: `text` */
    blob_url: string

    /** column: `public.uploads.created_at`, not null: `true`, regtype: `timestamp with time zone` */
    created_at: Date

    /** column: `public.uploads.updated_at`, not null: `true`, regtype: `timestamp with time zone` */
    updated_at: Date

    /** column: `public.uploads.upload_request_id`, not null: `true`, regtype: `prefixed_ksuid` */
    upload_request_id: string
  }
}
