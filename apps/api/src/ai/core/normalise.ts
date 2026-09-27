/**
 * Text normalisation for the output guards and the untrusted-data wrapper (IRTC R4-03, R4-04, R4-14).
 *
 * Keyword guards are only as good as the text they see. Model output and user-supplied text are
 * normalised before any check:
 * - NFKC (full-width `５７％` → `57%`, ligatures, compatibility forms);
 * - invisible characters (zero-width, direction marks, BOM, soft hyphen, controls) removed;
 * - every Unicode decimal digit mapped to ASCII (`٩٩` → `99`), plus the Arabic percent sign and
 *   decimal separator;
 * - for matching only, common Cyrillic/Greek confusables are folded to Latin (`рlaced` → `placed`).
 */

// Built from code points so the source file stays free of irregular characters.
const cp = (n: number) => String.fromCharCode(n);
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];
// None of the ranges contains a character that is special inside a class (`]`, `\`, `^`, `-`).
export const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`,
  'g',
);

/** Non-ASCII decimal digit → ASCII, using the digit's position in its (contiguous) block of ten. */
function asciiDigit(ch: string): string {
  let code = ch.codePointAt(0)!;
  let steps = 0;
  // Walk back to the block's zero: Unicode Nd digits come in contiguous runs of ten.
  while (steps < 9 && /\p{Nd}/u.test(String.fromCodePoint(code - 1)) && code - 1 > 0x7f) {
    code -= 1;
    steps += 1;
  }
  return String(steps % 10);
}

const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;

/**
 * The canonical text the guards check and the user is shown: NFKC, no invisible characters, ASCII
 * digits. Idempotent.
 */
export function normaliseText(text: string, invisible: 'strip' | 'space' = 'strip'): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_RE, invisible === 'strip' ? '' : ' ')
    .replace(NON_ASCII_DIGIT, asciiDigit)
    .replace(/٪/g, '%') // Arabic percent sign
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ','); // Arabic thousands separator
}

/** Cyrillic and Greek letters that look like Latin ones (lower and upper case). */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ɡ: 'g',
  һ: 'h',
  ԛ: 'q',
  ԝ: 'w',
  ν: 'v',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  І: 'I',
  Ј: 'J',
  Ѕ: 'S',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

export function foldConfusables(text: string): string {
  return text.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

/**
 * Variants of a text for keyword matching: invisible characters removed and replaced by a space
 * (`I<ZWSP>placed` must read as "I placed", `pla<ZWSP>ced` as "placed"), confusables folded, typographic
 * apostrophes and dashes made ASCII.
 */
export function matchVariants(text: string): string[] {
  const fold = (t: string) =>
    foldConfusables(t)
      .replace(/[‘’ʼ′]/g, "'")
      .replace(/[‐-―−]/g, '-');
  const a = fold(normaliseText(text, 'strip'));
  const b = fold(normaliseText(text, 'space'));
  return a === b ? [a] : [a, b];
}
