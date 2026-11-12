import type { DatabaseSync } from 'node:sqlite';
import type { ItemSpec, Processor } from '../jobs.ts';
import { cleanTopics, maxSecondsFor } from './common.ts';
import { filesProcessor, parseFilesParams, planFiles } from './files.ts';
import { filmsInfo, filmsProcessor, planFilms } from './films.ts';
import { iaProcessor, parseIaParams, planIa } from './ia.ts';
import { parsePodcastParams, planPodcast, podcastProcessor } from './podcast.ts';

export const JOB_KINDS = ['ia', 'podcast', 'files', 'films'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function buildProcessors(conn: DatabaseSync): Record<string, Processor> {
  return { ia: iaProcessor(conn), podcast: podcastProcessor(conn), files: filesProcessor(conn), films: filmsProcessor(conn) };
}

export interface PlannedJob {
  title: string;
  params: Record<string, unknown>;
  items: ItemSpec[];
  /** A sentence to show the user, such as "Only the first 5000 files were taken". */
  note?: string;
}

/** Validates what the user asked for and works out the items of the job. Throws a message fit for the user. */
export async function planJob(kind: string, body: Record<string, unknown>): Promise<PlannedJob> {
  switch (kind) {
    case 'ia': {
      const p = parseIaParams(body);
      const items = await planIa(p);
      return { title: String(body.title ?? '').trim().slice(0, 80) || `Internet Archive: ${p.query.slice(0, 50)}`, params: { ...p }, items };
    }
    case 'podcast': {
      const p = parsePodcastParams(body);
      const { feed, items } = await planPodcast(p);
      return { title: feed.title, params: { ...p, feedTitle: feed.title, link: feed.link, categories: feed.categories }, items };
    }
    case 'files': {
      const p = parseFilesParams(body);
      const { items, truncated } = planFiles(p.paths);
      return {
        title: items.length === 1 ? items[0]!.label : `${items.length} files`,
        params: { topics: p.topics, maxMinutes: p.maxMinutes },
        items,
        note: truncated ? 'Only the first 5000 files were taken.' : undefined,
      };
    }
    case 'films': {
      const info = filmsInfo();
      return { title: `Old films (${info.films} films)`, params: {}, items: planFilms() };
    }
    default:
      throw new Error(`Unknown kind of import "${kind}"`);
  }
}

export { cleanTopics, maxSecondsFor };
