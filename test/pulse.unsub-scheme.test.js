// pulse.unsub-scheme.test.js — PULSE_UNSUBSCRIBE_URL scheme validation
// (cubic PR #20 R2, TPMAAAA-3299). Only `https:` values render as an
// unsubscribe link; everything else (javascript:, http:, data:, garbage)
// falls back to the reply-UNSUBSCRIBE line in BOTH formats. Standalone
// file so it cannot collide with concurrent edits to test/pulse.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest } from '../lib/pulse/render.js';

const BASE = {
  subscriber: { email: 'byrne@example.com', name: 'Byrne' },
  items: [],
  chases: [],
  now: new Date('2026-09-29T09:00:00Z'),
  fromName: 'PocketPMO Pulse',
  fromEmail: 'pulse@pocketpmo.com'
};

const REPLY_HTML = "Reply <strong>UNSUBSCRIBE</strong> to stop.";
const REPLY_TEXT = 'Reply UNSUBSCRIBE to stop.';

describe('renderDigest unsubscribeUrl scheme validation', () => {
  test('https URL renders an active link in both formats', () => {
    const digest = renderDigest({ ...BASE, unsubscribeUrl: 'https://pocketpmo.com/unsub/x' });
    assert.ok(digest.html.includes('<a href="https://pocketpmo.com/unsub/x"'));
    assert.ok(digest.text.includes('Unsubscribe: https://pocketpmo.com/unsub/x'));
  });

  test('javascript: URL never renders as a link — reply fallback used', () => {
    const digest = renderDigest({ ...BASE, unsubscribeUrl: 'javascript:alert(1)' });
    assert.ok(digest.html.includes(REPLY_HTML));
    assert.ok(!digest.html.includes('javascript:'));
    assert.ok(!digest.html.includes('href="javascript:'));
    assert.ok(digest.text.includes(REPLY_TEXT));
    assert.ok(!digest.text.includes('javascript:'));
  });

  test('http: URL is rejected (https-only contract)', () => {
    const digest = renderDigest({ ...BASE, unsubscribeUrl: 'http://pocketpmo.com/unsub/x' });
    assert.ok(digest.html.includes(REPLY_HTML));
    assert.ok(!digest.html.includes('href="http:'));
    assert.ok(!digest.text.includes('Unsubscribe:'));
    assert.ok(digest.text.includes(REPLY_TEXT));
  });

  test('data: URL is rejected', () => {
    const digest = renderDigest({ ...BASE, unsubscribeUrl: 'data:text/html,<script>alert(1)</script>' });
    assert.ok(digest.html.includes(REPLY_HTML));
    assert.ok(!digest.html.includes('href="data:'));
    assert.ok(!digest.text.includes('data:'));
  });

  test('malformed URL string is rejected', () => {
    for (const bad of ['not a url', 'https://', '://broken', 'pocketpmo.com/unsub']) {
      const digest = renderDigest({ ...BASE, unsubscribeUrl: bad });
      assert.ok(digest.html.includes(REPLY_HTML), `fallback for ${JSON.stringify(bad)}`);
      assert.ok(!/<a href="(?!mailto:|https:)/.test(digest.html), `no hostile link for ${JSON.stringify(bad)}`);
      assert.ok(digest.text.includes(REPLY_TEXT), `text fallback for ${JSON.stringify(bad)}`);
    }
  });

  test('safe URL is re-serialized and entity-escaped (query &, quotes)', () => {
    const digest = renderDigest({
      ...BASE,
      unsubscribeUrl: 'https://pocketpmo.com/unsub?email=byrne@example.com&tok=1"'
    });
    // new URL() re-serializes the quote to %22 (attribute-breaking char
    // neutered before escaping); escapeHtml then encodes the query &.
    assert.ok(digest.html.includes('href="https://pocketpmo.com/unsub?email=byrne@example.com&amp;tok=1%22"'));
    assert.ok(!digest.html.includes('tok=1"'), 'raw double-quote must not appear in href');
  });
});
