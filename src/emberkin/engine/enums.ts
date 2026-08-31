// The engine's enumerations, ported from src/Kindred.Core/Enums.cs. The C# enums
// are PascalCase but parse case-insensitively from the lowercase JSON content.
// We keep each enum's canonical spelling as whatever the battle LOG prints, so a
// ported log line is byte-identical to the C#:
//   - Element / Stat / MoveCategory / GrowthRate: canonical lowercase (matches
//     the content ids; the C# never prints an Element/Category name to the log).
//   - Status: canonical PascalCase ('Burn', 'Shock', …) — the C# logs the enum
//     name ("... is now Shock!"), and SaveGame stores Status.ToString().
//
// Order matters for Element and Stat: the type chart and the stat-stage array are
// indexed by the enum's ordinal, so ELEMENTS/STATS preserve the C# declaration order.

export const ELEMENTS = [
  'ember', 'tide', 'verdant', 'gale', 'stone', 'spark', 'frost', 'umbra', 'lumen',
] as const;
export type Element = (typeof ELEMENTS)[number];

const ELEMENT_INDEX = new Map<string, number>(ELEMENTS.map((e, i) => [e, i]));

export function elementIndex(e: Element): number {
  return ELEMENT_INDEX.get(e)!;
}

export function parseElement(s: string): Element {
  const v = s.toLowerCase();
  if (!ELEMENT_INDEX.has(v)) throw new Error(`Unknown element '${s}'.`);
  return v as Element;
}

export const STATS = ['hp', 'attack', 'defense', 'spatk', 'spdef', 'speed'] as const;
export type Stat = (typeof STATS)[number];

const STAT_INDEX = new Map<string, number>(STATS.map((s, i) => [s, i]));

export function statIndex(s: Stat): number {
  return STAT_INDEX.get(s)!;
}

export function parseStat(s: string): Stat {
  const v = s.toLowerCase();
  if (!STAT_INDEX.has(v)) throw new Error(`Unknown stat '${s}'.`);
  return v as Stat;
}

export function isStat(s: string): boolean {
  return STAT_INDEX.has(s.toLowerCase());
}

export const MOVE_CATEGORIES = ['physical', 'special', 'status'] as const;
export type MoveCategory = (typeof MOVE_CATEGORIES)[number];

export function parseCategory(s: string): MoveCategory {
  const v = s.toLowerCase();
  if (v !== 'physical' && v !== 'special' && v !== 'status') throw new Error(`Unknown category '${s}'.`);
  return v;
}

// Status is stored/logged PascalCase to match the C# enum's ToString().
export const STATUSES = ['None', 'Burn', 'Chill', 'Shock', 'Root', 'Dazed'] as const;
export type Status = (typeof STATUSES)[number];

const STATUS_BY_LOWER = new Map<string, Status>(STATUSES.map((s) => [s.toLowerCase(), s]));

export function parseStatus(s: string | null | undefined): Status {
  if (!s) return 'None';
  const v = STATUS_BY_LOWER.get(s.toLowerCase());
  if (v === undefined) throw new Error(`Unknown status '${s}'.`);
  return v;
}

export function isStatus(s: string): boolean {
  return STATUS_BY_LOWER.has(s.toLowerCase());
}

export const GROWTH_RATES = ['slow', 'medium', 'fast'] as const;
export type GrowthRate = (typeof GROWTH_RATES)[number];

export function parseGrowth(s: string): GrowthRate {
  const v = s.toLowerCase();
  if (v !== 'slow' && v !== 'medium' && v !== 'fast') throw new Error(`Unknown growth rate '${s}'.`);
  return v;
}

export type TimeOfDay = 'Day' | 'Night';
