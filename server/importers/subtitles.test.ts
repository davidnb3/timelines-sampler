import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSubtitles } from './subtitles.ts';

describe('parseSubtitles', () => {
  it('reads SRT cues with their numbers and comma milliseconds', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nHow are you?\r\nFine.\r\n';
    assert.deepEqual(parseSubtitles(srt), [
      { startMs: 1000, endMs: 3500, text: 'Hello there.' },
      { startMs: 4000, endMs: 6000, text: 'How are you? Fine.' },
    ]);
  });

  it('reads WebVTT with a header, short times and cue settings', () => {
    const vtt = 'WEBVTT\n\nNOTE a comment\n\nintro\n01:02.500 --> 01:04.000 align:start position:0%\n<v Anna>Good <i>evening</i></v>\n\n1:00:05.000 --> 1:00:07.250\nLate &amp; loud\n';
    assert.deepEqual(parseSubtitles(vtt), [
      { startMs: 62500, endMs: 64000, text: 'Good evening' },
      { startMs: 3605000, endMs: 3607250, text: 'Late & loud' },
    ]);
  });

  it('drops empty cues, sound tags and cues that end before they start', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n[MUSIC]\n\n2\n00:00:03,000 --> 00:00:02,000\nbackwards\n\n3\n00:00:05,000 --> 00:00:06,000\n\n\n4\n00:00:07,000 --> 00:00:08,000\n♪ la la ♪\n\n5\n00:00:09,000 --> 00:00:10,000\nReal words\n';
    assert.deepEqual(parseSubtitles(srt), [{ startMs: 9000, endMs: 10000, text: 'Real words' }]);
  });

  it('puts cues in time order and ignores a byte order mark', () => {
    const srt = '﻿1\n00:00:09,000 --> 00:00:10,000\nsecond\n\n2\n00:00:01,000 --> 00:00:02,000\nfirst\n';
    assert.deepEqual(parseSubtitles(srt).map((s) => s.text), ['first', 'second']);
  });
});
