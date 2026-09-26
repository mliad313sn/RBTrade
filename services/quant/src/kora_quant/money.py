"""Decimal helpers. Money and prices are never binary floats (master goal)."""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Context, Decimal, InvalidOperation

KORA_CONTEXT = Context(prec=40, rounding=ROUND_HALF_EVEN)


class DecimalParseError(ValueError):
    """Raised when a value is not a canonical decimal string."""


def dec(value: str | int | Decimal) -> Decimal:
    """Build a Decimal from a string, int or Decimal. Floats are rejected on purpose."""
    if isinstance(value, bool):
        raise DecimalParseError(f"not a decimal: {value!r}")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if not isinstance(value, str):
        raise DecimalParseError(f"not a decimal: {value!r}")
    try:
        d = KORA_CONTEXT.create_decimal(value.strip())
    except InvalidOperation as exc:
        raise DecimalParseError(f"not a decimal: {value!r}") from exc
    if not d.is_finite():
        raise DecimalParseError(f"not a finite decimal: {value!r}")
    return d


def quantize(value: str | int | Decimal, places: int) -> Decimal:
    """Round to instrument precision with banker's rounding (same as @kora/domain)."""
    if not 0 <= places <= 18:
        raise ValueError("places must be in [0, 18]")
    return dec(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN)
