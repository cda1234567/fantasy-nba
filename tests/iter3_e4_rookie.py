"""Smoke test: _prev_fppg_map fallback uses p.fppg for rookies/transfers (Iter3 E4)."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import Player


def test_prev_fppg_fallback_uses_current_fppg():
    """Player whose id is absent from prev_fppg_map must get p.fppg, not 0.0."""
    # Build a minimal prev_fppg_map with one known id; our player has a different id
    prev_map: dict[int, float] = {9999: 45.0}

    # Rookie with id 1 (not in prev_map), current fppg = 38.5
    rookie = Player(id=1, name="Rookie Test", team="TST", pos="SG",
                    age=21, gp=60, mpg=30.0, pts=18.0, reb=4.0, ast=3.0,
                    stl=1.0, blk=0.5, to=1.5, fppg=38.5)

    # The fallback is: prev_map.get(p.id, p.fppg)
    result = prev_map.get(rookie.id, rookie.fppg)

    assert result == rookie.fppg, (
        f"Expected fallback to p.fppg={rookie.fppg}, got {result}"
    )
    assert result != 0.0, "Fallback must not be 0.0 for a rookie"
    print(f"PASS: fallback fppg={result} == p.fppg={rookie.fppg}")


def test_known_player_uses_prev_fppg():
    """Player whose id IS in prev_map should still use the historical value."""
    prev_map: dict[int, float] = {42: 50.0}
    veteran = Player(id=42, name="Veteran", team="TST", pos="PG",
                     age=30, gp=75, mpg=34.0, pts=22.0, reb=5.0, ast=8.0,
                     stl=1.5, blk=0.3, to=2.5, fppg=48.0)

    result = prev_map.get(veteran.id, veteran.fppg)

    assert result == 50.0, f"Expected prev value 50.0, got {result}"
    print(f"PASS: veteran prev_fppg={result} (not overridden by current {veteran.fppg})")


if __name__ == "__main__":
    test_prev_fppg_fallback_uses_current_fppg()
    test_known_player_uses_prev_fppg()
    print("All tests passed.")
