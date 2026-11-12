import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRequest } from './guard.ts';

const cfg = { token: 'secret-token', port: 4747 };
const ok = { host: '127.0.0.1:4747', cookie: 'bt=secret-token', url: '/api/search?q=x' };

describe('checkRequest', () => {
  it('lets everything through when no token is set', () => {
    assert.equal(checkRequest({ token: null, port: 4747 }, { host: 'evil.example', cookie: undefined, url: '/' }).allow, true);
  });

  it('lets a request with the cookie through', () => {
    assert.equal(checkRequest(cfg, ok).allow, true);
    assert.equal(checkRequest(cfg, { ...ok, host: 'localhost:4747' }).allow, true);
    assert.equal(checkRequest(cfg, { ...ok, cookie: 'a=1; bt=secret-token; b=2' }).allow, true);
  });

  it('refuses a request without the cookie or with another one', () => {
    assert.equal(checkRequest(cfg, { ...ok, cookie: undefined }).status, 401);
    assert.equal(checkRequest(cfg, { ...ok, cookie: 'bt=nope' }).status, 401);
    assert.equal(checkRequest(cfg, { ...ok, cookie: 'bt=secret-token-and-more' }).status, 401);
  });

  it('refuses another host name even with the cookie (DNS rebinding)', () => {
    assert.equal(checkRequest(cfg, { ...ok, host: 'evil.example:4747' }).status, 403);
    assert.equal(checkRequest(cfg, { ...ok, host: '127.0.0.1:9999' }).status, 403);
    assert.equal(checkRequest(cfg, { ...ok, host: undefined }).status, 403);
  });

  it('swaps the token in the address for a strict cookie and redirects without it', () => {
    const r = checkRequest(cfg, { host: '127.0.0.1:4747', cookie: undefined, url: '/?token=secret-token&q=atomic' });
    assert.equal(r.allow, false);
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/?q=atomic');
    assert.match(r.setCookie ?? '', /^bt=secret-token; HttpOnly; SameSite=Strict; Path=\/$/);
  });

  it('does not accept a wrong token in the address', () => {
    assert.equal(checkRequest(cfg, { host: '127.0.0.1:4747', cookie: undefined, url: '/?token=wrong' }).status, 401);
  });
});
