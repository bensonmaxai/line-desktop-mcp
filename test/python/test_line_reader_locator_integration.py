import datetime as dt
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock


PYTHON = Path(__file__).parents[2] / 'src' / 'extensions' / 'python'
sys.path.insert(0, str(PYTHON))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, PYTHON / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = load('reader_locator_integration', 'line-reader.py')


class ReaderLocatorIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.build_check = mock.patch.object(reader, 'verify_client_build',
            return_value={'verified': True, 'version': '0.0.0.1', 'buildRef': 'synthetic'})
        self.build_check.start()
        self.addCleanup(self.build_check.stop)
        self.work = Path(tempfile.mkdtemp(prefix='reader-locator-integration-'))
        self.database = self.work / 'LINE' / 'Data' / 'db' / 'fixture.edb'
        self.database.parent.mkdir(parents=True)
        self.database.write_bytes(b'encrypted fixture')
        self.runtime_dir = mock.patch.object(reader, 'application_runtime_dir', return_value=self.work)
        self.runtime_dir.start()
        self.addCleanup(self.runtime_dir.stop)
        self.cache_commit = object()
        self.metrics = reader.session_locator.KeyMetrics({
            'keyValidated': True,
            'keyAcquisition': 'locator',
            'scanSeconds': 0.01,
            'scanBytes': 4096,
            'scanStoppedAfterValidation': True,
        }, self.cache_commit)

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def _snapshot(self, sequence):
        return {
            'captureCompletedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
            'sequence': sequence,
        }

    def test_multiple_main_databases_use_only_unique_current_key_match(self):
        inactive = self.database.with_name('inactive.edb')
        inactive.write_bytes(b'inactive encrypted fixture')
        os.utime(inactive, ns=(1_000_000_000, 1_000_000_000))
        os.utime(self.database, ns=(2_000_000_000, 2_000_000_000))
        scope = {'chatName': 'Synthetic', 'dateFrom': '2026-09-11',
                 'dateTo': '2026-09-11'}

        for inactive_matches in (False, True):
            with self.subTest(inactive_matches=inactive_matches):
                captured = []
                connection = mock.MagicMock()
                connection.__enter__.return_value.version = {'fixture': True}

                def prefix(path, *, limits):
                    if path == self.database:
                        return b'active'
                    if path == inactive:
                        return b'inactive'
                    self.assertEqual(path.name, 'snapshot.edb')
                    return b'snapshot'

                def capture(source, directory, *, limits):
                    captured.append(source)
                    path = directory / 'snapshot.edb'
                    path.write_bytes(b'encrypted snapshot')
                    return path, self._snapshot(1)

                def matches(first_page, key):
                    self.assertEqual(key, b'active-key')
                    return first_page == b'snapshot' or (
                        first_page == b'inactive' and inactive_matches)

                with mock.patch.dict(reader.os.environ, {'LOCALAPPDATA': str(self.work)}), \
                     mock.patch.object(reader, 'read_database_prefix', side_effect=prefix), \
                     mock.patch.object(reader, 'capture_snapshot_to', side_effect=capture), \
                     mock.patch.object(reader, 'acquire_passphrase',
                                       return_value=(b'active-key', {'keyValidated': True})), \
                     mock.patch.object(reader, 'passphrase_matches', side_effect=matches), \
                     mock.patch.object(reader, 'Connection', return_value=connection), \
                     mock.patch.object(reader, 'read_scoped',
                                       return_value={'messages': [], 'count': 0}), \
                     mock.patch.object(reader.session_locator, 'commit_after_success'):
                    if inactive_matches:
                        with self.assertRaises(reader.ReaderError) as caught:
                            reader.run(scope)
                        self.assertEqual(caught.exception.code, 'MAIN_DATABASE_AMBIGUOUS')
                        self.assertEqual(captured, [])
                        connection.assert_not_called()
                    else:
                        self.assertTrue(reader.run(scope)['freshness']['capturedAfterInitialization'])
                        self.assertEqual(captured, [self.database])

    def _run_patches(self, *, read_result=None, matches=True, read_error=None):
        events = []
        connection = mock.MagicMock()
        connection.__enter__.return_value.version = {'fixture': True}

        def prefix(path, *, limits):
            if path == self.database:
                events.append('bootstrap')
                return b'b' * 4096
            self.assertEqual(path.name, 'snapshot.edb')
            return path.read_bytes()

        def capture(_, directory, *, limits):
            events.append('capture')
            path = directory / 'snapshot.edb'
            path.write_bytes(b'f' * 4096)
            return path, self._snapshot(2)

        def acquire(*_):
            events.append('acquire')
            return b'not-a-real-key', self.metrics

        def revalidate(prefix, key):
            self.assertEqual(events[-1], 'capture')
            self.assertEqual(prefix, b'f' * 4096)
            self.assertEqual(key, b'not-a-real-key')
            events.append('revalidate')
            return matches

        def open_snapshot(path, key):
            self.assertEqual(events[-1], 'revalidate')
            self.assertEqual(path.name, 'snapshot.edb')
            self.assertEqual(path.read_bytes(), b'f' * 4096)
            events.append('open')
            return connection

        def scoped(*_):
            events.append('read')
            if read_error is not None:
                raise read_error
            return read_result if read_result is not None else {'messages': [], 'count': 0}

        commit = mock.Mock(side_effect=lambda value: events.append('commit') or True)
        open_connection = mock.Mock(side_effect=open_snapshot)
        patches = (
            mock.patch.dict(reader.os.environ, {'LOCALAPPDATA': str(self.work)}),
            mock.patch.multiple(reader,
                read_database_prefix=mock.Mock(side_effect=prefix),
                capture_snapshot_to=mock.Mock(side_effect=capture)),
            mock.patch.object(reader, 'acquire_passphrase', side_effect=acquire),
            mock.patch.object(reader, 'passphrase_matches', side_effect=revalidate),
            mock.patch.object(reader, 'Connection', open_connection),
            mock.patch.object(reader, 'read_scoped', side_effect=scoped),
            mock.patch.object(reader.session_locator, 'commit_after_success', commit),
        )
        return events, commit, open_connection, patches

    def test_invalid_scope_rejects_before_snapshot_or_key_acquisition(self):
        invalid = reader.ReaderError('INVALID_SCOPE')
        with mock.patch.object(reader, 'validate_scope', side_effect=invalid), \
             mock.patch.object(reader, 'verify_client_build') as build, \
             mock.patch.object(reader, 'capture_snapshot_to') as capture, \
             mock.patch.object(reader, 'acquire_passphrase') as acquire, \
             mock.patch.object(reader.session_locator, 'commit_after_success') as commit:
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'unexpected': True})
        self.assertEqual(error.exception.code, 'INVALID_SCOPE')
        build.assert_not_called()
        capture.assert_not_called()
        acquire.assert_not_called()
        commit.assert_not_called()

    def test_unknown_client_build_refuses_before_database_or_process_reads(self):
        with mock.patch.object(reader, 'verify_client_build', side_effect=reader.ClientBuildError()), \
             mock.patch.object(reader.Path, 'glob') as glob, \
             mock.patch.object(reader, 'capture_snapshot_to') as capture, \
             mock.patch.object(reader, 'acquire_passphrase') as acquire:
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'LINE_BUILD_UNVERIFIED')
        glob.assert_not_called()
        capture.assert_not_called()
        acquire.assert_not_called()

    def test_fresh_snapshot_key_mismatch_does_not_commit_or_open_sqlite(self):
        events, commit, connection, patches = self._run_patches(matches=False)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'SESSION_KEY_CHANGED')
        self.assertEqual(events, ['bootstrap', 'acquire', 'capture', 'revalidate'])
        connection.assert_not_called()
        commit.assert_not_called()

    def test_database_read_failure_does_not_commit(self):
        events, commit, _, patches = self._run_patches(read_error=reader.ReaderError('SCOPED_READ_FAILED'))
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'SCOPED_READ_FAILED')
        self.assertEqual(events, ['bootstrap', 'acquire', 'capture', 'revalidate', 'open', 'read'])
        commit.assert_not_called()

    def test_oversized_result_does_not_commit(self):
        events, commit, _, patches = self._run_patches(read_result={
            'messages': [], 'payload': 'x' * (4 * 1024 * 1024),
        })
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'RESULT_TOO_LARGE')
        self.assertEqual(events, ['bootstrap', 'acquire', 'capture', 'revalidate', 'open', 'read'])
        commit.assert_not_called()

    def test_snapshot_cleanup_failure_does_not_commit(self):
        events, commit, _, patches = self._run_patches()
        original_rmdir = Path.rmdir

        def reject_reader_snapshot_directory(path):
            if path.name.startswith('line-reader-'):
                raise OSError('fixture cleanup rejected')
            return original_rmdir(path)

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], \
             mock.patch.object(reader.Path, 'rmdir', autospec=True,
                               side_effect=reject_reader_snapshot_directory):
            with self.assertRaises(reader.ReaderError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'SNAPSHOT_CLEANUP_FAILED')
        self.assertEqual(events, ['bootstrap', 'acquire', 'capture', 'revalidate', 'open', 'read'])
        commit.assert_not_called()

    def test_success_captures_once_after_bootstrap_then_commits_without_private_context(self):
        captured_scope = {}
        events, commit, _, patches = self._run_patches()

        def scoped(db, args, snapshot, resolver):
            events.append('read')
            captured_scope.update(snapshot)
            return {'messages': [], 'count': 0}

        patches = (*patches[:5], mock.patch.object(reader, 'read_scoped', side_effect=scoped), patches[6])
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            result = reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(events, ['bootstrap', 'acquire', 'capture', 'revalidate', 'open', 'read', 'commit'])
        commit.assert_called_once_with(self.cache_commit)
        self.assertEqual(captured_scope['sequence'], 2)
        self.assertEqual(captured_scope['keyAcquisition'], 'locator')
        for private_field in ('cache_commit', 'windowAddressHex', 'processCreatedFiletimeHex', 'dbPathSha256'):
            self.assertNotIn(private_field, captured_scope)
            self.assertNotIn(private_field, result)

    def test_bootstrap_failure_cleans_request_without_key_scan(self):
        with mock.patch.dict(reader.os.environ, {'LOCALAPPDATA': str(self.work)}), \
             mock.patch.object(reader, 'read_database_prefix',
                               side_effect=reader.SnapshotError('SOURCE_BUSY')), \
             mock.patch.object(reader, 'acquire_passphrase') as acquire, \
             mock.patch.object(reader, 'capture_snapshot_to') as capture:
            with self.assertRaises(reader.SnapshotError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'SOURCE_BUSY')
        acquire.assert_not_called()
        capture.assert_not_called()
        self.assertEqual(list(self.work.glob('line-reader-*')), [])

    def test_partial_capture_failure_removes_only_its_scratch_files(self):
        def capture(_, directory, *, limits):
            (directory / 'snapshot.edb').write_bytes(b'partial encrypted fixture')
            raise reader.SnapshotError('SNAPSHOT_DISK_FULL')

        with mock.patch.dict(reader.os.environ, {'LOCALAPPDATA': str(self.work)}), \
             mock.patch.object(reader, 'read_database_prefix', return_value=b'x' * 4096), \
             mock.patch.object(reader, 'acquire_passphrase', return_value=(b'fixture-key', self.metrics)), \
             mock.patch.object(reader, 'capture_snapshot_to', side_effect=capture), \
             mock.patch.object(reader, 'Connection') as connect, \
             mock.patch.object(reader.session_locator, 'commit_after_success') as commit:
            with self.assertRaises(reader.SnapshotError) as error:
                reader.run({'chatName': 'Synthetic', 'dateFrom': '2026-09-11', 'dateTo': '2026-09-11'})
        self.assertEqual(error.exception.code, 'SNAPSHOT_DISK_FULL')
        connect.assert_not_called()
        commit.assert_not_called()
        self.assertEqual(list(self.work.glob('line-reader-*')), [])
        self.assertEqual(self.database.read_bytes(), b'encrypted fixture')


if __name__ == '__main__':
    unittest.main()
