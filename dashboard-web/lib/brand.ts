/**
 * Colour assignment.
 *
 * The current leader wears the red. Everything else takes a stable non-red
 * colour keyed off the model name, so a model that loses traffic keeps its
 * colour rather than being recoloured by its rank. When the leader changes -
 * which is exactly what Demo 4 forces - the red visibly moves between curves
 * and between bar segments at the same moment.
 */
export const SF = {
  canvas: "#FFFAF6",
  navy: "#0E1126",
  warmGray: "#EFEAE6",
  red: "#E51F40",
  gray: "#5F606D",
} as const;

const SERIES = ["#0E1126", "#5F606D", "#9A9AA5", "#C4C0BB", "#7A6F68"];

// Stable order so a model keeps its colour across reconnects and resets.
const ORDER = [
  "claude-sonnet",
  "claude-haiku",
  "nova-lite",
  "gpt-on-bedrock",
  "ipr-nova",
];

export function baseColor(model: string): string {
  const i = ORDER.indexOf(model);
  if (i >= 0) return SERIES[i % SERIES.length];
  let h = 0;
  for (let j = 0; j < model.length; j++) h = (h * 31 + model.charCodeAt(j)) >>> 0;
  return SERIES[h % SERIES.length];
}

export function colorFor(model: string, leader: string | null): string {
  return model === leader ? SF.red : baseColor(model);
}

const NAMES: Record<string, string> = {
  "claude-sonnet": "Sonnet",
  "claude-haiku": "Haiku",
  "nova-lite": "Nova Lite",
  "gpt-on-bedrock": "GPT",
  "ipr-nova": "IPR Nova",
};

/**
 * Short, and short on purpose. Real models cluster far more tightly than a
 * synthetic ladder does - four of five arms landed inside 0.80-0.88 on the
 * real Bedrock run - so long labels collide into each other at the peaks.
 */
export function shortName(model: string): string {
  if (NAMES[model]) return NAMES[model];
  return model
    .replace(/^bedrock\//, "")
    .replace(/^direct-/, "")
    .replace(/^ipr-/, "IPR ")
    .replace(/-on-bedrock$/, "");
}
