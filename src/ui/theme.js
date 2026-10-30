// Palette: VkusVill's dark greens. Colors are 0xRRGGBB.

export const T = {
  bg: 0x0b130e,
  panel: 0x0f1a13,
  panel2: 0x132219,
  raise: 0x1a2e21,
  line: 0x24402e,
  lineHi: 0x3dbe55,
  sel: 0x1c3a26,
  selHi: 0x24502f,
  text: 0xe4eee6,
  sub: 0xa9bfae,
  dim: 0x6f8a77,
  mute: 0x41594a,
  green: 0x3dbe55,
  greenD: 0x1f7a32,
  greenDD: 0x123f1d,
  lime: 0xb5e853,
  mint: 0x7ee0a1,
  orange: 0xff9f43,
  red: 0xff5d5d,
  redD: 0x5a1e1e,
  yellow: 0xffd166,
  blue: 0x6cb4ff,
  violet: 0xb39cff,
  pink: 0xff7ab6,
  white: 0xffffff,
  black: 0x000000,
  header: 0x0e2a17,
};

export function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

// Gradient through a set of color stops, t ∈ [0, 1]
export function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const k = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return mix(stops[i], stops[i + 1], k - i);
}

export const BRAND = [0x1f7a32, 0x3dbe55, 0xb5e853, 0xfff27a, 0xb5e853, 0x3dbe55, 0x1f7a32];
