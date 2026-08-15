import { deriveTokens, CONTRAST_PAIRS, pairMinimum, contrastRatio } from '@/modules/appearance/derive.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { THEME_PRESETS } from '@/modules/appearance/presets.js';

for (const [id, preset] of Object.entries(THEME_PRESETS)) {
  const d = deriveTokens(preset);
  const css = serializeStylesheet(d);
  let worst = 99; let worstPair = '';
  for (const ramp of [d.light, d.dark]) {
    if (!ramp) continue;
    for (const p of CONTRAST_PAIRS) {
      const r = contrastRatio(ramp.colors[p.foreground], ramp.colors[p.background]);
      const min = pairMinimum(p, preset.surface.contrastTarget);
      if (r < min) console.log(`  FAIL ${id}: ${p.foreground}/${p.background} ${r.toFixed(2)} < ${min}`);
      if (r < worst) { worst = r; worstPair = `${p.foreground}/${p.background}`; }
    }
  }
  console.log(`${id.padEnd(14)} css=${String(css.length).padStart(6)}B min=${d.minRatio.toFixed(2)} worstPair=${worstPair}(${worst.toFixed(2)}) adjusted=[${d.adjusted.join(',')}]`);
}

const g = deriveTokens(THEME_PRESETS.liquidGlass);
console.log('\n--- liquidGlass :root default surface ---');
console.log(JSON.stringify(g.light.surfaces.default, null, 1).slice(0, 2600));
console.log('\n--- brutalist card ---');
console.log(JSON.stringify(deriveTokens(THEME_PRESETS.brutalist).light.surfaces.card, null, 1).slice(0, 1400));
