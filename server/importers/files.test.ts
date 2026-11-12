import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expandPaths, fileTitle, findSubtitles } from './files.ts';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-files-'));
  for (const f of ['a.mp3', 'b.WAV', 'notes.txt', '.hidden.mp3', 'sub/c.mp4', 'sub/deeper/d.flac', 'sub/cover.jpg', '.git/e.mp3', 'ep10.mp3', 'ep2.mp3']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

describe('expandPaths', () => {
  it('finds audio and video in a folder, skipping other files and hidden ones', () => {
    const root = tree();
    const { files, truncated } = expandPaths([root]);
    assert.deepEqual(files.map((f) => path.relative(root, f)), ['a.mp3', 'b.WAV', 'ep2.mp3', 'ep10.mp3', path.join('sub', 'c.mp4'), path.join('sub', 'deeper', 'd.flac')]);
    assert.equal(truncated, false);
  });

  it('takes single files as they are and ignores ones that are not media or do not exist', () => {
    const root = tree();
    const { files } = expandPaths([path.join(root, 'a.mp3'), path.join(root, 'notes.txt'), path.join(root, 'missing.mp3'), path.join(root, 'a.mp3')]);
    assert.deepEqual(files, [path.join(root, 'a.mp3')]);
  });

  it('stops at the limit and says so', () => {
    const { files, truncated } = expandPaths([tree()], 3);
    assert.equal(files.length, 3);
    assert.equal(truncated, true);
  });
});

describe('findSubtitles', () => {
  it('finds a subtitle file with the same name', () => {
    const root = tree();
    assert.equal(findSubtitles(path.join(root, 'a.mp3')), null);
    fs.writeFileSync(path.join(root, 'a.en.vtt'), 'WEBVTT');
    assert.equal(findSubtitles(path.join(root, 'a.mp3')), path.join(root, 'a.en.vtt'));
    fs.writeFileSync(path.join(root, 'a.srt'), '');
    assert.equal(findSubtitles(path.join(root, 'a.mp3')), path.join(root, 'a.srt'));
  });
});

describe('fileTitle', () => {
  it('drops the folder and extension and turns underscores into spaces', () => {
    assert.equal(fileTitle('/music/old_radio/Dimension_X_1950.mp3'), 'Dimension X 1950');
  });
});
