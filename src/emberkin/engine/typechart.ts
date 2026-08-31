// Fast elemental effectiveness lookup, ported from src/Kindred.Core/TypeChart.cs.
// Built from types.json; unspecified pairs default to 1.0.

import { ELEMENTS, elementIndex, parseElement, type Element } from './enums.ts';
import type { TypeChartData } from '../content/models.ts';

export class TypeChart {
  private readonly mult: number[][]; // [attacker][defender]

  constructor(data: TypeChartData) {
    const n = ELEMENTS.length;
    this.mult = Array.from({ length: n }, () => new Array<number>(n).fill(1.0));
    for (const [atk, row] of Object.entries(data.chart)) {
      const a = elementIndex(parseElement(atk));
      for (const [def, m] of Object.entries(row)) {
        this.mult[a]![elementIndex(parseElement(def))] = m;
      }
    }
  }

  /** Multiplier of a single attacking type against a single defending type. */
  pair(attacker: Element, defender: Element): number {
    return this.mult[elementIndex(attacker)]![elementIndex(defender)]!;
  }

  /** Product of multipliers vs a (dual-)typed defender. */
  multiplier(attacker: Element, defenderTypes: readonly Element[]): number {
    let m = 1.0;
    const a = elementIndex(attacker);
    for (const d of defenderTypes) m *= this.mult[a]![elementIndex(d)]!;
    return m;
  }

  static describe(mult: number): string {
    if (mult === 0.0) return 'It has no effect...';
    if (mult < 1.0) return "It's not very effective...";
    if (mult > 1.0) return "It's super effective!";
    return '';
  }
}
