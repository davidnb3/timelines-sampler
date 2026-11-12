/** Ready-made Internet Archive searches for the "Add sources" screen, and the time estimates shown before an import starts. */

export interface IaPreset {
  id: string;
  label: string;
  description: string;
  /** The Internet Archive search. Empty for "your own search". */
  query: string;
  /** What the library calls these recordings; null keeps the Archive's series title (old-time radio). */
  show: string | null;
  topics: string[];
  /** About how long one recording is, for the estimate. */
  avgMinutes: number;
  defaultLimit: number;
  /** Transcribe only this many minutes of each recording; null means all of it. */
  defaultMinutes: number | null;
}

export const IA_PRESETS: readonly IaPreset[] = [
  {
    id: 'otr-scifi',
    label: 'Old-time radio: science fiction',
    description: 'Dimension X, X Minus One and other radio dramas from the 1940s and 50s.',
    query: 'collection:oldtimeradio AND subject:"science fiction" AND mediatype:audio',
    show: null,
    topics: ['sci-fi', 'old-time-radio'],
    avgMinutes: 30,
    defaultLimit: 10,
    defaultMinutes: 10,
  },
  {
    id: 'otr-all',
    label: 'Old-time radio: everything',
    description: 'Radio shows of every kind: mystery, comedy, drama, news.',
    query: 'collection:oldtimeradio AND mediatype:audio',
    show: null,
    topics: ['old-time-radio'],
    avgMinutes: 30,
    defaultLimit: 25,
    defaultMinutes: 10,
  },
  {
    id: 'commercials',
    label: 'Old TV commercials',
    description: 'Vintage American television ads. Short, so a whole recording is quick.',
    query: 'collection:classic_tv_commercials',
    show: 'TV commercials',
    topics: ['commercials'],
    avgMinutes: 1.5,
    defaultLimit: 200,
    defaultMinutes: null,
  },
  {
    id: 'films',
    label: 'Public-domain feature films',
    description: 'Westerns, horror, sci-fi and crime films. Long, so the first minutes of each are enough for sampling.',
    query: 'collection:feature_films',
    show: 'Public-domain film',
    topics: ['film'],
    avgMinutes: 85,
    defaultLimit: 25,
    defaultMinutes: 20,
  },
  {
    id: 'prelinger',
    label: 'Prelinger educational and industrial films',
    description: 'Classroom, civil-defence and company films from the 1930s to 1970s.',
    query: 'collection:prelinger',
    show: 'Prelinger Archives',
    topics: ['film', 'prelinger'],
    avgMinutes: 12,
    defaultLimit: 100,
    defaultMinutes: null,
  },
  {
    id: 'classic-tv',
    label: 'Classic TV shows',
    description: 'Whole episodes of old television series. Very large: start with a few.',
    query: 'collection:classic_tv',
    show: 'Classic TV',
    topics: ['tv'],
    avgMinutes: 30,
    defaultLimit: 10,
    defaultMinutes: 15,
  },
  {
    id: 'custom',
    label: 'Your own search',
    description: 'Any search that works on archive.org, for example: collection:librivoxaudio AND subject:"science fiction".',
    query: '',
    show: null,
    topics: [],
    avgMinutes: 30,
    defaultLimit: 25,
    defaultMinutes: 10,
  },
];

export const MINUTE_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'The whole recording' },
  { value: 5, label: 'The first 5 minutes' },
  { value: 10, label: 'The first 10 minutes' },
  { value: 20, label: 'The first 20 minutes' },
  { value: 30, label: 'The first 30 minutes' },
  { value: 60, label: 'The first hour' },
];

/** Used until the app has measured this computer: whisper on a processor is a little over twice real time. */
export const ASSUMED_SPEED = 2;

export interface Estimate {
  /** Hours of audio that will be transcribed. */
  audioHours: number;
  /** Hours the work will take on this computer. */
  workHours: number;
  /** True when the speed is a guess because nothing was transcribed here yet. */
  assumedSpeed: boolean;
}

export function estimateTranscription(items: number, avgMinutes: number, capMinutes: number | null, speed: number | null): Estimate {
  const perItem = capMinutes === null ? avgMinutes : Math.min(avgMinutes, capMinutes);
  const audioHours = (items * perItem) / 60;
  const s = speed && speed > 0 ? speed : ASSUMED_SPEED;
  return { audioHours, workHours: audioHours / s, assumedSpeed: !speed };
}

/** "20 minutes", "3.5 hours", "4 days". */
export function formatDuration(hours: number): string {
  if (hours < 1 / 60) return 'under a minute';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) {
    const h = Math.round(hours * 10) / 10;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return `${Math.round(hours / 24)} days`;
}

export const formatCount = (n: number): string => n.toLocaleString('en-US');
