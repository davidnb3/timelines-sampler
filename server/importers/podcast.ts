import type { DatabaseSync } from 'node:sqlite';
import type { ItemSpec, Processor } from '../jobs.ts';
import { episodesByFeed, feedById, type PiEpisode } from '../sources/podcastIndex.ts';
import { clampInt, cleanTopics, maxSecondsFor, transcribeAndSave } from './common.ts';

export interface PodcastParams {
  feedId: number;
  /** The latest episodes to import. */
  episodes: number;
  maxMinutes: number | null;
  topics: string[];
  feedTitle: string;
  link: string | null;
  categories: string[];
}

export function parsePodcastParams(body: Record<string, unknown>): Pick<PodcastParams, 'feedId' | 'episodes' | 'maxMinutes' | 'topics'> {
  const feedId = Number(body.feedId);
  if (!Number.isInteger(feedId) || feedId <= 0) throw new Error('Pick a podcast first');
  return {
    feedId,
    episodes: clampInt(body.episodes, 5, 1, 500),
    maxMinutes: body.maxMinutes === null || body.maxMinutes === undefined || body.maxMinutes === '' ? null : clampInt(body.maxMinutes, 10, 1, 600),
    topics: cleanTopics(body.topics),
  };
}

export async function planPodcast(p: Pick<PodcastParams, 'feedId' | 'episodes'>): Promise<{ feed: { title: string; link: string | null; categories: string[] }; items: ItemSpec[] }> {
  const feed = await feedById(p.feedId);
  const episodes = (await episodesByFeed(p.feedId, p.episodes)).filter((e) => e.enclosureUrl);
  if (!episodes.length) throw new Error('This podcast has no episodes with audio');
  return {
    feed: { title: feed.title, link: feed.link, categories: feed.categories },
    items: episodes.map((e) => ({ label: e.title, params: { episode: e as unknown as Record<string, unknown> } })),
  };
}

export function podcastProcessor(conn: DatabaseSync): Processor {
  return {
    async run(item, ctx, jobParams) {
      const p = jobParams as unknown as PodcastParams;
      const ep = item.params.episode as unknown as PiEpisode;
      return transcribeAndSave(
        conn,
        {
          source: 'podcast',
          extId: `pi:${ep.id}`,
          show: p.feedTitle,
          title: ep.title,
          date: ep.datePublished ? new Date(ep.datePublished * 1000).toISOString().slice(0, 10) : null,
          audioUrl: ep.enclosureUrl,
          pageUrl: ep.link ?? p.link,
          durationMs: ep.duration ? ep.duration * 1000 : null,
          rawTopics: p.categories,
          topics: p.topics,
        },
        { maxSeconds: maxSecondsFor(p.maxMinutes), signal: ctx.signal, onStage: ctx.progress },
      );
    },
  };
}
