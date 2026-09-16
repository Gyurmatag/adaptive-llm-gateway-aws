/** Colour assignment, as CSS variables so it survives the theme switch.
 *
 *  The current leader wears the red; everything else takes a stable colour
 *  keyed off the model name, so a model that loses traffic keeps its colour
 *  rather than being recoloured by its rank. When the leader changes - which
 *  is what Demo 4 forces - the red visibly moves.
 *
 *  These are var() references rather than hex because the console has a theme
 *  switch: the light palette's near-black curve is invisible on a dark ground.
 */
const SERIES = ["var(--sf-s1)", "var(--sf-s2)", "var(--sf-s3)", "var(--sf-s4)", "var(--sf-s5)"];

const ORDER = ["claude-sonnet", "claude-haiku", "nova-lite", "gpt-on-bedrock", "ipr-nova"];

export function baseColor(model: string): string {
  const i = ORDER.indexOf(model);
  if (i >= 0) return SERIES[i % SERIES.length];
  let h = 0;
  for (let j = 0; j < model.length; j++) h = (h * 31 + model.charCodeAt(j)) >>> 0;
  return SERIES[h % SERIES.length];
}

export function colorFor(model: string, leader: string | null): string {
  return model === leader ? "var(--sf-red)" : baseColor(model);
}

const SHORT: Record<string, string> = {
  "claude-sonnet": "Sonnet",
  "claude-haiku": "Haiku",
  "nova-lite": "Nova Lite",
  "gpt-on-bedrock": "GPT",
  "ipr-nova": "IPR Nova",
};

export function shortName(model: string): string {
  return SHORT[model] ?? model;
}
