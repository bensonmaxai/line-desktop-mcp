"""Bounded LINE business records. No GUI actions, arbitrary SQL, or key output."""
import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import unicodedata

TZ = dt.timezone(dt.timedelta(hours=8))


class ReaderError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def validate_scope(args):
    if not isinstance(args, dict) or set(args) - {'chatName', 'chatType', 'dateFrom', 'dateTo', 'messageLimit', 'query', 'cursor', 'mediaMode', 'mediaSourceRefs', 'identityOnly', 'guiIdentityOnly'}:
        raise ReaderError('INVALID_SCOPE')
    chat = args.get('chatName')
    if not isinstance(chat, str) or not 1 <= len(chat) <= 200 or chat != chat.strip() or any(ord(c) < 32 for c in chat):
        raise ReaderError('INVALID_SCOPE')
    if args.get('chatType', 'auto') not in ('auto', 'group', 'direct'):
        raise ReaderError('INVALID_SCOPE')
    dates = []
    for field in ('dateFrom', 'dateTo'):
        value = args.get(field)
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ReaderError('INVALID_SCOPE')
        try:
            dates.append(dt.date.fromisoformat(value))
        except ValueError:
            raise ReaderError('INVALID_SCOPE') from None
    if not 0 <= (dates[1] - dates[0]).days <= 30:
        raise ReaderError('INVALID_SCOPE')
    limit = args.get('messageLimit', 200)
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ReaderError('INVALID_SCOPE')
    query = args.get('query')
    if query is not None and (not isinstance(query, str) or not 1 <= len(query) <= 1000 or '\0' in query):
        raise ReaderError('INVALID_SCOPE')
    mode = args.get('mediaMode', 'metadata')
    refs = args.get('mediaSourceRefs')
    if 'identityOnly' in args and (args['identityOnly'] is not True or mode != 'metadata'
                                  or any(key in args for key in ('query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    if 'guiIdentityOnly' in args and (args['guiIdentityOnly'] is not True
                                     or args.get('identityOnly') is not True
                                     or mode != 'metadata'
                                     or any(key in args for key in ('query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    if mode not in ('metadata', 'preview') or ('mediaSourceRefs' in args and (
            mode != 'preview' or not isinstance(refs, list) or not 1 <= len(refs) <= 20
            or any(not isinstance(ref, str) or not re.fullmatch(r'message:[0-9a-f]{24}', ref) for ref in refs)
            or len(set(refs)) != len(refs))):
        raise ReaderError('INVALID_SCOPE')
    start = dt.datetime.combine(dates[0], dt.time(), TZ)
    end = dt.datetime.combine(dates[1] + dt.timedelta(days=1), dt.time(), TZ)
    start_ms, end_ms = int(start.timestamp()*1000), int(end.timestamp()*1000)
    if 'cursor' in args:
        decode_cursor(args['cursor'], args, start_ms, end_ms)
    return {**args, 'messageLimit': limit, 'mediaMode': mode}, start_ms, end_ms


def cursor_scope(args):
    # The cursor narrows a caller-authorized scope; it never grants access.
    fields = [args['chatName'], args['dateFrom'], args['dateTo'], args.get('query')]
    if args.get('chatType', 'auto') != 'auto':
        fields.append(args['chatType'])
    return hashlib.sha256(json.dumps(fields,
                                     ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def decode_cursor(value, args, start, end):
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ReaderError('INVALID_CURSOR')
    try:
        token = json.loads(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)))
    except (ValueError, UnicodeError):
        raise ReaderError('INVALID_CURSOR') from None
    if (not isinstance(token, dict) or set(token) != {'v', 'scope', 'chat', 'time', 'id'}
            or type(token['v']) is not int or token['v'] != 1
            or not isinstance(token['scope'], str) or not re.fullmatch(r'[0-9a-f]{64}', token['scope'])
            or not isinstance(token['chat'], str) or not re.fullmatch(r'chat:[0-9a-f]{24}', token['chat'])
            or type(token['time']) is not int or abs(token['time']) > 2**53 - 1
            or not valid_source_id(token['id'])):
        raise ReaderError('INVALID_CURSOR')
    if token['scope'] != cursor_scope(args):
        raise ReaderError('CURSOR_SCOPE_MISMATCH')
    if not start <= token['time'] < end:
        raise ReaderError('INVALID_CURSOR')
    return token


def valid_source_id(value):
    return ((isinstance(value, str) and 1 <= len(value) <= 200 and '\0' not in value)
            or (type(value) is int and abs(value) <= 2**53 - 1))


def encode_cursor(args, chat_ref, message, source_id):
    token = {'v': 1, 'scope': cursor_scope(args), 'chat': chat_ref,
             'time': message['sourceTimestamp'], 'id': source_id}
    return base64.urlsafe_b64encode(json.dumps(token, ensure_ascii=False, separators=(',', ':')).encode()).decode().rstrip('=')


def json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def reference(kind, *parts):
    return kind + ':' + hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


def object_metadata(value):
    if not isinstance(value, (str, bytes)) or len(value) > 256 * 1024:
        return None
    try:
        decoded = json.loads(value)
        return decoded if isinstance(decoded, (dict, list)) else None
    except (ValueError, UnicodeError, RecursionError):
        return None


def metadata_shape(value):
    obj = object_metadata(value)
    if isinstance(obj, dict):
        # Key names are diagnostic schema, values (including media keys) stay local.
        return {'format': 'json-object', 'keys': sorted(k for k in obj if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,80}', k))[:80]}
    if isinstance(obj, list):
        return {'format': 'json-array', 'length': len(obj)}
    return {'format': 'absent' if value is None else type(value).__name__, 'bytes': len(value) if isinstance(value, (str, bytes)) else None}


def stored_mentions(metadata, text, resolve_member=None):
    """Read bounded stored mention tokens with optional current contact names.

    This is evidence in an already stored message, never a UI token selector
    or proof of delivery/notification. Unknown encodings remain explicit.
    No raw member IDs or other metadata values leave this function.
    """
    base = {'evidence': 'stored_message_metadata', 'uiTokenVerified': False,
            'notificationVerified': False, 'tokens': []}
    outer = object_metadata(metadata)
    if metadata is None or metadata == '':
        return {**base, 'state': 'absent'}
    if not isinstance(outer, dict):
        return {**base, 'state': 'unrecognized'}
    if 'MENTION' not in outer:
        return {**base, 'state': 'absent'}
    mention = object_metadata(outer['MENTION'])
    entries = mention.get('MENTIONEES') if isinstance(mention, dict) else None
    if not isinstance(entries, list) or not 1 <= len(entries) <= 100 or not isinstance(text, str):
        return {**base, 'state': 'unrecognized'}
    encoded = text.encode('utf-16-le', errors='surrogatepass')
    tokens = []
    for entry in entries:
        if not isinstance(entry, dict):
            return {**base, 'state': 'unsupported_encoding'}
        is_all = set(entry) == {'A', 'S', 'E'} and entry['A'] == '1'
        is_member = (set(entry) == {'M', 'S', 'E'} and isinstance(entry['M'], str)
                     and re.fullmatch(r'u[0-9a-f]{32}', entry['M']) is not None)
        if not is_all and not is_member:
            return {**base, 'state': 'unsupported_encoding'}
        if any(not isinstance(entry[key], str) or not re.fullmatch(r'\d{1,6}', entry[key]) for key in ('S', 'E')):
            return {**base, 'state': 'invalid_offsets'}
        start, end = int(entry['S']), int(entry['E'])
        if not 0 <= start < end <= len(encoded) // 2:
            return {**base, 'state': 'invalid_offsets'}
        try:
            token_text = encoded[start * 2:end * 2].decode('utf-16-le')
        except UnicodeError:
            return {**base, 'state': 'invalid_offsets'}
        if ((is_all and token_text != '@All')
                or (is_member and (not token_text.startswith('@') or len(token_text) < 2))
                or any(start < old['endUtf16'] and end > old['startUtf16'] for old in tokens)):
            return {**base, 'state': 'text_or_offset_mismatch'}
        token = {'target': 'all' if is_all else 'member', 'startUtf16': start, 'endUtf16': end, 'text': token_text}
        if is_member:
            name = resolve_member(entry['M']) if resolve_member else None
            token.update({'memberRef': reference('sender', entry['M']), 'displayName': name,
                          'identityResolved': name is not None,
                          'nameMatchesCurrentContact': token_text == '@' + name if name else None})
        tokens.append(token)
    kinds = {token['target'] for token in tokens}
    state = 'recognized_all' if kinds == {'all'} else 'recognized_members' if kinds == {'member'} else 'recognized_mixed'
    return {**base, 'state': state, 'tokens': tokens}


def resolve_chat(connection, args):
    """Exact effective names; cross-kind and duplicate identities fail closed."""
    kind = args.get('chatType', 'auto')
    candidates = []
    if kind in ('auto', 'group'):
        groups = connection.execute('SELECT _chatMid FROM _groupChat WHERE _chatName = ? LIMIT 2', (args['chatName'],)).fetchall()
        candidates += [(row[0], 'group') for row in groups]
    if kind in ('auto', 'direct'):
        # _chat midType=0 joined to the contact MID is observed in this client.
        # An overridden old name or an unjoined contact does not identify a chat.
        direct = connection.execute(
            'SELECT c._mid FROM _contact c JOIN _chat h ON h._id = c._mid '
            'WHERE h._midType = 0 AND (c._displayNameOverridden = ? OR '
            "((c._displayNameOverridden IS NULL OR c._displayNameOverridden = '') AND c._displayName = ?)) LIMIT 2",
            (args['chatName'], args['chatName'])).fetchall()
        candidates += [(row[0], 'direct') for row in direct]
    if not candidates:
        raise ReaderError('CHAT_NOT_FOUND')
    if len(candidates) != 1:
        raise ReaderError('CHAT_AMBIGUOUS')
    chat_id, resolved_kind = candidates[0]
    return chat_id, {'kind': resolved_kind, 'displayName': args['chatName'],
                     'basis': 'exact_group_name' if resolved_kind == 'group' else 'exact_effective_contact_name_and_existing_direct_chat',
                     'uiIdentityVerified': False}


GUI_INVENTORY_PAGE = 1000
GUI_INVENTORY_MAX_ROWS = 10000


def gui_name_family(value):
    """Conservative approximation of names the LINE GUI may render alike."""
    if (not isinstance(value, str) or not 1 <= len(value) <= 200
            or any(ord(char) < 32 and not char.isspace() for char in value)):
        raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
    try:
        compact = ''.join(char for char in unicodedata.normalize('NFC', value)
                          if not char.isspace() and char != '\ufeff')
    except (TypeError, ValueError):
        raise ReaderError('GUI_IDENTITY_UNAVAILABLE') from None
    if not compact:
        raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
    while True:
        suffix = re.search(r'\([0-9]+\)$', compact)
        if suffix is None or suffix.start() == 0:
            return compact
        compact = compact[:suffix.start()]


def _valid_gui_inventory_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= 200
            and not any(char.isspace() or char == '\ufeff' or ord(char) < 32 for char in value))


def _gui_inventory(connection):
    queries = (
        ('group', 'SELECT _chatMid, _chatName FROM _groupChat '
                  'ORDER BY _chatMid, _chatName LIMIT ? OFFSET ?'),
        ('direct', 'SELECT c._mid, CASE '
                   "WHEN c._displayNameOverridden IS NULL OR c._displayNameOverridden = '' "
                   'THEN c._displayName ELSE c._displayNameOverridden END '
                   'FROM _contact c JOIN _chat h ON h._id = c._mid '
                   'WHERE h._midType = 0 '
                   'ORDER BY c._mid, c._displayNameOverridden, c._displayName LIMIT ? OFFSET ?'),
    )
    total = 0
    for kind, sql in queries:
        offset = 0
        while True:
            try:
                rows = connection.execute(sql, (GUI_INVENTORY_PAGE, offset)).fetchall()
            except Exception:
                raise ReaderError('GUI_IDENTITY_UNAVAILABLE') from None
            if not isinstance(rows, list) or len(rows) > GUI_INVENTORY_PAGE:
                raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
            total += len(rows)
            if total > GUI_INVENTORY_MAX_ROWS:
                raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
            for row in rows:
                if not isinstance(row, (tuple, list)) or len(row) != 2:
                    raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
                chat_id, name = row
                if not _valid_gui_inventory_id(chat_id):
                    raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
                # A nameless direct-chat row has no literal label that could
                # collide with the requested visible chat name. Keep scanning
                # every named row; the target header is verified separately.
                if kind == 'direct' and name is None:
                    continue
                gui_name_family(name)
                yield kind, chat_id, name
            if len(rows) < GUI_INVENTORY_PAGE:
                break
            offset += len(rows)


def resolve_gui_chat(connection, args):
    """Require one exact raw target and one identity in its whole GUI name family."""
    identities = {}
    families = {}
    exact = set()
    for kind, chat_id, name in _gui_inventory(connection):
        identity = (kind, chat_id)
        previous = identities.get(identity)
        if previous is not None and previous != name:
            raise ReaderError('GUI_IDENTITY_UNAVAILABLE')
        identities[identity] = name
        families.setdefault(gui_name_family(name), set()).add(identity)
        if name == args['chatName']:
            exact.add(identity)
    if not exact:
        raise ReaderError('CHAT_NOT_FOUND')
    if len(exact) != 1:
        raise ReaderError('CHAT_AMBIGUOUS')
    identity = next(iter(exact))
    if families.get(gui_name_family(args['chatName'])) != {identity}:
        raise ReaderError('CHAT_AMBIGUOUS')
    kind, chat_id = identity
    return chat_id, {'kind': kind, 'displayName': args['chatName'],
                     'uiIdentityVerified': False, 'guiDisplayNameUnique': True}


def read_scoped(connection, args, snapshot, media_resolver=None, *,
                message_budget_bytes=3*1024*1024, preview_budget_bytes=1024*1024, media_item_limit=20):
    """connection.execute(sql, parameters).fetchall(); only fixed, scoped SQL."""
    args, start, end = validate_scope(args)
    gui_identity_only = args.get('guiIdentityOnly') is True
    chat_id, chat_identity = (resolve_gui_chat(connection, args) if gui_identity_only
                              else resolve_chat(connection, args))
    chat_ref = reference('chat', chat_id)
    if args.get('identityOnly') is True:
        return {'ok': True, 'chatName': args['chatName'], 'chatRef': chat_ref,
                'chatIdentity': chat_identity, 'count': 0, 'messages': [],
                'pagination': {'hasMore': False, 'nextCursor': None},
                'retrievedAt': dt.datetime.now(TZ).isoformat(),
                'scope': {'kind': 'local_gui_chat_identity' if gui_identity_only else 'local_chat_identity',
                          'requested': args, 'timezone': 'Asia/Taipei',
                          'totalHistoryKnown': False, 'truncated': False, 'snapshot': snapshot},
                'warnings': ['Identity lookup only; no message records or media were read.']}
    where = '_chatId = ? AND _createdTime >= ? AND _createdTime < ?'
    params = [chat_id, start, end]
    if args.get('cursor'):
        cursor = decode_cursor(args['cursor'], args, start, end)
        if cursor['chat'] != chat_ref:
            raise ReaderError('CURSOR_SCOPE_MISMATCH')
        where += ' AND (_createdTime < ? OR (_createdTime = ? AND _id < ?))'
        params += [cursor['time'], cursor['time'], cursor['id']]
    if args.get('query') is not None:
        where += ' AND instr(_text, ?) > 0'
        params.append(args['query'])
    sql = ('SELECT _id, _from, _createdTime, _text, _contentType, _contentMetadata, '
           '_contentInfo, _relatedMessageId, _type, _status, _rev FROM _message WHERE ' + where +
           ' ORDER BY _createdTime DESC, _id DESC LIMIT ?')
    fetch_limit = args['messageLimit'] + 1
    source_budget_limited = False
    while True:
        try:
            rows = connection.execute(sql, (*params, fetch_limit)).fetchall()
            break
        except ReaderError as error:
            if error.code != 'RESULT_TOO_LARGE' or fetch_limit == 1:
                raise
            # The cipher adapter also bounds decoded row bytes. Retry only this
            # read-only query with a smaller page in the same SQLite transaction.
            fetch_limit = max(1, fetch_limit // 2)
            source_budget_limited = True
    if fetch_limit == 1:
        lookahead = connection.execute('SELECT _id FROM _message WHERE ' + where +
            ' ORDER BY _createdTime DESC, _id DESC LIMIT 2', tuple(params)).fetchall()
        truncated = len(lookahead) > 1
    else:
        truncated = len(rows) >= fetch_limit
        rows = rows[:fetch_limit - 1]
    senders = {}
    def resolve_sender(sender):
        if sender in senders:
            return senders[sender]
        # Bounded extra member lookups share the sender cache for this page.
        if len(senders) >= 1100:
            return None
        found = connection.execute('SELECT _displayNameOverridden, _displayName FROM _contact WHERE _mid = ? LIMIT 2', (sender,)).fetchall()
        names = {(r[0] or r[1]) for r in found if isinstance(r[0] or r[1], str)}
        if not names:
            own = connection.execute('SELECT _displayName FROM _profile WHERE _mid = ? LIMIT 2', (sender,)).fetchall()
            names = {r[0] for r in own if isinstance(r[0], str)}
        senders[sender] = next(iter(names)) if len(names) == 1 else None
        return senders[sender]
    for sender in dict.fromkeys(row[1] for row in rows if row[1]):
        resolve_sender(sender)
    messages = []
    used_bytes, preview_bytes = 0, 0
    media_attempts = 0
    previews_exhausted = False
    limited_by = ('response_bytes' if source_budget_limited else 'message_limit') if truncated else None
    requested_refs = args.get('mediaSourceRefs')
    matched_refs = []
    cursor_ids = {}
    for row in rows:
        mid, sender, timestamp, text, kind, metadata, info, related, raw_type, status, rev = row
        if type(timestamp) is not int or not start <= timestamp < end:
            raise ReaderError('INVALID_SOURCE_TIME')
        moment = dt.datetime.fromtimestamp(timestamp/1000, TZ)
        source_ref = reference('message', chat_id, str(mid))
        if not valid_source_id(mid):
            raise ReaderError('INVALID_SOURCE_ID')
        media = {'state': 'not_resolved' if kind else 'not_applicable',
                 'retrieval': 'metadata_only', 'metadata': metadata_shape(metadata), 'info': metadata_shape(info)}
        message = {
            'sourceRef': source_ref, 'sourceMessageId': str(mid),
            'sender': senders.get(sender), 'senderRef': reference('sender', sender) if sender else None,
            'date': moment.date().isoformat(), 'time': moment.strftime('%H:%M:%S'),
            'sourceTimestamp': timestamp, 'text': text if isinstance(text, str) else None,
            'contentType': kind, 'sourceType': raw_type, 'sourceStatus': status, 'sourceRevision': rev,
            'relatedSourceRef': reference('message', chat_id, str(related)) if related else None,
            'mentions': stored_mentions(metadata, text, resolve_sender),
            'media': media,
        }
        base_bytes = json_bytes(message) + 1
        if used_bytes + base_bytes > message_budget_bytes:
            if not messages:
                raise ReaderError('RESULT_TOO_LARGE')
            truncated, limited_by = True, 'response_bytes'
            break
        selected = args['mediaMode'] == 'preview' and (requested_refs is None or source_ref in requested_refs)
        if selected and kind and media_resolver:
            if media_attempts >= media_item_limit:
                media['previewOmittedReason'] = 'media_item_limit'
            elif previews_exhausted or preview_bytes >= preview_budget_bytes:
                media['previewOmittedReason'] = 'preview_budget'
            else:
                media_attempts += 1
                media = media_resolver(kind, metadata, info, source_ref, chat_id)
                message['media'] = media
                preview = media.get('preview')
                cost = len(preview.get('data', '').encode('utf-8')) if isinstance(preview, dict) else 0
                if cost > preview_budget_bytes - preview_bytes:
                    media.pop('preview', None)
                    media.pop('previewInfo', None)
                    media['previewOmittedReason'] = 'preview_budget'
                    previews_exhausted = True
                elif preview is not None:
                    preview_bytes += cost
        size = json_bytes(message) + 1
        if used_bytes + size > message_budget_bytes:
            # Optional decoded media must never displace otherwise fitting text.
            message['media'] = {'state': 'not_resolved' if kind else 'not_applicable',
                                'retrieval': 'metadata_only', 'metadata': metadata_shape(metadata),
                                'info': metadata_shape(info), 'previewOmittedReason': 'response_budget'}
            size = json_bytes(message) + 1
            if used_bytes + size > message_budget_bytes:
                if not messages:
                    raise ReaderError('RESULT_TOO_LARGE')
                truncated, limited_by = True, 'response_bytes'
                break
        if requested_refs is not None and source_ref in requested_refs:
            matched_refs.append(source_ref)
        messages.append(message)
        cursor_ids[source_ref] = mid
        used_bytes += size
    messages.reverse()
    next_cursor = encode_cursor(args, chat_ref, messages[0], cursor_ids[messages[0]['sourceRef']]) if truncated and messages else None
    return {
        'ok': True, 'chatName': args['chatName'], 'chatRef': chat_ref, 'chatIdentity': chat_identity,
        'count': len(messages), 'messages': messages,
        'pagination': {'hasMore': truncated, 'nextCursor': next_cursor,
                       'limitedBy': limited_by, 'order': 'newest_pages_with_chronological_messages',
                       'consistency': 'keyset_over_independent_local_snapshots'},
        'mediaSelection': {'mode': args['mediaMode'], 'requestedSourceRefs': requested_refs,
                           'matchedSourceRefs': matched_refs,
                           'notReturnedSourceRefs': [ref for ref in (requested_refs or []) if ref not in matched_refs],
                           'resolutionAttempts': media_attempts, 'resolutionLimit': media_item_limit,
                           'previewBytes': sum(len(m['media'].get('preview', {}).get('data', '').encode('utf-8')) for m in messages)},
        'retrievedAt': dt.datetime.now(TZ).isoformat(),
        'scope': {'kind': 'local_database', 'requested': args, 'timezone': 'Asia/Taipei',
                  'totalHistoryKnown': False, 'truncated': truncated,
                  'firstReturned': messages[0]['date'] if messages else None,
                  'lastReturned': messages[-1]['date'] if messages else None,
                  'snapshot': snapshot},
        'warnings': ['Local cached records do not prove complete server history.',
                     'Source status codes are uninterpreted; no delivered/read claim.'],
    }
