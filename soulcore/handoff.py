"""Deterministic sleep handoff: facts the local body can verify.

This is intentionally not another LLM summary. It points at the latest
episode/raw memory, the sleep ledger, pending questions and the current
P/desire delta so the surface layer starts from evidence instead of an
identity declaration.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from . import body_state, daybook, db, desire, personality

DATA = Path(__file__).resolve().parent.parent / "data"
MAX_CHARS = 900


def _local(ts: str | None) -> str:
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt.astimezone().strftime("%m-%d %H:%M")
    except Exception:
        return str(ts)[:16]


def _today() -> str:
    return datetime.now().astimezone().date().isoformat()


def _place(conversation_key: str | None) -> str:
    key = str(conversation_key or "")
    if key.startswith("private:"):
        return "私聊"
    if key.startswith("group:"):
        return "群聊"
    return key


def _latest_episode(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute(
        """SELECT id, day, start_at, end_at, conversation_key, summary, key_quote,
                  felt, unresolved, importance
           FROM episodes
           ORDER BY COALESCE(end_at, start_at, created_at) DESC LIMIT 1"""
    ).fetchone()
    return dict(row) if row else None


def _latest_memory(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute(
        """SELECT id, ts, scope, conversation_key, speaker, text, identity_status
           FROM memories WHERE COALESCE(sensitive,0)=0
           ORDER BY COALESCE(ts, created_at) DESC LIMIT 1"""
    ).fetchone()
    return dict(row) if row else None


def _sleep(conn: sqlite3.Connection) -> dict[str, Any]:
    day = _today()
    try:
        rows = conn.execute(
            "SELECT day_key, reason, at FROM sleep_runs WHERE day_key=? ORDER BY id ASC",
            (day,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    last = None
    try:
        last = conn.execute(
            "SELECT day_key, reason, at FROM sleep_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
    except sqlite3.OperationalError:
        pass
    return {
        "count_today": len(rows),
        "last_at": (dict(last) if last else {}).get("at"),
        "last_day": (dict(last) if last else {}).get("day_key"),
    }


def _pending(conn: sqlite3.Connection) -> int:
    try:
        return int(conn.execute(
            "SELECT COUNT(*) FROM appraisal_questions WHERE status='pending'"
        ).fetchone()[0])
    except sqlite3.OperationalError:
        return 0


def _p_delta(conn: sqlite3.Connection) -> tuple[dict[str, float], str]:
    """Coarse slow-P shift; day summary delta is preferred."""
    day = _today()
    delta: dict[str, float] = {}
    try:
        summary = daybook.latest(conn, day)
        if summary and isinstance(summary.get("delta"), dict):
            delta = {k: round(float(v), 3) for k, v in summary["delta"].items()}
    except Exception:
        pass
    if not delta:
        try:
            current = personality.compute_p(conn).get("p") or {}
            baseline = daybook.latest(conn, day)
            if baseline and isinstance(baseline.get("baseline"), dict):
                delta = {
                    k: round(float(current.get(k, 0.0)) - float(baseline["baseline"].get(k, 0.0)), 3)
                    for k in personality.DIMENSIONS
                }
        except Exception:
            delta = {}
    return delta, ("day_delta" if delta else "unavailable")


def _top_delta(delta: dict[str, float], threshold: float = 0.06) -> list[tuple[str, float]]:
    return sorted(
        ((k, v) for k, v in delta.items() if abs(float(v)) >= threshold),
        key=lambda kv: abs(float(kv[1])),
        reverse=True,
    )[:2]


def _desires(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    try:
        return list(desire.compute(conn).get("desires") or [])[:2]
    except Exception:
        return []


def _who(conn: sqlite3.Connection) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for scope in ("private", "group"):
        try:
            row = conn.execute(
                """SELECT speaker, text, conversation_key, ts FROM memories
                   WHERE scope=? AND COALESCE(sensitive,0)=0
                   ORDER BY COALESCE(ts, created_at) DESC LIMIT 1""",
                (scope,),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row:
            out[scope] = dict(row)
    return out


def _body() -> dict[str, Any]:
    try:
        snap = body_state.snapshot(write=False)
        raw = snap.get("raw") or {}
        return {
            "balance": raw.get("balance"),
            "cpu_pct": raw.get("cpu_pct"),
            "mem_pct": raw.get("mem_pct"),
            "temporary_only": True,
        }
    except Exception:
        return {}


def build(conn: sqlite3.Connection) -> dict[str, Any]:
    episode = _latest_episode(conn)
    memory = _latest_memory(conn)
    sleep = _sleep(conn)
    pending = _pending(conn)
    delta, delta_source = _p_delta(conn)
    top_delta = _top_delta(delta)
    desires = _desires(conn)
    who = _who(conn)
    body = _body()

    lines = ["【交接｜刚睡醒】", "你刚结束一次睡眠整理，现在接回 QQ。"]
    if episode:
        where = _place(episode.get("conversation_key"))
        when = _local(episode.get("end_at") or episode.get("start_at"))
        lines.append(f"- 上次停在：{when}{('，' + where) if where else ''}。")
        lines.append(f"  体感摘要：{str(episode.get('summary') or '')[:160]}")
    elif memory:
        lines.append(f"- 上次停在：{_local(memory.get('ts'))}，{_place(memory.get('conversation_key')) or '某处'}。")
    if memory:
        lines.append(
            f"- 最近一句：{memory.get('speaker') or '某人'}：{str(memory.get('text') or '')[:100]}"
        )
    if pending:
        lines.append(f"- 没接完的：有 {pending} 个待确认问题，在本地 questions 里。")
    else:
        lines.append("- 没接完的：当前没有待确认问题。")
    if sleep["count_today"]:
        lines.append(
            f"- 今天这是第 {sleep['count_today']} 次睡眠；上次睡眠结束 {_local(sleep['last_at'])}。"
        )
    else:
        lines.append("- 今天还没有睡眠记录。")
    if who.get("private"):
        p = who["private"]
        lines.append(f"- 最近私聊：{p.get('speaker') or '对方'}：{str(p.get('text') or '')[:80]}")
    if who.get("group"):
        g = who["group"]
        lines.append(f"- 最近群聊：{g.get('speaker') or '对方'}：{str(g.get('text') or '')[:80]}")
    if body.get("balance") is not None:
        lines.append(f"- 身体：API 余额约 {body['balance']}；这些只是临时状态。")

    if top_delta:
        bits = "，".join(f"{k} {v:+.2f}" for k, v in top_delta)
        lines.append(f"- P 今天有明显偏移：{bits}。这是慢变量，不是命令。")
    if desires:
        d = desires[0]
        tier = "轻量念头" if d.get("tier") == "micro" else "欲望"
        lines.append(
            f"- 身体现在给的{tier}：{d.get('hint')} "
            f"（原因：{d.get('why')}；强度 {d.get('urgency')}）"
        )

    lines.extend([
        "",
        "【现在】",
        "先看有没有新消息；有就接，没有就做自己的事。",
        "",
        "【可以核对】",
        "需要旧事时用 soulcore_memory 查 search/range/person/p；",
        "这些是交接线索，不是要求你相信的宣告。",
    ])
    text = "\n".join(lines).strip()
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip() + "\n…"
    return {
        "schema": "emotioncore.handoff.v1",
        "at": db.localnow(),
        "episode": episode,
        "memory": memory,
        "sleep": sleep,
        "pending_questions": pending,
        "p_delta": delta,
        "p_delta_source": delta_source,
        "desires": desires,
        "body": body,
        "text": text,
    }


def write(conn: sqlite3.Connection, *, out: str | Path | None = None) -> dict[str, Any]:
    data = build(conn)
    target = Path(out) if out else (DATA / "handoff.md")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(data["text"] + "\n", encoding="utf-8")
    (DATA / "handoff.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    data["path"] = str(target)
    return data
