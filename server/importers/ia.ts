import type { DatabaseSync } from 'node:sqlite';
import type { ItemSpec, Processor } from '../jobs.ts';
import { dateFromName, titleFromName } from '../naming.ts';
import { downloadUrl, detailsUrl, itemFiles, pickPlayable, searchItems } from '../sources/internetArchive.ts';
import { clampInt, cleanTopics, maxSecondsFor, transcribeAndSave } from './common.ts';

export interface IaParams {
  /** An Internet Archive search, for example `collection:classic_tv_commercials`. */
  query: string;
  /** How many items to import (the most downloaded first). */
  limit: number;
  /** Recordings per item. */
  perItem: number;
  /** Transcribe only this much of each recording; null means all of it. */
  maxMinutes: number | null;
  topics: string[];
  /** A label for the library; without it the item title names the series (old-time radio). */
  show: string | null;
}

export function parseIaParams(body: Record<string, unknown>): IaParams {
  const query = String(body.query ?? '').trim();
  if (!query) throw new Error('Enter an Internet Archive search or pick a collection');
  return {
    query,
    limit: clampInt(body.limit, 50, 1, 2000),
    perItem: clampInt(body.perItem, 1, 1, 20),
    maxMinutes: body.maxMinutes === null || body.maxMinutes === undefined || body.maxMinutes === '' ? null : clampInt(body.maxMinutes, 10, 1, 600),
    topics: cleanTopics(body.topics),
    show: body.show ? String(body.show).slice(0, 80) : null,
  };
}

export async function planIa(p: IaParams): Promise<ItemSpec[]> {
  const found = await searchItems(p.query, p.limit);
  if (!found.length) throw new Error('The Internet Archive found nothing for that search');
  return found.map((it) => ({
    label: it.title,
    params: { identifier: it.identifier, title: it.title, date: it.date, subjects: it.subjects },
  }));
}

export function iaProcessor(conn: DatabaseSync): Processor {
  return {
    async run(item, ctx, jobParams) {
      const p = jobParams as unknown as IaParams;
      const { identifier, title, date, subjects } = item.params as { identifier: string; title: string; date: string | null; subjects: string[] };
      ctx.progress('Looking for the audio');
      const files = pickPlayable(await itemFiles(identifier)).slice(0, p.perItem);
      if (!files.length) throw new Error('No audio or video file in this item');
      let done = 0;
      for (const f of files) {
        const result = await transcribeAndSave(
          conn,
          {
            source: 'ia',
            extId: `ia:${identifier}/${f.name}`,
            // Without a label the item title names the series: the uploader is usually a collector group.
            show: p.show ?? title.replace(/\s+-\s+Single Episodes$/i, ''),
            title: p.show || files.length === 1 ? title : titleFromName(f.name),
            // A broadcast date in the file name beats the upload date the Archive records.
            date: dateFromName(f.name) ?? date,
            audioUrl: downloadUrl(identifier, f.name),
            pageUrl: detailsUrl(identifier),
            durationMs: null,
            rawTopics: subjects,
            topics: p.topics,
          },
          { maxSeconds: maxSecondsFor(p.maxMinutes), signal: ctx.signal, onStage: ctx.progress },
        );
        if (result === 'done') done++;
      }
      return done ? 'done' : 'skipped';
    },
  };
}
