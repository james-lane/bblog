import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

const appThemesSource = app.match(/const APP_THEMES = (\[[\s\S]*?\n\];)/)?.[1]?.replace(/;$/, '');
if (!appThemesSource) throw new Error('Could not find APP_THEMES in public/app.js.');

const appThemes = Function(`return ${appThemesSource}`)();
const cssBlocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
const baseVars = {};
const themeVars = { playroom: {} };
const colorModeVars = {};

for (const [, rawSelector, body] of cssBlocks) {
  const selector = rawSelector.trim();
  const vars = {};
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    vars[name] = value.trim();
  }
  if (!Object.keys(vars).length) continue;

  if (selector === ':root') Object.assign(baseVars, vars);
  if (selector === ':root[data-color-mode="dark"]') Object.assign(colorModeVars, vars);

  const themeMatch = selector.match(/^:root\[data-theme="([^"]+)"\]$/);
  if (themeMatch) themeVars[themeMatch[1]] = vars;
}

function resolveVar(vars, value, seen = new Set()) {
  value = String(value || '').trim();
  const match = value.match(/^var\(--([^,)]+)(?:,\s*([^)]*))?\)$/);
  if (!match) return value;

  const name = match[1];
  if (seen.has(name)) return '';
  seen.add(name);
  return resolveVar(vars, vars[name] || match[2] || '', seen);
}

function resolveHex(vars, value) {
  const resolved = resolveVar(vars, value);
  return /^#[0-9a-f]{6}$/i.test(resolved) ? resolved.toLowerCase() : null;
}

function rgb(hex) {
  return [0, 2, 4].map((index) => parseInt(hex.slice(index + 1, index + 3), 16));
}

function luminance(hex) {
  return rgb(hex)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(left, right) {
  const leftLum = luminance(left);
  const rightLum = luminance(right);
  return (Math.max(leftLum, rightLum) + 0.05) / (Math.min(leftLum, rightLum) + 0.05);
}

function mix(left, leftAmount, right) {
  const leftRgb = rgb(left);
  const rightRgb = rgb(right);
  return `#${leftRgb
    .map((value, index) => Math.round(value * leftAmount + rightRgb[index] * (1 - leftAmount)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

const tokenPairs = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text-muted', 'bg'],
  ['text-muted', 'surface'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent-text', 'accent'],
  ['accent-text', 'accent-dark'],
  ['danger', 'surface'],
  ['danger', 'delete-bg'],
  ['success-text', 'success-bg'],
  ['offline-text', 'offline-bg'],
  ['offline-text', 'sync-disabled-bg'],
  ['text', 'action-bg'],
  ['text-muted', 'action-bg'],
  ['accent', 'action-bg'],
  ['alert-text', 'alert-bg'],
  ['warning-text', 'warning-bg'],
  ['ok-text', 'ok-bg'],
  ['overdue-text', 'overdue-bg'],
  ['partial-text', 'partial-bg'],
];

const failures = [];

for (const theme of appThemes) {
  for (const mode of ['light', 'dark']) {
    const vars = {
      ...baseVars,
      ...(themeVars[theme.id] || {}),
      ...(mode === 'dark' ? colorModeVars : {}),
    };

    for (const [foregroundName, backgroundName] of tokenPairs) {
      const foreground = resolveHex(vars, vars[foregroundName]);
      const background = resolveHex(vars, vars[backgroundName]);
      if (!foreground || !background) continue;

      const ratio = contrast(foreground, background);
      if (ratio < 4.5) {
        failures.push({
          theme: theme.id,
          mode,
          foregroundName,
          backgroundName,
          foreground,
          background,
          ratio: ratio.toFixed(2),
        });
      }
    }

    const themeText = resolveHex(vars, vars.text);
    const themeBg = resolveHex(vars, vars.bg);
    const themeSurface = resolveHex(vars, vars.surface);
    const babyColours = Array.isArray(theme.babyColours) ? theme.babyColours : theme.babyColours?.[mode];

    if (themeText && themeBg && themeSurface && Array.isArray(babyColours)) {
      const themeActionBg = resolveHex(vars, vars['action-bg']);
      for (const babyColour of babyColours) {
        const mixed = mix(babyColour, 0.5, themeText);
        for (const [backgroundName, background] of [
          ['bg', themeBg],
          ['surface', themeSurface],
        ]) {
          const ratio = contrast(mixed, background);
          if (ratio < 4.5) {
            failures.push({
              theme: theme.id,
              mode,
              foregroundName: `baby text ${babyColour}`,
              backgroundName,
              foreground: mixed,
              background,
              ratio: ratio.toFixed(2),
            });
          }
        }

        const buttonText = mix(babyColour, 0.46, themeText);
        const buttonBg = mix(babyColour, 0.16, themeSurface);
        const buttonRatio = contrast(buttonText, buttonBg);
        if (buttonRatio < 4.5) {
          failures.push({
            theme: theme.id,
            mode,
            foregroundName: `baby button text ${babyColour}`,
            backgroundName: 'baby button tint',
            foreground: buttonText,
            background: buttonBg,
            ratio: buttonRatio.toFixed(2),
          });
        }

        if (themeActionBg) {
          const dashBg = mix(babyColour, 0.15, themeActionBg);
          const dashRatio = contrast(themeText, dashBg);
          if (dashRatio < 4.5) {
            failures.push({
              theme: theme.id,
              mode,
              foregroundName: `dashboard text ${babyColour}`,
              backgroundName: 'baby dashboard tint',
              foreground: themeText,
              background: dashBg,
              ratio: dashRatio.toFixed(2),
            });
          }
        }
      }
    }
  }
}

if (failures.length) {
  console.error('Text contrast failures:');
  for (const failure of failures) {
    console.error(
      `${failure.theme}/${failure.mode}: ${failure.foregroundName} ${failure.foreground} on ${failure.backgroundName} ${failure.background} = ${failure.ratio}:1`,
    );
  }
  process.exitCode = 1;
}
