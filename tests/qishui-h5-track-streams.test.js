'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const qishui = require('../qishui-api');

const api = qishui._test;

function h5Fixture(overrides) {
  overrides = overrides || {};
  return {
    track: Object.assign({
      id: 'h5-stream-fixture',
      name: 'h5 流提取样例',
      duration_ms: 212000,
      label_info: { only_vip_playable: false },
    }, overrides.track || {}),
    track_player: Object.assign({
      video_model: JSON.stringify(Object.assign({
        status: 10,
        video_duration: 212,
        media_type: 'audio',
        video_list: [{
          main_url: 'https://media.example/h5-main.m4a?br=212000',
          backup_url: 'https://media.example/h5-backup.m4a?br=128000',
          video_meta: { quality: 'higher' },
          gear_des_key: 'higher',
        }],
      }, overrides.videoModel || {})),
    }, overrides.trackPlayer || {}),
  };
}

test.beforeEach(() => {
  api.clearQishuiRuntimeCaches();
});

test('h5 video_model streams are collected with url, bitrate, and gear quality', () => {
  const collected = api.collectQishuiTrackV2Streams(h5Fixture());
  assert.ok(collected.streams.length >= 1, 'main_url must yield a stream');
  const best = collected.streams.reduce((a, b) => (b.bitrate > a.bitrate ? b : a));
  assert.strictEqual(best.url, 'https://media.example/h5-main.m4a?br=212000');
  assert.strictEqual(best.bitrate, 212000);
  assert.strictEqual(best.quality, 'higher');
  assert.strictEqual(best.auth, '', 'plain h5 streams carry no spade_a auth');
});

test('h5 track bit_rates remain a last-resort fallback source', () => {
  const collected = api.collectQishuiTrackV2Streams(h5Fixture({
    track: { bit_rates: [{ playable_url: 'https://media.example/h5-bitrate.flac?br=999000', format: 'flac' }] },
  }));
  assert.ok(collected.streams.length >= 1, 'video_model must stay the primary source');
  assert.ok(collected.fallbackStreams.length >= 1, 'bit_rates must populate the fallback list');
  assert.strictEqual(collected.fallbackStreams[0].url, 'https://media.example/h5-bitrate.flac?br=999000');
});

test('encrypted h5 streams keep their spade_a auth for the decryptor path', () => {
  const collected = api.collectQishuiTrackV2Streams(h5Fixture({
    videoModel: {
      video_list: [{
        main_url: 'https://media.example/h5-encrypted.m4a',
        backup_url: '',
        video_meta: { quality: 'medium' },
        gear_des_key: 'medium',
        encrypt_info: { spade_a: 'fixture-spade-key' },
      }],
    },
  }));
  assert.strictEqual(collected.streams.length, 1);
  assert.strictEqual(collected.streams[0].auth, 'fixture-spade-key', 'spade_a must ride along for /api/audio decryption');
});

test('per-gear need_vip labels must not pre-gate a whole free track', () => {
  const freeTrackWithVipGears = {
    track: {
      id: 'h5-free-multi-gear',
      duration_ms: 212000,
      label_info: {
        only_vip_playable: false,
        quality_map: {
          medium: { play_detail: { need_vip: false } },
          higher: { play_detail: { need_vip: true } },
          lossless: { play_detail: { need_vip: true } },
        },
      },
    },
  };
  const sanitized = api.qishuiH5EntitlementTrack(freeTrackWithVipGears);
  const restriction = api.qishuiTrackPlaybackRestriction({ track: sanitized });
  assert.strictEqual(restriction.requiredTier, 'free', 'quality_map need_vip on higher gears must not mark the track VIP-only');
  assert.strictEqual(restriction.vipRequired, false);

  const vipTrack = {
    track: {
      id: 'h5-vip-whole-track',
      duration_ms: 212000,
      label_info: { only_vip_playable: true },
    },
  };
  const vipRestriction = api.qishuiTrackPlaybackRestriction({ track: api.qishuiH5EntitlementTrack(vipTrack) });
  assert.strictEqual(vipRestriction.requiredTier, 'vip', 'whole-track only_vip_playable must still pre-gate VIP tracks');
});

test('per-gear VIP boundaries still apply when picking a stream for a free account', () => {
  const membership = { membershipKnown: true, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  const collected = api.collectQishuiTrackV2Streams(h5Fixture());
  const allowed = api.qishuiBestStreamCandidateForMembership(collected.streams, membership);
  assert.strictEqual(allowed, null, 'a higher-gear-only payload must not hand its stream to a free account');

  const freeMembershipCollection = api.collectQishuiTrackV2Streams(h5Fixture({
    videoModel: {
      video_list: [
        { main_url: 'https://media.example/h5-medium.m4a?br=128000', backup_url: '', video_meta: { quality: 'medium' }, gear_des_key: 'medium' },
        { main_url: 'https://media.example/h5-higher.m4a?br=212000', backup_url: '', video_meta: { quality: 'higher' }, gear_des_key: 'higher' },
      ],
    },
  }));
  const freeBest = api.qishuiBestStreamCandidateForMembership(freeMembershipCollection.streams, membership);
  assert.ok(freeBest, 'a free account must keep the free-gear stream');
  assert.strictEqual(freeBest.url, 'https://media.example/h5-medium.m4a?br=128000');
});
