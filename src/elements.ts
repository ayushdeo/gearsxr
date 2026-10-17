// CPK-style coloring and covalent radii (Angstrom) for common elements.
// Falls back to a generic gray/radius for anything not listed.

export interface ElementInfo {
  color: number;
  radius: number; // covalent radius, used both for bond cutoffs and atom sphere scale
}

const DEFAULT: ElementInfo = { color: 0xb0b0b0, radius: 0.7 };

export const ELEMENT_TABLE: Record<string, ElementInfo> = {
  H: { color: 0xffffff, radius: 0.31 },
  C: { color: 0x909090, radius: 0.76 },
  N: { color: 0x3050f8, radius: 0.71 },
  O: { color: 0xff0d0d, radius: 0.66 },
  F: { color: 0x90e050, radius: 0.57 },
  Na: { color: 0xab5cf2, radius: 1.66 },
  Mg: { color: 0x8aff00, radius: 1.41 },
  Si: { color: 0xf0c8a0, radius: 1.11 },
  P: { color: 0xff8000, radius: 1.07 },
  S: { color: 0xffff30, radius: 1.05 },
  Cl: { color: 0x1ff01f, radius: 1.02 },
  K: { color: 0x8f40d4, radius: 2.03 },
  Ca: { color: 0x3dff00, radius: 1.76 },
  Fe: { color: 0xe06633, radius: 1.32 },
  Zn: { color: 0x7d80b0, radius: 1.22 },
  Br: { color: 0xa62929, radius: 1.2 },
  I: { color: 0x940094, radius: 1.39 },
};

export function getElementInfo(symbol: string): ElementInfo {
  return ELEMENT_TABLE[symbol] ?? DEFAULT;
}

// Symbols indexed by atomic number (index 0 is a placeholder so Z maps directly).
// Gaussian Cube files identify atoms by atomic number rather than symbol.
const SYMBOLS_BY_ATOMIC_NUMBER = [
  "X",
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
  "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
  "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
  "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
  "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
  "Md", "No", "Lr",
];

export function symbolForAtomicNumber(z: number): string {
  return SYMBOLS_BY_ATOMIC_NUMBER[z] ?? "X";
}

const ELEMENT_NAMES: Record<string, string> = {
  H: "Hydrogen", He: "Helium", Li: "Lithium", Be: "Beryllium", B: "Boron", C: "Carbon", N: "Nitrogen",
  O: "Oxygen", F: "Fluorine", Ne: "Neon", Na: "Sodium", Mg: "Magnesium", Al: "Aluminium", Si: "Silicon",
  P: "Phosphorus", S: "Sulfur", Cl: "Chlorine", Ar: "Argon", K: "Potassium", Ca: "Calcium", Ti: "Titanium",
  Cr: "Chromium", Mn: "Manganese", Fe: "Iron", Co: "Cobalt", Ni: "Nickel", Cu: "Copper", Zn: "Zinc",
  Br: "Bromine", Ag: "Silver", I: "Iodine", Pt: "Platinum", Au: "Gold", Pb: "Lead",
};

/** Full element name for a symbol, or the symbol itself when unknown. */
export function elementName(symbol: string): string {
  return ELEMENT_NAMES[symbol] ?? symbol;
}
