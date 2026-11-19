export const DEFAULT_BACKGROUND = '#ffffff';
export const BACKGROUND_PRESETS = [
  { name: '浅色', color: '#ffffff' },
  { name: '深色', color: '#1e2521' },
  { name: '暖色', color: '#fff9ed' },
  { name: '浅绿', color: '#eef6f0' },
];
export function validBackground(value: unknown): value is string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
}
export function normalizeBackground(value: unknown): string {
  return validBackground(value) ? value.toLowerCase() : DEFAULT_BACKGROUND;
}
export function isDarkBackground(background: string): boolean {
  const channels = [1, 3, 5].map(i => parseInt(normalizeBackground(background).slice(i, i + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < .179;
}
function mix(background: string, foreground: string, weight: number): string {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(background.slice(i, i + 2), 16) * (1 - weight) + parseInt(foreground.slice(i, i + 2), 16) * weight).toString(16).padStart(2, '0')).join('');
}
export function appearanceVariables(value: string): Record<string, string> {
  const background = normalizeBackground(value), dark = isDarkBackground(background);
  const contrast = dark ? '#ffffff' : '#000000';
  return {
    '--surface': background,
    '--surface-alt': mix(background, contrast, dark ? .035 : .018),
    '--surface-hover': mix(background, contrast, dark ? .085 : .055),
    '--text': dark ? '#edf6ef' : '#1c2820',
    '--muted': dark ? '#b4c0b8' : '#627168',
    '--line': mix(background, contrast, dark ? .19 : .15),
    '--grid-line': mix(background, contrast, dark ? .13 : .10),
    '--accent': dark ? '#8bd2a2' : '#286c47',
    '--accent-dark': dark ? '#6ab984' : '#205737',
    '--accent-soft': mix(background, dark ? '#84c99d' : '#347653', dark ? .16 : .10),
    '--selection': dark ? 'rgba(139,210,162,.12)' : 'rgba(52,118,83,.08)',
  };
}
