import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


PYTHON = Path(__file__).parents[2] / 'src' / 'extensions' / 'python'
TMP_ROOT = Path(tempfile.gettempdir())
if str(PYTHON) not in sys.path:
    sys.path.insert(0, str(PYTHON))

import line_client_compatibility as compatibility


def load_status_module():
    spec = importlib.util.spec_from_file_location(
        'line_reader_status_under_test', PYTHON / 'line-reader-status.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


status = load_status_module()


class ClientCompatibilityTests(unittest.TestCase):
    def setUp(self):
        TMP_ROOT.mkdir(mode=0o777, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def _write_manifest(self, executable, *, version='1.2.3.4', extra=None):
        digest = hashlib.sha256(executable.read_bytes()).hexdigest()
        manifest = {
            'v': 1,
            'builds': [{
                'version': version,
                'bytes': executable.stat().st_size,
                'sha256': digest,
            }],
        }
        if extra:
            manifest.update(extra)
        path = self.root / 'builds.json'
        path.write_text(json.dumps(manifest), encoding='utf-8')
        return path, digest

    def _assert_unverified(self, callback, forbidden):
        with self.assertRaises(compatibility.ClientBuildError) as caught:
            callback()
        self.assertEqual(caught.exception.code, 'LINE_BUILD_UNVERIFIED')
        self.assertEqual(str(caught.exception), 'LINE_BUILD_UNVERIFIED')
        self.assertNotIn(str(forbidden), str(caught.exception))

    def test_known_manifest_is_closed_and_lists_only_the_reviewed_builds(self):
        version, builds = compatibility._read_manifest(compatibility.MANIFEST_PATH)
        self.assertEqual(version, 1)
        self.assertEqual(builds, [{
            'version': '26.4.2.3957',
            'bytes': 30634432,
            'sha256': '893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',
        }, {
            'version': '26.5.0.3975',
            'bytes': 30628288,
            'sha256': 'efdfc8fc3a5dd59afc9bb561897b8defac59fd212a6775d4400146ae5ccd7040',
        }, {
            'version': '26.6.0.4004',
            'bytes': 31071680,
            'sha256': 'ce2f4b88857db34bfe4c5d9628daa814a42a75cf41540330d21b6ae5e5548447',
        }])

    def test_verified_build_returns_only_public_compatibility_fields(self):
        executable = self.root / 'LINE.exe'
        executable.write_bytes(b'line-compatible-fixture')
        manifest, digest = self._write_manifest(executable)

        result = compatibility.verify_client_build(executable, manifest_path=manifest)

        self.assertEqual(result, {
            'verified': True,
            'version': '1.2.3.4',
            'buildRef': f'sha256:{digest}',
        })
        public = json.dumps(result, sort_keys=True)
        self.assertNotIn(str(executable), public)
        self.assertNotIn(str(manifest), public)
        self.assertNotIn('bytes', public)
        self.assertNotIn('manifestVersion', public)

    def test_manifest_source_and_build_drift_fail_closed_without_source_paths(self):
        executable = self.root / 'LINE.exe'
        executable.write_bytes(b'first-build')
        manifest, _ = self._write_manifest(executable)

        executable.write_bytes(b'changed-build')
        self._assert_unverified(
            lambda: compatibility.verify_client_build(executable, manifest_path=manifest), executable)

        manifest.write_text(json.dumps({'v': 1, 'builds': [], 'unexpected': True}), encoding='utf-8')
        self._assert_unverified(
            lambda: compatibility.verify_client_build(executable, manifest_path=manifest), manifest)

        with mock.patch.object(compatibility, '_read_file', side_effect=compatibility._SourceChanged):
            self._assert_unverified(
                lambda: compatibility.verify_client_build(executable, manifest_path=manifest), executable)

        with mock.patch.object(compatibility, '_read_file', side_effect=compatibility.SnapshotError('SOURCE_REPARSE')):
            self._assert_unverified(
                lambda: compatibility.verify_client_build(executable, manifest_path=manifest), executable)

    def test_read_contract_keeps_the_executable_streaming_and_bounded(self):
        digest = hashlib.sha256(b'fixture').digest()
        manifest_bytes = json.dumps({
            'v': 1,
            'builds': [{
                'version': '1.2.3.4',
                'bytes': 7,
                'sha256': digest.hex(),
            }],
        }).encode('utf-8')
        calls = []

        def read_file(path, **kwargs):
            calls.append((Path(path).name, kwargs))
            if Path(path).name == 'builds.json':
                return SimpleNamespace(data=manifest_bytes, digest=b'manifest', size=len(manifest_bytes))
            return SimpleNamespace(data=None, digest=digest, size=7)

        with mock.patch.object(compatibility, '_read_file', side_effect=read_file):
            result = compatibility.verify_client_build(
                self.root / 'LINE.exe', manifest_path=self.root / 'builds.json')

        self.assertEqual(result['verified'], True)
        self.assertEqual(calls, [
            ('builds.json', {'optional': False, 'keep_data': True,
                             'max_bytes': compatibility.MAX_MANIFEST_BYTES}),
            ('LINE.exe', {'optional': False, 'keep_data': False,
                          'max_bytes': compatibility.MAX_CLIENT_BYTES}),
        ])

    def test_process_query_uses_limited_handle_and_hashes_volatile_identity(self):
        executable = self.root / 'LINE.exe'
        created_filetime = 0x0123456789ABCDEF
        calls = {'close': 0}

        def open_process(access, inherit, pid):
            calls['open'] = (access, inherit, pid)
            return 17

        def image_name(handle, flags, buffer, capacity):
            buffer.value = str(executable)
            return True

        def process_times(handle, created, exited, kernel_time, user_time):
            created._obj.dwLowDateTime = created_filetime & 0xFFFFFFFF
            created._obj.dwHighDateTime = created_filetime >> 32
            return True

        def close_handle(handle):
            calls['close'] += 1

        kernel = SimpleNamespace(
            OpenProcess=open_process,
            QueryFullProcessImageNameW=image_name,
            GetProcessTimes=process_times,
            CloseHandle=close_handle,
        )
        build_ref = 'sha256:' + 'a' * 64
        result = status._query_process(kernel, 4242, executable, build_ref)

        self.assertEqual(calls['open'], (status.PROCESS_QUERY_LIMITED_INFORMATION, False, 4242))
        self.assertEqual(calls['close'], 1)
        self.assertEqual(set(result), {'processInstanceRef'})
        self.assertRegex(result['processInstanceRef'], r'^process:[0-9a-f]{64}$')
        public = json.dumps(result)
        self.assertNotIn(str(executable), public)
        self.assertNotIn(f'{created_filetime:016x}', public)
        self.assertNotIn('4242', public)

    def test_pid_enumeration_treats_only_no_more_files_as_a_normal_end(self):
        def make_kernel(*, snapshot=7, first=True, next_result=False, executable='LINE.exe'):
            calls = {'closed': 0}

            def create_snapshot(flags, pid):
                return snapshot

            def process_first(handle, entry):
                if first:
                    entry._obj.exe = executable
                    entry._obj.pid = 4242
                return first

            def process_next(handle, entry):
                return next_result

            def close_handle(handle):
                calls['closed'] += 1

            return SimpleNamespace(
                CreateToolhelp32Snapshot=create_snapshot,
                Process32FirstW=process_first,
                Process32NextW=process_next,
                CloseHandle=close_handle,
            ), calls

        kernel, calls = make_kernel(snapshot=status.ct.c_void_p(-1).value)
        self.assertIsNone(status._line_pids(kernel))
        self.assertEqual(calls['closed'], 0)

        kernel, calls = make_kernel(first=False)
        with mock.patch.object(status.ct, 'get_last_error', return_value=5):
            self.assertIsNone(status._line_pids(kernel))
        self.assertEqual(calls['closed'], 1)

        kernel, calls = make_kernel(first=False)
        with mock.patch.object(status.ct, 'get_last_error', return_value=status.ERROR_NO_MORE_FILES):
            self.assertEqual(status._line_pids(kernel), [])
        self.assertEqual(calls['closed'], 1)

        kernel, calls = make_kernel()
        with mock.patch.object(status.ct, 'get_last_error', return_value=status.ERROR_NO_MORE_FILES):
            self.assertEqual(status._line_pids(kernel), [4242])
        self.assertEqual(calls['closed'], 1)

        kernel, calls = make_kernel()
        with mock.patch.object(status.ct, 'get_last_error', return_value=5):
            self.assertIsNone(status._line_pids(kernel))
        self.assertEqual(calls['closed'], 1)

    def test_running_status_preserves_name_level_enumeration_and_query_outcomes(self):
        def api(*args):
            return 0

        kernel = SimpleNamespace(
            CreateToolhelp32Snapshot=api,
            Process32FirstW=api,
            Process32NextW=api,
            OpenProcess=api,
            CloseHandle=api,
            QueryFullProcessImageNameW=api,
            GetProcessTimes=api,
        )
        expected = self.root / 'LINE.exe'
        build_ref = 'sha256:' + 'c' * 64
        cases = [
            (None, None, {'state': 'not_available'}),
            ([], None, {'state': 'not_running'}),
            ([1, 2], None, {'state': 'ambiguous', 'processCount': 2}),
            ([1], None, {'state': 'unverified'}),
            ([1], OSError('query denied'), {'state': 'unverified'}),
            ([1], {'processInstanceRef': 'process:' + 'd' * 64},
             {'state': 'running', 'processInstanceRef': 'process:' + 'd' * 64}),
        ]
        for pids, queried, expected_status in cases:
            with self.subTest(pids=pids, queried=queried):
                query_patch = {'side_effect': queried} if isinstance(queried, Exception) else {'return_value': queried}
                with mock.patch.object(status.os, 'name', 'nt'), \
                        mock.patch.object(status.ct, 'WinDLL', return_value=kernel), \
                        mock.patch.object(status, '_line_pids', return_value=pids), \
                        mock.patch.object(status, '_query_process', **query_patch) as query:
                    result = status._running_process(expected, build_ref)
                self.assertEqual(result, expected_status)
                if pids == [1]:
                    query.assert_called_once_with(kernel, 1, expected, build_ref)
                else:
                    query.assert_not_called()

    def test_status_short_circuits_unverified_build_and_cli_emits_public_json(self):
        executable = self.root / 'private-LINE.exe'
        with mock.patch.object(status, 'verify_client_build', side_effect=compatibility.ClientBuildError()), \
                mock.patch.object(status, '_running_process') as running:
            result = status.get_client_status(executable)
        self.assertEqual(result, {
            'ok': False,
            'code': 'LINE_BUILD_UNVERIFIED',
            'client': {'verified': False},
            'process': {'state': 'not_checked'},
        })
        running.assert_not_called()
        self.assertNotIn(str(executable), json.dumps(result))

        success = {
            'ok': True,
            'client': {'verified': True, 'version': '1.2.3.4', 'buildRef': 'sha256:' + 'b' * 64},
            'process': {'state': 'not_running'},
        }
        stdout = io.StringIO()
        with mock.patch.object(status, 'get_client_status', return_value=success), \
                contextlib.redirect_stdout(stdout):
            self.assertEqual(status.main(['--exe', str(executable)]), 0)
        self.assertEqual(json.loads(stdout.getvalue()), success)
        self.assertNotIn(str(executable), stdout.getvalue())

        stdout = io.StringIO()
        with mock.patch.object(status, 'get_client_status', return_value=result), \
                contextlib.redirect_stdout(stdout):
            self.assertEqual(status.main(['--exe', str(executable)]), 2)
        self.assertEqual(json.loads(stdout.getvalue()), result)


if __name__ == '__main__':
    unittest.main()
