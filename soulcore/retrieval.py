"""Cheap pre-send / idle retrieval for familiarity.

Given text that is about to go to the speaking API, find long-term memories
that resonate with it, mark them as triggered today, and update:

  - current_familiarity
  - processing_fluency

No LLM call. This is the "subconscious recognition" layer.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any

from . import db


def _grams(text: str, n: int = 2) -> set[str]:
    s = "".join(ch.lower() for ch in str(text) if not ch.isspace())
    if len(s) < n:
        return {s} if s else set()
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def _similarity(query: str, text: str) -> float:
    q = _grams(query)
    t = _grams(text)
    if not q or not t:
        return 0.0
    overlap = len(q & t)
    contain = overlap / max(1, len(q))
    jaccard = overlap / max(1, len(q | t))
    return round(0.65 * contain + 0.35 * jaccard, 4)


def retrieve(
    conn: sqlite3.Connection,
    text: str,
    *,
    limit: int = 8,
    min_similarity: float = 0.12,
    mark: bool = True,
    include_sensitive: bool = False,
    include_text: bool = False,
    source: str = "pre_send",
) -> list[dict[str, Any]]:
    """Return top matching memories; optionally update familiarity/trigger."""
    query = (text or "").strip()
    if not query:
        return []
    where = "WHERE sensitive=0" if not include_sensitive else ""
    rows = conn.execute(f"SELECT * FROM memories {where}").fetchall()
    scored: list[tuple[float, float, sqlite3.Row]] = []
    for row in rows:
        sim = _similarity(query, row["text"])
        if sim <= 0:
            continue
        importance = max(0.0, float(row["importance"] or 0.0))
        fam = max(0.0, min(1.0, float(row["current_familiarity"] or 0.0)))
        # familiarity helps recognition, but must not drown out actual match.
        rank = 0.78 * sim + 0.12 * fam + 0.10 * importance
        scored.append((rank, sim, row))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    top = scored[: max(1, int(limit))]

    out: list[dict[str, Any]] = []
    hit_ids: list[str] = []
    for rank, sim, row in top:
        hit = sim >= min_similarity
        before = float(row["current_familiarity"] or 0.0)
        after = before
        fluency = float(row["processing_fluency"] or 0.0)
        if hit and mark:
            # asymptotic: repeated recall gets familiar, never exceeds 1.
            after = min(1.0, before + 0.25 * sim * (1.0 - before))
            fluency = round(0.55 * after + 0.45 * sim, 4)
            conn.execute(
                """UPDATE memories
                   SET current_familiarity=?, processing_fluency=?, updated_at=?
                   WHERE id=?""",
                (round(after, 4), fluency, db.utcnow(), row["id"]),
            )
            hit_ids.append(row["id"])
        item: dict[str, Any] = {
            "id": row["id"],
            "score": round(rank, 4),
            "similarity": sim,
            "familiarity_before": round(before, 4),
            "familiarity_after": round(after, 4),
            "fluency": round(fluency, 4),
            "hit": hit,
            "scope": row["scope"],
            "person_id": row["person_id"],
            "speaker": row["speaker"],
            "identity_status": row["identity_status"] or "unknown",
        }
        if include_text:
            item["text"] = row["text"]
        out.append(item)
    if mark and hit_ids:
        db.mark_triggered(conn, hit_ids, source=source, note=query[:120])
    else:
        conn.commit()
    return out


def idle_retrieve(conn: sqlite3.Connection, text: str, *, limit: int = 5) -> list[dict[str, Any]]:
    """Idle variant: same cheap retrieval, lower trigger label."""
    return retrieve(conn, text, limit=limit, mark=True, source="idle_retrieval")
