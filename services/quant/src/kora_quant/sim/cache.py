"""Bounded in-process LRU for simulation results, keyed by a hash of the canonical request."""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from typing import Generic, TypeVar

V = TypeVar("V")


def input_hash(kind: str, canonical_json: str) -> str:
    return hashlib.sha256(f"{kind}:{canonical_json}".encode()).hexdigest()


class LruCache(Generic[V]):
    def __init__(self, capacity: int = 128) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity = capacity
        self._data: OrderedDict[str, V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> V | None:
        with self._lock:
            value = self._data.get(key)
            if value is not None:
                self._data.move_to_end(key)
            return value

    def put(self, key: str, value: V) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._capacity:
                self._data.popitem(last=False)

    def __len__(self) -> int:
        return len(self._data)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
