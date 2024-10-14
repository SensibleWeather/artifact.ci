import {type PathParams} from './params'
import {auth, checkCanAccess, getInstallationOctokit} from '~/auth'
import {client, sql} from '~/db'
import {logger} from '~/tag-logger'

export const searchArtifacts = async (params: Partial<PathParams>, {offset = 0, limit = 100} = {}) => {
  const session = await auth()
  if (!session?.user.github_login) return Object.assign([], {code: 'not_logged_in'} as const)
  const owner = params.owner || session?.user.github_login

  const artifacts = await client.any(sql<queries.Artifact>`
    select
      a.id as artifact_id,
      a.name,
      repos.owner,
      repos.name as repo,
      ins.github_id as installation_github_id,
      array_agg(ai.type || '/' || ai.value) as aggregated_identifiers
    from artifacts a
    join artifact_identifiers ai on ai.artifact_id = a.id
    join repos on repos.id = a.repo_id
    join github_installations ins on ins.id = a.installation_id
    where
      owner = ${owner}
      and repos.name = ${params.repo || sql`repos.name`}
      and ai.type = ${params.aliasType || sql`ai.type`}
      and ai.value = ${params.identifier || sql`ai.value`}
      and a.name = ${params.artifactName || sql`a.name`}
    group by
      a.id,
      a.name,
      repos.owner,
      repos.name,
      ins.github_id
    order by max(a.created_at) desc, a.name
    limit ${limit} offset ${offset}
  `)
  if (!artifacts.length) return []

  const octokit = await getInstallationOctokit(artifacts[0].installation_github_id)

  const dedupedRepos = Object.values(Object.fromEntries(artifacts.map(r => [`${r.owner}/${r.repo}`, r])))
  for (const repo of dedupedRepos) {
    const canAccess = await checkCanAccess(octokit, {
      ...repo,
      username: session.user.github_login,
      artifactId: repo.artifact_id,
    })
    if (!canAccess.canAccess) {
      logger.warn({canAccess}, 'searchArtifacts: checkCanAccess failed')
      return []
    }
  }

  return artifacts.map(a => {
    const priority: Record<string, number> = {run: 0, commit: 1, branch: 2}
    const pathParams: PathParams[] = a
      .aggregated_identifiers!.map(id => {
        const [aliasType, identifier] = id.split('/')
        return {owner: a.owner, repo: a.repo, aliasType, identifier, artifactName: a.name}
      })
      .sort((...items) => {
        const [left, right] = items.map(p => priority[p.aliasType] ?? Number.POSITIVE_INFINITY)
        return left - right
      })
    return {
      artifactId: a.artifact_id,
      name: a.name,
      pathParams,
      label: params.repo ? '' : `${a.owner}/${a.repo}`,
      installationId: a.installation_github_id,
    }
  })
}

export declare namespace queries {
  // Generated by @pgkit/typegen

  /** - query: `select a.id as artifact_id, a.name, repo... [truncated] ...ated_at) desc, a.name limit $6 offset $7` */
  export interface Artifact {
    /** column: `public.artifacts.id`, not null: `true`, regtype: `prefixed_ksuid` */
    artifact_id: import('~/db').Id<'artifacts'>

    /** column: `public.artifacts.name`, not null: `true`, regtype: `text` */
    name: string

    /** column: `public.repos.owner`, not null: `true`, regtype: `text` */
    owner: string

    /** column: `public.repos.name`, not null: `true`, regtype: `text` */
    repo: string

    /** column: `public.github_installations.github_id`, not null: `true`, regtype: `bigint` */
    installation_github_id: number

    /** regtype: `text[]` */
    aggregated_identifiers: string[] | null
  }
}
