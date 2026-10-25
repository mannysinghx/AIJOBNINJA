"""Unit tests for the shared fork-detection helper (issue #496).

The placeholder guards must skip on personalized forks even in a local run
where GITHUB_REPOSITORY is unset. All branches are exercised with the env
and subprocess.run patched, so no git remote or CI variable is needed.
"""
import os
import subprocess
import unittest
from unittest import mock

try:
    from tests import _upstream
    from tests._upstream import is_upstream_checkout
except ImportError:  # `python -m unittest discover -s tests` imports test modules top-level
    import _upstream
    from _upstream import is_upstream_checkout

UPSTREAM = "mannysinghx/AIJOBNINJA"


def _no_github_env(testcase):
    """Clear GITHUB_REPOSITORY so the origin-remote branch is exercised."""
    patcher = mock.patch.dict(os.environ)
    env = patcher.start()
    testcase.addCleanup(patcher.stop)
    env.pop("GITHUB_REPOSITORY", None)
    return env


def _completed(stdout="", returncode=0):
    return subprocess.CompletedProcess(
        args=["git", "remote", "get-url", "origin"],
        returncode=returncode,
        stdout=stdout,
    )


class UpstreamCheckoutTests(unittest.TestCase):
    def test_env_says_upstream(self):
        with mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": UPSTREAM}):
            with mock.patch.object(_upstream.subprocess, "run") as run:
                self.assertTrue(is_upstream_checkout())
                run.assert_not_called()

    def test_env_says_fork(self):
        with mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "someone-else/aijobninja"}):
            with mock.patch.object(_upstream.subprocess, "run") as run:
                self.assertFalse(is_upstream_checkout())
                run.assert_not_called()

    def test_no_env_and_origin_is_fork(self):
        _no_github_env(self)
        with mock.patch.object(
            _upstream.subprocess, "run", return_value=_completed("git@github.com:someone-else/aijobninja.git\n")
        ):
            self.assertFalse(is_upstream_checkout())

    def test_no_env_and_git_is_unavailable(self):
        _no_github_env(self)
        with mock.patch.object(
            _upstream.subprocess, "run", side_effect=OSError("no git on PATH")
        ):
            self.assertTrue(is_upstream_checkout())

    def test_no_env_and_git_times_out(self):
        _no_github_env(self)
        with mock.patch.object(
            _upstream.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="git", timeout=10),
        ):
            self.assertTrue(is_upstream_checkout())

    def test_no_env_and_git_exits_nonzero(self):
        _no_github_env(self)
        with mock.patch.object(
            _upstream.subprocess, "run", return_value=_completed("", returncode=128)
        ):
            self.assertTrue(is_upstream_checkout())

    def test_origin_url_forms(self):
        cases = [
            ("https://github.com/mannysinghx/AIJOBNINJA", True),
            ("https://github.com/mannysinghx/AIJOBNINJA", True),
            ("git@github.com:mannysinghx/AIJOBNINJA", True),
            ("git@github.com:mannysinghx/AIJOBNINJA.git", True),
            ("ssh://git@github.com/mannysinghx/AIJOBNINJA.git", True),
            ("ssh://git@github.com/mannysinghx/AIJOBNINJA", True),
            ("ssh://git@github.com/someone-else/aijobninja.git", False),
            ("https://github.com/someone-else/aijobninja.git", False),
            ("git@github.com:someone-else/aijobninja", False),
            ("https://gitlab.com/mannysinghx/AIJOBNINJA.git", False),
        ]
        for url, expected in cases:
            with self.subTest(url=url):
                _no_github_env(self)
                with mock.patch.object(
                    _upstream.subprocess, "run", return_value=_completed(url + "\n")
                ):
                    self.assertEqual(is_upstream_checkout(), expected)


if __name__ == "__main__":
    unittest.main()
