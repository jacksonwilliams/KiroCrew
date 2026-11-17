"""A Bot's held limits on its Profile tab (``handlers/members_held_limits.py``).

Pins that the owner reads them and ends them in one release that writes one audit
row naming who did it; that a release of a list other than the recorded one
clears nothing; and that an app token, a non-owner dashboard user and an
internal-secret caller are refused before the request body is read.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import kiro_crew.config.paths as paths_mod
from kiro_crew.config.loader import KiroCrewAgentConfig, KiroCrewConfig
from kiro_crew.dashboard.handlers import members_held_limits

pytestmark = pytest.mark.asyncio

OWNER = "U0OWNER0000"
BOT = "zxc"
RULES = [
    {"text": "deny shell commands", "capability": "shell"},
    {"text": "the agentSpawn hook", "capability": "none"},
]
#: The Bot's member id, which is also its slug.
MEMBER_ID = "zxc-1"
URL = f"/api/members/{MEMBER_ID}/held-limits"


@pytest.fixture
def ledger(monkeypatch, tmp_path) -> Path:
    mates = tmp_path / "home" / "mates" / "agents"
    mates.mkdir(parents=True)
    monkeypatch.setattr(paths_mod, "kiro_home", lambda: tmp_path / "home")
    cfg = KiroCrewConfig()
    cfg.agents = {BOT: KiroCrewAgentConfig(member_id=MEMBER_ID, kiro_agent=BOT)}
    monkeypatch.setattr(KiroCrewConfig, "load", staticmethod(lambda: cfg))
    path = mates.parent / "migrated.json"
    path.write_text(json.dumps({"held_rules": {BOT: {"member_id": MEMBER_ID, "rules": RULES}}}))
    return path


@pytest.fixture
def sel(monkeypatch) -> MagicMock:
    import kiro_crew.dashboard.handlers as handlers_pkg

    log = MagicMock()
    monkeypatch.setattr(handlers_pkg, "sel", lambda: log)
    return log


def _client(**claims: object) -> TestClient:
    @web.middleware
    async def identity(request: web.Request, handler):
        for key, value in claims.items():
            request[key] = value
        return await handler(request)

    app = web.Application(middlewares=[identity])
    app["state"] = SimpleNamespace(owner_id=OWNER)
    app.router.add_get(
        URL.replace(MEMBER_ID, "{slug}"), members_held_limits.api_member_held_limits_get
    )
    app.router.add_post(
        URL.replace(MEMBER_ID, "{slug}") + "/release",
        members_held_limits.api_member_held_limits_release,
    )
    return TestClient(TestServer(app))


def _held(ledger: Path) -> dict:
    return json.loads(ledger.read_text()).get("held_rules", {})


async def test_the_owner_reads_the_held_limits(ledger, sel):
    async with _client(user=OWNER, app="") as client:
        response = await client.get(URL, params={"member": BOT})
        assert response.status == 200
        body = await response.json()

    assert body["limits"] == RULES
    assert isinstance(body["kiro_cli"], bool)
    sel.log_api_access.assert_not_called()


async def test_the_owners_release_clears_the_entry_and_writes_one_audit_row(ledger, sel):
    async with _client(user=OWNER, app="") as client:
        response = await client.post(URL + "/release", json={"member": BOT, "limits": RULES})
        assert response.status == 200
        assert await response.json() == {"released": RULES}

    assert BOT not in _held(ledger)
    sel.log_api_access.assert_called_once()
    row = sel.log_api_access.call_args.kwargs
    assert row["caller"] == OWNER
    assert row["operation"] == "members.held_limits.release"
    assert row["outcome"] == "allowed"
    assert row["resources"] == (
        f"bot={BOT} member_id={MEMBER_ID} limits=deny shell commands; the agentSpawn hook"
    )


async def test_a_release_of_a_list_that_changed_is_409_and_clears_nothing(ledger, sel):
    async with _client(user=OWNER, app="") as client:
        response = await client.post(URL + "/release", json={"member": BOT, "limits": RULES[:1]})
        assert response.status == 409
        assert (await response.json())["code"] == "held_limits_changed"

    assert _held(ledger)[BOT]["rules"] == RULES
    sel.log_api_access.assert_not_called()


@pytest.mark.parametrize(
    "claims, status",
    [
        ({"user": OWNER, "app": "some-app"}, 404),
        ({"user": "U0NONOWNER", "app": ""}, 403),
        ({"user": "internal", "internal_auth": True}, 403),
    ],
    ids=["app-token", "non-owner", "internal-secret"],
)
async def test_a_caller_other_than_the_owner_is_refused_before_the_body(ledger, claims, status):
    async with _client(**claims) as client:
        read = await client.get(URL, params={"member": BOT})
        assert read.status == status
        assert "deny shell" not in await read.text()
        for body in ({"member": BOT, "limits": RULES}, None):
            release = await client.post(URL + "/release", json=body)
            assert release.status == status

    assert _held(ledger)[BOT]["rules"] == RULES
