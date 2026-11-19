import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceVariables, BACKGROUND_PRESETS, DEFAULT_BACKGROUND, isDarkBackground, normalizeBackground, validBackground } from '../src/appearance';

test('background settings accept exact RGB colors and reject malformed or injected CSS', () => {
  assert.equal(DEFAULT_BACKGROUND, '#ffffff');
  assert.equal(normalizeBackground('#A1B2C3'), '#a1b2c3');
  for (const value of [undefined, null, '', '#fff', 'red', '#000000; color:red', '#12345g', '#000000ff']) {
    assert.equal(validBackground(value), false);
    assert.equal(normalizeBackground(value), '#ffffff');
  }
});
test('independent palettes retain the chosen color and choose readable foregrounds', () => {
  assert.equal(isDarkBackground('#000000'), true);
  assert.equal(isDarkBackground('#ffffff'), false);
  assert.equal(isDarkBackground('#1e2521'), true);
  for (const { color } of [...BACKGROUND_PRESETS, { color: '#1256a3' }]) {
    const palette = appearanceVariables(color);
    assert.equal(palette['--surface'], color);
    assert.notEqual(palette['--text'], color);
    assert.equal(Object.values(palette).some(value => value.includes('vscode') || value.includes('var(')), false);
    assert.notEqual(palette['--surface-alt'], palette['--surface']);
  }
  assert.notEqual(appearanceVariables('#ffffff')['--text'], appearanceVariables('#000000')['--text']);
});
