"""Single-request local LINE reader. JSON scope in stdin; scoped JSON out.

Only encrypted DB/WAL snapshot copies touch disk, and are removed after use.
Key extraction remains local and bounded. This command never operates LINE UI.
"""
import ctypes as ct
import datetime as dt
from ctypes import wintypes as wt
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

from line_scoped_core import ReaderError, read_scoped, validate_scope
from line_sqlite_engine import Connection
from line_encrypted_snapshot import (SnapshotError, load_snapshot_limits,
                                     read_database_prefix, capture_snapshot_to,
                                     cleanup_snapshot)
from line_media import inspect_attachment
from line_client_compatibility import ClientBuildError, verify_client_build
import line_session_locator as session_locator
from line_runtime_paths import (RuntimePathError, application_runtime_dir,
                                create_reader_request_directory)


def serialize_result(result):
    data = json.dumps(result,ensure_ascii=False,separators=(',', ':'))
    if len(data.encode()) > 4*1024*1024:
        raise ReaderError('RESULT_TOO_LARGE')
    return data


def find_line_process():
    class ProcessEntry(ct.Structure):
        _fields_ = [('size',wt.DWORD),('usage',wt.DWORD),('pid',wt.DWORD),
                    ('heap',ct.c_size_t),('module',wt.DWORD),('threads',wt.DWORD),
                    ('parent',wt.DWORD),('priority',wt.LONG),('flags',wt.DWORD),
                    ('exe',wt.WCHAR*260)]
    kernel = ct.WinDLL('kernel32',use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wt.DWORD,wt.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wt.HANDLE
    kernel.Process32FirstW.argtypes = [wt.HANDLE,ct.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wt.HANDLE,ct.POINTER(ProcessEntry)]
    kernel.CloseHandle.argtypes = [wt.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2,0)
    if handle == ct.c_void_p(-1).value:
        raise ReaderError('LINE_PROCESS_UNAVAILABLE')
    try:
        entry = ProcessEntry()
        entry.size = ct.sizeof(entry)
        found = []
        ok = kernel.Process32FirstW(handle,ct.byref(entry))
        if not ok and ct.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ReaderError('LINE_PROCESS_UNAVAILABLE')
        while ok:
            if entry.exe.lower() == 'line.exe':
                found.append(entry.pid)
            ok = kernel.Process32NextW(handle,ct.byref(entry))
            if not ok and ct.get_last_error() != 18:
                raise ReaderError('LINE_PROCESS_UNAVAILABLE')
        if not found:
            raise ReaderError('LINE_PROCESS_UNAVAILABLE')
        if len(found) > 1:
            raise ReaderError('LINE_PROCESS_AMBIGUOUS')
        return found[0]
    finally:
        kernel.CloseHandle(handle)


def acquire_passphrase(first_page, base, db_path):
    try:
        return session_locator.acquire_passphrase(
            first_page,
            pid=find_line_process(),
            expected_exe=base/'bin/current/LINE.exe',
            db_path=db_path,
        )
    except session_locator.LocatorError as error:
        raise ReaderError(error.code) from error


def passphrase_matches(first_page, passphrase):
    spec = importlib.util.spec_from_file_location('line_probe', Path(__file__).with_name('line-schema-probe.py'))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe.first_page_valid(first_page, probe.derive_key(passphrase))


def run(args):
    started_clock = time.perf_counter()
    timings = {}
    request_started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    validate_scope(args)  # Required before any process/filesystem reads.
    limits = load_snapshot_limits()
    base = Path(os.environ['LOCALAPPDATA'])/'LINE'
    phase = time.perf_counter()
    try:
        client_build = verify_client_build(base/'bin/current/LINE.exe')
    except ClientBuildError as error:
        raise ReaderError(error.code) from error
    timings['clientBuildVerificationMs'] = round((time.perf_counter() - phase) * 1000, 3)
    paths = list((base/'Data/db').glob('*.edb'))
    main = [p for p in paths if not p.name.startswith(('album','chatStats','keep'))]
    if not 1 <= len(main) <= 4:
        raise ReaderError('MAIN_DATABASE_AMBIGUOUS')
    # LINE can retain another signed-in account's database. Prefer the most
    # recently written candidate, but trust it only after the current process
    # key validates it and fails to validate every other main database.
    main.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    try:
        runtime_dir = application_runtime_dir(create=True)
        directory = create_reader_request_directory(runtime_dir)
    except RuntimePathError:
        raise ReaderError('RUNTIME_DIRECTORY_UNAVAILABLE') from None
    passphrase = None
    try:
        phase = time.perf_counter()
        prefix = read_database_prefix(main[0], limits=limits)
        timings['bootstrapPrefixMs'] = round((time.perf_counter() - phase) * 1000, 3)
        phase = time.perf_counter()
        passphrase, key_metrics = acquire_passphrase(prefix,base,main[0])
        prefix = None
        for other in main[1:]:
            other_prefix = read_database_prefix(other, limits=limits)
            if passphrase_matches(other_prefix, passphrase):
                raise ReaderError('MAIN_DATABASE_AMBIGUOUS')
        timings['keyAcquisitionMs'] = round((time.perf_counter() - phase) * 1000, 3)
        # Initialization can be slow. Only this fresh, verified encrypted pair
        # is queried; the bootstrap prefix never supplies any returned rows.
        phase = time.perf_counter()
        snapshot_and_query_started = phase
        path, snapshot = capture_snapshot_to(main[0], directory, limits=limits)
        if not passphrase_matches(read_database_prefix(path, limits=limits), passphrase):
            raise ReaderError('SESSION_KEY_CHANGED')
        timings['freshSnapshotAndValidationMs'] = round((time.perf_counter() - phase) * 1000, 3)
        phase = time.perf_counter()
        with Connection(path,passphrase) as db:
            passphrase = None
            db.execute('BEGIN')
            db.restrict_reads()
            result = read_scoped(db,args,{**snapshot,'engine':db.version,**key_metrics,
                                        'clientBuild':client_build,
                                        'readOnly':True,'sourceFilesOpenedByEngine':False},
                                  lambda kind,meta,info,ref,chat_id: inspect_attachment(kind,meta,info,ref,base/'Cache',chat_id))
        completed_at = dt.datetime.now(dt.timezone.utc)
        captured_at = dt.datetime.fromisoformat(snapshot['captureCompletedAt'])
        age_ms = (completed_at - captured_at).total_seconds() * 1000
        result['retrievedAt'] = completed_at.isoformat()
        result['freshness'] = {'requestStartedAt': request_started_at,
                               'snapshotCapturedAt': snapshot['captureCompletedAt'],
                               'queryCompletedAt': completed_at.isoformat(),
                               'snapshotAgeMs': round(age_ms, 3) if age_ms >= 0 else None,
                               'clockOrderValid': age_ms >= 0,
                               'capturedAfterInitialization': True,
                               # Legacy alias for the post-key freshness
                               # guarantee, retained for existing clients.
                               'recapturedAfterInitialization': True,
                               'bootstrapKind': 'stable_database_prefix',
                               'sourceCurrentAtCompletionVerified': False}
        timings['queryMs'] = round((time.perf_counter() - phase) * 1000, 3)
        timings['snapshotFileAndQueryMs'] = round((time.perf_counter() - snapshot_and_query_started) * 1000, 3)
    finally:
        cleanup_started = time.perf_counter()
        passphrase = None
        # The parent also cleans these exact files after child exit, including
        # forced termination, which cannot execute this Python finally block.
        try:
            cleanup_snapshot(directory)
            directory.rmdir()
        except (OSError, SnapshotError):
            raise ReaderError('SNAPSHOT_CLEANUP_FAILED') from None
        timings['snapshotCleanupMs'] = round((time.perf_counter() - cleanup_started) * 1000, 3)
    # A locator hint can only be stored after this new snapshot validated, the
    # scope-limited read and snapshot cleanup completed, and the final public
    # result fits the same 4 MiB transport limit used by main().
    phase = time.perf_counter()
    timings['resultValidationAndLocatorUpdateMs'] = 0
    timings['totalMs'] = round((time.perf_counter() - started_clock) * 1000, 3)
    result['readerTiming'] = timings
    serialized = serialize_result(result)
    # Very large valid responses can skip the optional hint update. Reserve a
    # small bound for the two final numeric timing replacements before commit.
    if len(serialized.encode('utf-8')) + 1024 > 4 * 1024 * 1024:
        return result
    session_locator.commit_after_success(getattr(key_metrics, 'cache_commit', None))
    timings['resultValidationAndLocatorUpdateMs'] = round((time.perf_counter() - phase) * 1000, 3)
    timings['totalMs'] = round((time.perf_counter() - started_clock) * 1000, 3)
    return result


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        payload = sys.stdin.buffer.read(16385)
        if len(payload) > 16384:
            raise ReaderError('INVALID_SCOPE')
        result = run(json.loads(payload))
        data = serialize_result(result)
        print(data)
    except Exception as error:
        code = error.code if isinstance(error,(ReaderError,SnapshotError)) else 'LOCAL_READER_FAILED'
        result = {'ok':False,'code':code,'message':'Local LINE read did not complete; no success claimed.'}
        if isinstance(error, SnapshotError) and code == 'SOURCE_TOO_LARGE':
            result['details'] = error.details
        print(json.dumps(result))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
