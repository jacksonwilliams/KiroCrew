"""The run side of ``spawn_run``'s ``isolate: "worktree"``: make, record, report, remove.

An isolated run gets a git worktree of its own at run start
(:func:`prepare_run_worktree`, from ``subagent_manager/run_turn.py``), recorded in
the run's PROTECTED record folder, outside the agent-writable run folder, so
nothing the agent writes decides what is later removed. Its completion event says
where it worked and which commits it made (:func:`completion_note`). Once the
run's retention ends -- its prune, or ``spawn_release`` -- a clean worktree is
removed and any other is kept (:func:`remove_recorded_worktree`): never at the
moment the worker finishes, because a continuation goes to the run's recorded cwd.

The git work itself is :mod:`kiro_crew.crewmate_worktree`'s. Every function here
blocks; callers run them off the event loop.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

logger = logging.getLogger(__name__)

#: The one value ``spawn_run``'s ``isolate`` takes.
ISOLATE_WORKTREE = "worktree"


def prepare_run_worktree(run_id: str, cwd: str) -> Any:
    """Make (or reuse) run *run_id*'s worktree from the checkout *cwd* is in; its ``RunWorktree``.

    The worktree is recorded (path and base) in the run's protected folder before
    it is handed back, and a display copy goes to ``state.json`` for
    ``spawn_status``. The folder must pass ``validate_cwd`` as any ``cwd`` does,
    so a continuation is admitted there too. A run made again (a recovery
    attempt) keeps the base it was first recorded with. Raises
    ``WorktreeRefused`` with a plain reason, and leaves nothing it made behind.
    """
    from kiro_crew.config.loader import KiroCrewConfig
    from kiro_crew.crewmate_worktree import WorktreeRefused, make_run_worktree
    from kiro_crew.subagent import validate_cwd
    from kiro_crew.subagent_persistence import (
        read_run_worktree_record,
        update_state,
        write_run_worktree_record,
    )

    try:
        roots = list(KiroCrewConfig.load().agent.subagent_cwd_allowed_roots or [])
    except Exception:  # noqa: BLE001 - fail closed, as the cwd gate does
        roots = []
    recorded = read_run_worktree_record(run_id)
    made = make_run_worktree(cwd, run_id, roots)
    if recorded is not None and recorded[0] == made.path:
        made = replace(made, base=recorded[1])
    _resolved, refusal = validate_cwd(made.cwd, roots)
    if refusal:
        _undo(run_id, made, recorded)
        raise WorktreeRefused(f"isolate: the worktree {made.path} fails the cwd check: {refusal}")
    if recorded != (made.path, made.base):
        try:
            write_run_worktree_record(run_id, made.path, made.base)
        except Exception as exc:  # noqa: BLE001 - an unrecorded worktree would never be removed
            _undo(run_id, made, recorded)
            raise WorktreeRefused(f"isolate: the worktree could not be recorded ({exc})") from None
    try:
        update_state(run_id, worktree={"path": made.path, "base": made.base})
    except Exception:  # noqa: BLE001 - a display copy only
        logger.debug("run %s: worktree display copy not written", run_id, exc_info=True)
    return made


def _undo(run_id: str, made: Any, recorded: "tuple[str, str] | None") -> None:
    """Remove a worktree this attempt made and could not hand out (only while clean)."""
    if recorded is None:
        from kiro_crew.crewmate_worktree import remove_run_worktree

        remove_run_worktree(made.path, made.base, run_id)


def completion_note(run_id: str, made: Any) -> str:
    """The completion event's line for run *run_id*'s worktree: where, and its commits.

    At most 20 short shas of ``base..HEAD`` and the count of all of them, or that
    there were none. Never raises.
    """
    from kiro_crew.crewmate_worktree import remove_run_worktree

    head = (
        f"Note: Agent `{run_id}` worked in its own git worktree {made.path} "
        f"(detached at {made.base[:12]})"
    )
    report = remove_run_worktree(made.path, made.base, run_id, remove=False)
    if report.commit_count == 0:
        return f"{head}; it made no commits."
    if report.commit_count < 0 or not report.commits:
        return f"{head}; its commits could not be read."
    more = report.commit_count - len(report.commits)
    shown = ", ".join(report.commits) + (f" and {more} more" if more > 0 else "")
    return (
        f"{head}; {report.commit_count} commit(s) {made.base[:12]}..HEAD: {shown}. "
        "The worktree is kept there; review or merge the commits from it."
    )


def remove_recorded_worktree(run_id: str, record: "tuple[str, str] | None") -> None:
    """At the end of run *run_id*'s retention, remove its recorded worktree if clean.

    *record* is the gateway's own ``(path, base)``
    (``subagent_persistence.read_run_worktree_record``), never the agent-writable
    ``state.json``. A kept worktree, or a removal that fails, is logged and left
    in place; this never raises, so it cannot block the prune or the release.
    """
    if record is None:
        return
    try:
        from kiro_crew.crewmate_worktree import remove_run_worktree

        report = remove_run_worktree(record[0], record[1], run_id)
    except Exception:  # noqa: BLE001 - never blocks the prune or the release
        logger.warning("run %s: worktree %s not removed", run_id, record[0], exc_info=True)
        return
    if not report.removed:
        logger.info("run %s: worktree %s kept: %s", run_id, record[0], report.kept_because)
