import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickWhisperAsset } from './setup.ts';

const names = [
  'whisper-bin-ubuntu-x64.tar.gz',
  'whisper-bin-win-cpu-arm64.zip',
  'whisper-bin-win-cuda-11.8.0-x64.zip',
  'whisper-bin-win-cuda-12.4.0-x64.zip',
  'whisper-bin-win-cuda-13.4-arm64.zip',
  'whisper-bin-Win32.zip',
  'whisper-bin-x64.zip',
];

describe('pickWhisperAsset', () => {
  it('takes the plain 64-bit build for the processor', () => {
    assert.equal(pickWhisperAsset(names, 'cpu'), 'whisper-bin-x64.zip');
  });
  it('takes the newest CUDA 12 build for an NVIDIA card, not the ARM one', () => {
    assert.equal(pickWhisperAsset(names, 'cuda'), 'whisper-bin-win-cuda-12.4.0-x64.zip');
  });
  it('knows the older cublas file names', () => {
    assert.equal(pickWhisperAsset(['whisper-cublas-11.8.0-bin-x64.zip', 'whisper-cublas-12.4.0-bin-x64.zip', 'whisper-bin-x64.zip'], 'cuda'), 'whisper-cublas-12.4.0-bin-x64.zip');
  });
  it('returns null when the release has no Windows build', () => {
    assert.equal(pickWhisperAsset(['whisper-bin-ubuntu-x64.tar.gz'], 'cpu'), null);
    assert.equal(pickWhisperAsset(['whisper-bin-x64.zip'], 'cuda'), null);
  });
});
