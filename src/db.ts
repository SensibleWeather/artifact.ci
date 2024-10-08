import {createClient} from 'pgkit/client'
import {z} from 'zod'
import config from '../pgkit.config'
import {logger} from './tag-logger'

export const client = createClient(config.client.connectionString, {
  pgpOptions: {
    initialize: {
      noWarnings: new Date(process.env.SILENCE_PG_PROMISE_WARNINGS_UNTIL || 0) > new Date(),
    },
  },
  wrapQueryFn: queryFn => {
    return async query => {
      const result = await queryFn(query)
      logger.debug('queryResult', query.name, {rowCount: result.rowCount})
      return result
    }
  },
})

export {sql} from 'pgkit/client'

/** Branded id column type */
export type Id<T extends string> = string & {id_for?: T}

// could consider checking the prefix here, but gets messy with singular vs plural etc.
// and this is more of a DX helper than a runtime integrity check
export const Id = <T extends string>(_brand: T) => z.string() as z.ZodType<Id<T>>
