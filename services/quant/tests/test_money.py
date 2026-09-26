from __future__ import annotations

from decimal import Decimal

import pytest

from kora_quant.money import DecimalParseError, dec, quantize


def test_dec_is_exact() -> None:
    assert dec("0.1") + dec("0.2") == Decimal("0.3")
    assert dec(5) == Decimal(5)
    d = Decimal("1.5")
    assert dec(d) is d


@pytest.mark.parametrize("bad", [0.1, "abc", "NaN", "Infinity", True, None])
def test_dec_rejects_floats_and_garbage(bad: object) -> None:
    with pytest.raises(DecimalParseError):
        dec(bad)  # type: ignore[arg-type]


def test_quantize_bankers_rounding() -> None:
    assert str(quantize("1.084205", 5)) == "1.08420"
    assert str(quantize("1.084215", 5)) == "1.08422"
    with pytest.raises(ValueError, match="places"):
        quantize("1", 19)
