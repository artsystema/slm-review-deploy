import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  hasTranslation,
  localeFor,
  normalizeLanguage,
  translate,
} from '../public/assets/review-i18n.js';

describe('remote review localisation', () => {
  it('recognises Ukrainian browser locale variants and defaults safely to English', () => {
    assert.equal(normalizeLanguage('uk-UA'), 'uk');
    assert.equal(normalizeLanguage('UK'), 'uk');
    assert.equal(normalizeLanguage('pl-PL'), 'en');
    assert.equal(localeFor('uk'), 'uk-UA');
    assert.equal(localeFor('en'), 'en-GB');
  });

  it('translates operator-facing states without changing the stored value', () => {
    assert.equal(translate('value.uncertain', 'uk'), 'невизначено');
    assert.equal(translate('value.critical', 'uk'), 'критично');
    assert.equal(translate('role.illumination_flattened', 'uk'), 'Вирівняне освітлення');
  });

  it('substitutes dynamic values and falls back to English for missing Ukrainian entries', () => {
    assert.equal(translate('layer', 'uk', { index: 42 }), 'Шар 42');
    assert.equal(translate('session.layers', 'en', { count: 7 }), '7 layers');
    assert.equal(translate('not.a.real.key', 'uk'), 'not.a.real.key');
  });

  it('defines both languages for every translation token rendered by PHP', () => {
    const page = readFileSync(new URL('../app/Application.php', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/assets/review.js', import.meta.url), 'utf8');
    const keys = [
      ...[...page.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)].map(match => match[1]),
      ...[...script.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]),
    ];
    assert.ok(keys.length > 20, 'the page markup was not found');
    for (const key of new Set(keys)) {
      assert.equal(hasTranslation(key, 'en'), true, `missing English ${key}`);
      assert.equal(hasTranslation(key, 'uk'), true, `missing Ukrainian ${key}`);
    }
  });
});
