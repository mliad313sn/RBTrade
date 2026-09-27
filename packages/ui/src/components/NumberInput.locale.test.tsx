import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { decimalSeparator, formatForInput, NumberInput, parseLocaleDecimal } from './NumberInput';

/** IRTC R5-08: "2,500" typed by an English speaker is two thousand five hundred, never 2.50. */
describe('NumberInput separators per language (IRTC R5-08)', () => {
  it('parses English grouping and refuses ambiguous commas', () => {
    expect(parseLocaleDecimal('2,500', 'en')).toEqual({ ok: true, canonical: '2500' });
    expect(parseLocaleDecimal('1,234,567.89', 'en-GB')).toEqual({
      ok: true,
      canonical: '1234567.89',
    });
    expect(parseLocaleDecimal(' 2500.5 ', 'en')).toEqual({ ok: true, canonical: '2500.5' });
    expect(parseLocaleDecimal('2,5', 'en')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseLocaleDecimal('2,50', 'en')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseLocaleDecimal('25,00.1', 'en')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseLocaleDecimal('1.2.3', 'en')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseLocaleDecimal('12a', 'en')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseLocaleDecimal('-1,000', 'en')).toEqual({ ok: true, canonical: '-1000' });
    expect(parseLocaleDecimal('', 'en')).toEqual({ ok: true, canonical: '' });
  });

  it('parses French decimal comma and space / no-break-space / dot grouping', () => {
    expect(parseLocaleDecimal('2,5', 'fr')).toEqual({ ok: true, canonical: '2.5' });
    expect(parseLocaleDecimal('2 500,5', 'fr')).toEqual({ ok: true, canonical: '2500.5' });
    expect(parseLocaleDecimal('2\u202f500,50', 'fr-FR')).toEqual({
      ok: true,
      canonical: '2500.50',
    });
    expect(parseLocaleDecimal('2\u00a0500', 'fr')).toEqual({ ok: true, canonical: '2500' });
    expect(parseLocaleDecimal('2.500,5', 'fr')).toEqual({ ok: true, canonical: '2500.5' });
    expect(parseLocaleDecimal('2.500.000', 'fr')).toEqual({ ok: true, canonical: '2500000' });
    expect(parseLocaleDecimal('1.5', 'fr')).toEqual({ ok: true, canonical: '1.5' });
    expect(parseLocaleDecimal('25.00,1', 'fr')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseLocaleDecimal('1,2,3', 'fr')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseLocaleDecimal('1.2.3', 'fr')).toEqual({ ok: false, reason: 'invalid' });
    expect(decimalSeparator(undefined)).toBe('.');
    expect(formatForInput('2500.50', 'fr')).toBe('2500,50');
    expect(formatForInput('2500.50', 'en')).toBe('2500.50');
  });

  function Harness({ locale }: { locale?: string }) {
    const [v, setV] = useState('');
    return (
      <div lang={locale}>
        <NumberInput label="How much?" value={v} onValueChange={setV} precision={2} min="0" />
        <output data-testid="out">{v}</output>
      </div>
    );
  }

  it('English: typing or pasting "2,500" gives 2500.00; "2,50" shows a message and no amount', () => {
    render(<Harness locale="en" />);
    const input = screen.getByRole('textbox', { name: 'How much?' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,500' } });
    expect(screen.getByTestId('out')).toHaveTextContent('2500');
    fireEvent.blur(input);
    expect(input).toHaveValue('2500.00');
    expect(screen.getByTestId('out')).toHaveTextContent('2500.00');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,50' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('2,50');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use a comma only between thousands (2,500) and a point for decimals (2.5).',
    );
    expect(screen.getByTestId('out')).toBeEmptyDOMElement();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('French: "2 500,5" gives 2500.50 and is shown with a decimal comma', () => {
    render(<Harness locale="fr" />);
    const input = screen.getByRole('textbox', { name: 'How much?' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2 500,5' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('out')).toHaveTextContent('2500.50');
    expect(input).toHaveValue('2500,50');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '25.00,1' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('Utilisez une virgule pour les décimales');
  });
});
