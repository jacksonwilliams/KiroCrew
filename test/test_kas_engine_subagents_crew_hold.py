"""``agent.subagents = "crew"``: no agent of a KAS session starts an engine sub-agent.

The engine offers an agent two kinds of sub-agent tool: ``invoke_sub_agent``, and
one ``subagent_<id>`` per agent its registry holds. An agent file whose ``tools``
is ``"*"`` or ``@builtin`` mounts them without naming them, so on ``"crew"`` every
entry of the batch, whatever its file says, carries the one rule the engine takes
both kinds off the tool list for and refuses a call by. Nothing else on an entry
changes, so Kiro Crew's own ``spawn_run`` and ``spawn_sub_agents`` stay. On
``"engine"`` and with the key unset an agent file keeps exactly what it had.
"""

from __future__ import annotations

import fnmatch
import json
from pathlib import Path

import pytest

import kiro_crew.agent as agent_mod
import kiro_crew.config.paths as paths_mod
from kiro_crew.acp import kas_engine_subagents as engine
from kiro_crew.acp.harness.kas import KasHarness
from kiro_crew.config.loader import KiroCrewConfig

_DASHBOARD = "dashboard:t1"
_TARGET = {"name": "mine-target", "prompt": "p", "tools": ["fs_read"]}
_NAMES = ("mine-target", "kirocrew-worker", "kirocrew-helper", "any-other-agent")

#: Parent agent files, by what their ``tools`` (or the rest of the file) says about
#: a sub-agent tool.
_PARENTS: dict[str, dict] = {
    "star-list": {"tools": ["*"]},
    "star-string": {"tools": "*"},
    "builtin-tag": {"tools": ["@builtin", "@kirocrew-core"]},
    "names-use_subagent": {"tools": ["fs_read", "use_subagent", "@kirocrew-core"]},
    "names-invoke_sub_agent": {"tools": ["fs_read", "invoke_sub_agent"]},
    "names-a-per-agent-tool": {"tools": ["fs_read", "subagent_mine-target"]},
    "names-the-per-agent-tag": {"tools": ["fs_read", "subagent/mine-target"]},
    "short-list": {"tools": ["fs_read", "fs_write", "execute_bash", "@kirocrew-core"]},
    "no-tools-field": {},
    "lists-a-target": {
        "tools": ["fs_read", "use_subagent"],
        "toolsSettings": {"subagent": {"availableAgents": ["mine-target"]}},
    },
    "trusts-a-target": {
        "tools": ["*"],
        "toolsSettings": {
            "subagent": {"availableAgents": ["mine-target"], "trustedAgents": ["mine-target"]}
        },
    },
    # An agent installed from outside carries its own permissions block.
    "own-permissions-block": {
        "tools": ["*"],
        "permissions": {
            "rules": [{"capability": "subagent", "match": ["mine-target"], "effect": "allow"}]
        },
    },
    "excludes-only-spawn_run": {"tools": ["*"], "excludedTools": ["@kirocrew-core/spawn_run"]},
}


@pytest.fixture
def agents_dir(monkeypatch, tmp_path) -> Path:
    user = tmp_path / "home" / "agents"
    user.mkdir(parents=True)
    monkeypatch.setattr(paths_mod, "kiro_agents_dir", lambda: user)
    monkeypatch.setattr(agent_mod, "ensure_agent_materialized", lambda _agent: None)
    return user


@pytest.fixture
def setting(monkeypatch):
    """Set ``agent.subagents`` for what the projection reads; ``None`` leaves the default."""

    def _set(value: str | None) -> None:
        cfg = KiroCrewConfig()
        if value is not None:
            cfg.agent.subagents = value
        monkeypatch.setattr(KiroCrewConfig, "load", classmethod(lambda _cls, *a, **k: cfg))

    return _set


def _write(directory: Path, spec: dict) -> None:
    (directory / f"{spec['name']}.json").write_text(json.dumps(spec), encoding="utf-8")


async def _batch(agent: str = "mine", key: str = _DASHBOARD, **kw) -> list[dict]:
    extras = await KasHarness().session_extras(agent, work_dir=None, session_key=key, **kw)
    return extras.custom_agents


async def _unswitched(monkeypatch, agent: str = "mine", key: str = _DASHBOARD, **kw):
    """The batch with neither value acting on it: what the projection built before the switch."""
    with monkeypatch.context() as m:
        m.setattr(engine, "engine_subagents_on", lambda *a, **k: False)
        m.setattr(engine, "without_engine_subagents", lambda batch: batch, raising=False)
        return await _batch(agent, key, **kw)


def _rules(entry: dict) -> list[dict]:
    return (entry.get("permissions") or {}).get("rules") or []


def _refused(entry: dict, name: str) -> bool:
    """Whether *entry* denies a sub-agent call naming *name*, as KAS reads a rule."""
    return any(
        r.get("capability") == "subagent"
        and r.get("effect") == "deny"
        and any(fnmatch.fnmatchcase(name, p) for p in r.get("match") or ["*"])
        and not any(fnmatch.fnmatchcase(name, p) for p in r.get("exclude") or [])
        for r in _rules(entry)
    )


def _takes_the_tools_off(entry: dict) -> bool:
    """Whether KAS drops every ``subagent`` tool from *entry*'s tool list.

    KAS does that for a capability denied whole: a ``deny`` with no ``exclude``
    whose ``match`` is absent, empty or exactly ``["*"]``.
    """
    return any(
        r.get("capability") == "subagent"
        and r.get("effect") == "deny"
        and r.get("match") in (None, [], ["*"])
        and not r.get("exclude")
        for r in _rules(entry)
    )


def _but_permissions(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if k != "permissions"}


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", sorted(_PARENTS))
async def test_crew_keeps_every_parent_file_off_the_engines_sub_agents(
    agents_dir, setting, monkeypatch, kind
):
    _write(agents_dir, {"name": "mine", "prompt": "p", **_PARENTS[kind]})
    _write(agents_dir, _TARGET)
    setting("crew")

    batch = await _batch()
    before = await _unswitched(monkeypatch)

    assert [a["id"] for a in batch] == [a["id"] for a in before]
    for entry, was in zip(batch, before, strict=True):
        assert _takes_the_tools_off(entry), entry["id"]
        assert [n for n in _NAMES if not _refused(entry, n)] == [], entry["id"]
        # Only a rule was added: its tools, exclusions and servers are the file's,
        # so Kiro Crew's own spawn tools are mounted exactly as before.
        assert _but_permissions(entry) == _but_permissions(was), entry["id"]
        assert _rules(entry)[: len(_rules(was))] == _rules(was), entry["id"]
        assert all(r.get("capability") == "subagent" for r in _rules(entry)[len(_rules(was)) :])


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["engine", None], ids=["engine", "unset"])
@pytest.mark.parametrize("kind", sorted(_PARENTS))
async def test_engine_and_unset_leave_a_users_agent_as_its_file_says(
    agents_dir, setting, monkeypatch, value, kind
):
    _write(agents_dir, {"name": "mine", "prompt": "p", **_PARENTS[kind]})
    _write(agents_dir, _TARGET)
    setting(value)
    assert await _batch() == await _unswitched(monkeypatch)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key",
    ["dashboard:t1", "dashboard:member-ada", "cron:job-1", "subagent:abc", "slack:C1:T1", ""],
)
async def test_crew_holds_in_every_kind_of_kas_session(agents_dir, setting, key):
    _write(agents_dir, {"name": "mine", "prompt": "p", "tools": ["*"]})
    setting("crew")
    [entry] = await _batch(key=key)
    assert _takes_the_tools_off(entry)


@pytest.mark.asyncio
async def test_crew_holds_for_a_member_dispatch_and_a_remote_workspace(agents_dir, setting):
    _write(agents_dir, {"name": "mine", "prompt": "p", "tools": ["*"]})
    setting("crew")
    for kw in ({"member_dispatch": True}, {"crew_panel": True}, {"remote_workspace": True}):
        [entry] = await _batch(**kw)
        assert _takes_the_tools_off(entry), kw


@pytest.mark.asyncio
async def test_crew_holds_the_default_agent_and_mounts_no_helper(agents_dir, setting):
    defaults = Path(engine.__file__).parents[1] / "config" / "defaults.json"
    shipped = json.loads(defaults.read_text(encoding="utf-8"))
    spec = {"tools": shipped["tools"], "allowedTools": shipped["allowedTools"]}
    _write(agents_dir, {"name": "kirocrew", "prompt": "p", **spec})
    setting("crew")
    [entry] = await _batch("kirocrew")
    assert _takes_the_tools_off(entry)
    assert "@kirocrew-core/spawn_sub_agents" not in (entry.get("excludedTools") or [])
    assert "@kirocrew-core" in entry["tools"]


@pytest.mark.asyncio
async def test_the_hold_is_recorded_once_per_entry_and_only_on_crew(
    agents_dir, setting, monkeypatch
):
    import types

    from kiro_crew.acp import kas_subagent_targets

    events: list[dict] = []
    monkeypatch.setattr(
        kas_subagent_targets,
        "sel",
        lambda: types.SimpleNamespace(log_api_access=lambda **kw: events.append(kw)),
    )
    _write(agents_dir, {"name": "mine", "prompt": "p", **_PARENTS["lists-a-target"]})
    _write(agents_dir, _TARGET)

    setting("crew")
    batch = await _batch()
    held = [e for e in events if e["operation"] == "kas_engine_subagents_off"]
    assert [e["resources"] for e in held] == [
        f"every engine sub-agent denied (agent.subagents is crew) for agent {a['id']}"
        for a in batch
    ]
    assert {e["source"] for e in held} == {"kas_agent_projection"}

    events.clear()
    setting("engine")
    await _batch()
    assert [e for e in events if e["operation"] == "kas_engine_subagents_off"] == []


def test_an_entry_that_already_spawns_nothing_is_returned_as_it_is():
    """``availableAgents: []`` projects the same rule; it is not sent twice."""
    entry = {
        "id": "mine",
        "tools": "*",
        "permissions": {"rules": [{"capability": "subagent", "effect": "deny"}]},
    }
    assert engine.without_engine_subagents([entry]) == [entry]
