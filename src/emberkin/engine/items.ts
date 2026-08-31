// Item catalogue, ported from src/Kindred.Core/Items.cs. Data-light for the
// prototype, exactly as upstream.

export const RESONATORS = ['resonator', 'greater_resonator', 'master_resonator'] as const;

export const Items = {
  healAmount(id: string): number {
    switch (id) {
      case 'potion': return 40;
      case 'super_potion': return 90;
      case 'hyper_potion': return 160;
      case 'max_potion': return 99999;
      default: return 0;
    }
  },

  curesStatus(id: string): boolean {
    return id === 'salve' || id === 'full_heal';
  },

  isResonator(id: string): boolean {
    return (RESONATORS as readonly string[]).includes(id);
  },

  /** Catch-power multiplier of a Resonator grade. */
  resonatorPower(id: string): number {
    switch (id) {
      case 'resonator': return 1.0;
      case 'greater_resonator': return 1.5;
      case 'master_resonator': return 255.0; // effectively guaranteed
      default: return 1.0;
    }
  },

  displayName(id: string): string {
    switch (id) {
      case 'potion': return 'Potion';
      case 'super_potion': return 'Super Potion';
      case 'hyper_potion': return 'Hyper Potion';
      case 'max_potion': return 'Max Potion';
      case 'salve': return 'Salve';
      case 'full_heal': return 'Full Heal';
      case 'resonator': return 'Resonator';
      case 'greater_resonator': return 'Greater Resonator';
      case 'master_resonator': return 'Master Resonator';
      default: return id;
    }
  },
} as const;
