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
    if isinstance(args, dict) and args.get('mode') == 'keepOpenIdentity':
        if args != {'mode': 'keepOpenIdentity'}:
            raise ReaderError('INVALID_SCOPE')
        return args
    if isinstance(args, dict) and args.get('mode') == 'chatCandidates':
        return validate_candidate_scope(args)
    if isinstance(args, dict) and args.get('mode') == 'recentChats':
        return validate_recent_scope(args)
    if not isinstance(args, dict) or set(args) - {'chatName', 'chatType', 'dateFrom', 'dateTo', 'messageLimit', 'query', 'cursor', 'mediaMode', 'mediaSourceRefs', 'identityOnly', 'guiIdentityOnly', 'guiCandidateOnly', 'groupCandidateOnly', 'expectedChatRef', 'expectedOwnSenderRef', 'requireUniqueName', 'boundDirect'}:
        raise ReaderError('INVALID_SCOPE')
    if 'requireUniqueName' in args and args['requireUniqueName'] is not True:
        raise ReaderError('INVALID_SCOPE')
    if 'expectedChatRef' in args and not re.fullmatch(r'chat:[0-9a-f]{24}', str(args['expectedChatRef'])):
        raise ReaderError('INVALID_SCOPE')
    if 'expectedOwnSenderRef' in args and not re.fullmatch(r'sender:[0-9a-f]{24}', str(args['expectedOwnSenderRef'])):
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
    if 'boundDirect' in args and (args['boundDirect'] is not True or args.get('chatType') != 'direct'
                                 or 'expectedChatRef' not in args or 'expectedOwnSenderRef' not in args
                                 or (dates[1] - dates[0]).days > 2 or limit > 30 or mode != 'metadata'
                                 or any(key in args for key in ('requireUniqueName', 'guiIdentityOnly',
                                       'guiCandidateOnly', 'groupCandidateOnly', 'query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    refs = args.get('mediaSourceRefs')
    if 'identityOnly' in args and (args['identityOnly'] is not True or mode != 'metadata'
                                  or any(key in args for key in ('query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    if 'guiIdentityOnly' in args and (args['guiIdentityOnly'] is not True
                                     or args.get('identityOnly') is not True
                                      or 'guiCandidateOnly' in args or 'groupCandidateOnly' in args
                                     or mode != 'metadata'
                                     or any(key in args for key in ('query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    if 'guiCandidateOnly' in args and (args['guiCandidateOnly'] is not True
                                      or args.get('identityOnly') is not True
                                      or args.get('chatType', 'direct') != 'direct'
                                      or 'groupCandidateOnly' in args
                                      or mode != 'metadata'
                                      or any(key in args for key in ('query', 'cursor', 'mediaSourceRefs'))):
        raise ReaderError('INVALID_SCOPE')
    if 'groupCandidateOnly' in args and (args['groupCandidateOnly'] is not True
                                        or args.get('identityOnly') is not True
                                        or args.get('chatType') != 'group'
                                        or any(key in args for key in ('guiIdentityOnly', 'guiCandidateOnly'))
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


def validate_recent_scope(args):
    """A separate closed mode; named-chat message flags never enter this path."""
    if (not isinstance(args, dict) or set(args) - {'mode', 'days', 'query', 'limit'}
            or args.get('mode') != 'recentChats' or type(args.get('days')) is not int
            or args['days'] not in (14, 30)):
        raise ReaderError('INVALID_SCOPE')
    limit = args.get('limit', 50)
    query = args.get('query')
    if (type(limit) is not int or not 1 <= limit <= 50
            or (query is not None and (not isinstance(query, str)
                or not 1 <= len(query) <= 100 or any(unicodedata.category(c) == 'Cc' for c in query)))):
        raise ReaderError('INVALID_SCOPE')
    return {'mode': 'recentChats', 'days': args['days'], 'limit': limit,
            **({'query': query} if query is not None else {})}


def validate_candidate_scope(args):
    if (not isinstance(args, dict) or set(args) - {'mode', 'chatName', 'limit'}
            or args.get('mode') != 'chatCandidates'):
        raise ReaderError('INVALID_SCOPE')
    name, limit = args.get('chatName'), args.get('limit', 20)
    if (not isinstance(name, str) or not 1 <= len(name) <= 200 or name != name.strip()
            or any(unicodedata.category(c) == 'Cc' for c in name)
            or type(limit) is not int or not 1 <= limit <= 20):
        raise ReaderError('INVALID_SCOPE')
    return {'mode': 'chatCandidates', 'chatName': name, 'limit': limit}


def read_chat_candidates(connection, args):
    scope = validate_candidate_scope(args)
    limit, name = scope['limit'], scope['chatName']
    candidates = {}
    groups = connection.execute(
        'SELECT _chatMid FROM _groupChat WHERE _chatName = ? ORDER BY _chatMid LIMIT ?',
        (name, limit + 1)).fetchall()
    contacts = connection.execute(
        'SELECT c._mid, CASE WHEN h._id IS NULL THEN 0 ELSE 1 END '
        'FROM _contact c LEFT JOIN _chat h ON h._id = c._mid AND h._midType = 0 '
        'WHERE c._displayNameOverridden = ? OR '
        "((c._displayNameOverridden IS NULL OR c._displayNameOverridden = '') AND c._displayName = ?) "
        'ORDER BY c._mid LIMIT ?', (name, name, limit + 1)).fetchall()
    for kind, rows in (('group', groups), ('direct', contacts)):
        for row in rows:
            if (not isinstance(row, (tuple, list)) or len(row) != (1 if kind == 'group' else 2)
                    or not _valid_gui_inventory_id(row[0])
                    or (kind == 'direct' and (type(row[1]) is not int or row[1] not in (0, 1)))):
                raise ReaderError('GUI_IDENTITY_ROW_INVALID')
            ref = reference('chat', row[0])
            candidate = {'chatRef': ref, 'chatName': name, 'chatType': kind,
                         'existingChat': True if kind == 'group' else bool(row[1])}
            if ref in candidates and candidates[ref] != candidate:
                raise ReaderError('GUI_IDENTITY_CONFLICT')
            candidates[ref] = candidate
    ordered = sorted(candidates.values(), key=lambda item: (not item['existingChat'], item['chatType'], item['chatRef']))
    return {'ok': True, 'chatName': name, 'ownSenderRef': own_sender_ref(connection),
            'candidates': ordered[:limit], 'hasMore': len(ordered) > limit or len(groups) > limit or len(contacts) > limit,
            'scope': {'kind': 'local_chat_candidates', 'requested': scope},
            'warnings': ['Identity metadata only; no messages or media read. Candidate selection is not GUI or send proof.']}


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
    if not isinstance(value, str):
        raise ReaderError('GUI_IDENTITY_NAME_TYPE')
    if not value:
        raise ReaderError('GUI_IDENTITY_NAME_EMPTY')
    if len(value) > 200:
        raise ReaderError('GUI_IDENTITY_NAME_TOO_LONG')
    if any(ord(char) < 32 and not char.isspace() for char in value):
        raise ReaderError('GUI_IDENTITY_NAME_CONTROL')
    try:
        compact = ''.join(char for char in unicodedata.normalize('NFC', value)
                          if not char.isspace() and char != '\ufeff')
    except (TypeError, ValueError):
        raise ReaderError('GUI_IDENTITY_NAME_NORMALIZATION') from None
    if not compact:
        raise ReaderError('GUI_IDENTITY_NAME_EMPTY')
    while True:
        suffix = re.search(r'\([0-9]+\)$', compact)
        if suffix is None or suffix.start() == 0:
            return compact
        compact = compact[:suffix.start()]


def _valid_gui_inventory_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= 200
            and not any(char.isspace() or char == '\ufeff' or unicodedata.category(char) == 'Cc'
                        for char in value))


def _gui_inventory(connection, *, allow_unknown_names=False, include_unopened_contacts=False):
    queries = (
        ('group', 'SELECT _chatMid, _chatName FROM _groupChat '
                  'ORDER BY _chatMid, _chatName LIMIT ? OFFSET ?'),
        ('direct', ('SELECT c._mid, CASE '
                    "WHEN c._displayNameOverridden IS NULL OR c._displayNameOverridden = '' "
                    'THEN c._displayName ELSE c._displayNameOverridden END '
                    'FROM _contact c '
                    'ORDER BY c._mid, c._displayNameOverridden, c._displayName LIMIT ? OFFSET ?')
         if include_unopened_contacts else
         ('SELECT h._id, CASE '
          "WHEN c._displayNameOverridden IS NULL OR c._displayNameOverridden = '' "
          'THEN c._displayName ELSE c._displayNameOverridden END '
          'FROM _chat h LEFT JOIN _contact c ON h._id = c._mid '
          'WHERE h._midType = 0 '
          'ORDER BY h._id, c._displayNameOverridden, c._displayName LIMIT ? OFFSET ?')),
    )
    total = 0
    for kind, sql in queries:
        offset = 0
        while True:
            try:
                rows = connection.execute(sql, (GUI_INVENTORY_PAGE, offset)).fetchall()
            except ReaderError as error:
                if error.code == 'RESULT_TOO_LARGE':
                    raise ReaderError('GUI_IDENTITY_QUERY_RESULT_TOO_LARGE') from None
                if error.code == 'DATABASE_READ_FAILED':
                    raise ReaderError('GUI_IDENTITY_QUERY_DATABASE_READ_FAILED') from None
                raise ReaderError('GUI_IDENTITY_QUERY_FAILED') from None
            except Exception:
                raise ReaderError('GUI_IDENTITY_QUERY_FAILED') from None
            if not isinstance(rows, list) or len(rows) > GUI_INVENTORY_PAGE:
                raise ReaderError('GUI_IDENTITY_ROW_INVALID')
            total += len(rows)
            if total > GUI_INVENTORY_MAX_ROWS:
                raise ReaderError('GUI_IDENTITY_INVENTORY_LIMIT')
            for row in rows:
                if not isinstance(row, (tuple, list)) or len(row) != 2:
                    raise ReaderError('GUI_IDENTITY_ROW_INVALID')
                chat_id, name = row
                if not _valid_gui_inventory_id(chat_id):
                    raise ReaderError('GUI_IDENTITY_ID_INVALID')
                if name is None:
                    if allow_unknown_names:
                        yield kind, chat_id, None
                        continue
                    raise ReaderError('GUI_IDENTITY_GROUP_NAME_NULL'
                                      if kind == 'group' else 'GUI_IDENTITY_DIRECT_NAME_NULL')
                if allow_unknown_names and isinstance(name, str) and any(
                        unicodedata.category(char) == 'Cc' for char in name):
                    raise ReaderError('GUI_IDENTITY_NAME_CONTROL')
                try:
                    gui_name_family(name)
                except ReaderError as error:
                    if allow_unknown_names and error.code == 'GUI_IDENTITY_NAME_EMPTY':
                        yield kind, chat_id, None
                        continue
                    raise
                yield kind, chat_id, name
            if len(rows) < GUI_INVENTORY_PAGE:
                break
            offset += len(rows)


def resolve_gui_chat(connection, args):
    """Require one exact target and no visually equivalent known chat name."""
    identities = {}
    families = {}
    exact = set()
    for kind, chat_id, name in _gui_inventory(connection, allow_unknown_names=True):
        # A nameless unrelated entry cannot match the requested nonempty name.
        # Never synthesize a name or use it as a candidate. UI proof is separate.
        if name is None:
            continue
        identity = (kind, chat_id)
        previous = identities.get(identity)
        if previous is not None and previous != name:
            raise ReaderError('GUI_IDENTITY_CONFLICT')
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


def assert_unique_send_name(connection, args, chat_id, kind):
    """A title alone cannot distinguish a chat from a same-name unopened contact."""
    wanted = gui_name_family(args['chatName'])
    target = (kind, chat_id)
    matches = set()
    for entry_kind, entry_id, name in _gui_inventory(
            connection, allow_unknown_names=True, include_unopened_contacts=True):
        if name is not None and gui_name_family(name) == wanted:
            matches.add((entry_kind, entry_id))
            if matches != {target}:
                raise ReaderError('CHAT_AMBIGUOUS')
    if matches != {target}:
        raise ReaderError('CHAT_AMBIGUOUS')


def resolve_gui_candidate_chat(connection, args):
    """Find one direct target among known names; report, never hide, unknown names."""
    if any(unicodedata.category(char) == 'Cc' for char in args['chatName']):
        raise ReaderError('GUI_IDENTITY_NAME_CONTROL')
    identities = {}
    families = {}
    exact = set()
    unresolved = 0
    for kind, chat_id, name in _gui_inventory(connection, allow_unknown_names=True):
        identity = (kind, chat_id)
        if identity in identities:
            raise ReaderError('GUI_IDENTITY_CONFLICT')
        identities[identity] = name
        if name is None:
            unresolved += 1
            continue
        families.setdefault(gui_name_family(name), set()).add(identity)
        if name == args['chatName']:
            exact.add(identity)
    if not exact:
        raise ReaderError('CHAT_NOT_FOUND')
    if len(exact) != 1:
        raise ReaderError('CHAT_AMBIGUOUS')
    identity = next(iter(exact))
    if identity[0] != 'direct' or families.get(gui_name_family(args['chatName'])) != {identity}:
        raise ReaderError('CHAT_AMBIGUOUS')
    return identity[1], {'kind': 'direct', 'displayName': args['chatName'],
                          'uiIdentityVerified': False, 'guiDisplayNameUnique': False,
                          'knownNameUnique': True, 'unresolvedNameCount': unresolved}


def resolve_gui_group_candidate_chat(connection, args):
    """One exact group name family; direct-name gaps cannot veto typed group UI proof."""
    wanted = gui_name_family(args['chatName'])
    exact, family = set(), set()
    seen = {}
    offset = 0
    while True:
        rows = connection.execute(
            'SELECT _chatMid, _chatName FROM _groupChat '
            'ORDER BY _chatMid, _chatName LIMIT ? OFFSET ?',
            (GUI_INVENTORY_PAGE, offset)).fetchall()
        if not isinstance(rows, list) or len(rows) > GUI_INVENTORY_PAGE:
            raise ReaderError('GUI_IDENTITY_ROW_INVALID')
        offset += len(rows)
        if offset > GUI_INVENTORY_MAX_ROWS:
            raise ReaderError('GUI_IDENTITY_INVENTORY_LIMIT')
        for row in rows:
            if not isinstance(row, (tuple, list)) or len(row) != 2:
                raise ReaderError('GUI_IDENTITY_ROW_INVALID')
            group_id, name = row
            if not _valid_gui_inventory_id(group_id):
                raise ReaderError('GUI_IDENTITY_ID_INVALID')
            if name is None:
                raise ReaderError('GUI_IDENTITY_GROUP_NAME_NULL')
            family_name = gui_name_family(name)
            if group_id in seen and seen[group_id] != name:
                raise ReaderError('GUI_IDENTITY_CONFLICT')
            seen[group_id] = name
            if family_name == wanted:
                family.add(group_id)
            if name == args['chatName']:
                exact.add(group_id)
        if len(rows) < GUI_INVENTORY_PAGE:
            break
    if not exact:
        raise ReaderError('CHAT_NOT_FOUND')
    if len(exact) != 1 or family != exact:
        raise ReaderError('CHAT_AMBIGUOUS')
    return next(iter(exact)), {'kind': 'group', 'displayName': args['chatName'],
                              'uiIdentityVerified': False, 'guiDisplayNameUnique': False,
                              'knownNameUnique': True}


def own_sender_ref(connection):
    """Return a self reference only when the local profile has one valid MID."""
    rows = connection.execute('SELECT _mid FROM _profile LIMIT 2').fetchall()
    if len(rows) != 1 or not isinstance(rows[0], (tuple, list)) or len(rows[0]) != 1:
        return None
    mid = rows[0][0]
    return reference('sender', mid) if _valid_gui_inventory_id(mid) else None


def read_keep_open_identity(connection):
    """Private, identity-only proof for opening the built-in self memo."""
    profile = connection.execute('SELECT _mid FROM _profile LIMIT 2').fetchall()
    if (len(profile) != 1 or not isinstance(profile[0], (tuple, list))
            or len(profile[0]) != 1 or not _valid_gui_inventory_id(profile[0][0])):
        raise ReaderError('CHAT_NOT_FOUND')
    own_mid = profile[0][0]
    rows = connection.execute(
        'SELECT _id, _midType FROM _chat WHERE _id = ? LIMIT 2', (own_mid,)).fetchall()
    if (len(rows) != 1 or not isinstance(rows[0], (tuple, list)) or len(rows[0]) != 2
            or rows[0][0] != own_mid or type(rows[0][1]) is not int or rows[0][1] != 0):
        raise ReaderError('CHAT_NOT_FOUND')
    wanted = gui_name_family('Keep筆記')
    for kind, chat_id, name in _gui_inventory(
            connection, allow_unknown_names=True, include_unopened_contacts=True):
        if name is not None and gui_name_family(name) == wanted and (kind, chat_id) != ('direct', own_mid):
            raise ReaderError('CHAT_AMBIGUOUS')
    return {'ok': True, 'mode': 'keepOpenIdentity'}


def read_recent_chats(connection, args, *, now=None):
    """List bounded activity metadata without selecting message content."""
    scope = validate_recent_scope(args)
    checked = now or dt.datetime.now(TZ)
    if checked.tzinfo is None:
        raise ReaderError('INVALID_SCOPE')
    checked = checked.astimezone(TZ)
    today = checked.date()
    first = today - dt.timedelta(days=scope['days'] - 1)
    start = int(dt.datetime.combine(first, dt.time(), TZ).timestamp() * 1000)
    end = min(int(dt.datetime.combine(today + dt.timedelta(days=1), dt.time(), TZ).timestamp() * 1000),
              int(checked.timestamp() * 1000) + 1)
    # The GROUP BY bounds output cardinality; the fixed date predicate bounds
    # source scope. Refuse an unusually large set instead of silently omitting.
    activities = connection.execute(
        'SELECT _chatId, MAX(_createdTime) FROM _message '
        'WHERE _createdTime >= ? AND _createdTime < ? '
        'GROUP BY _chatId ORDER BY MAX(_createdTime) DESC, _chatId LIMIT 1001',
        (start, end)).fetchall()
    if len(activities) > 1000:
        raise ReaderError('RECENT_SCOPE_TOO_LARGE')
    chats = []
    unresolved = 0
    conflicting = 0
    for row in activities:
        if not isinstance(row, (tuple, list)) or len(row) != 2:
            raise ReaderError('RECENT_ROW_INVALID')
        chat_id, timestamp = row
        if not _valid_gui_inventory_id(chat_id) or type(timestamp) is not int or not start <= timestamp < end:
            unresolved += 1
            continue
        group = connection.execute(
            'SELECT _chatName FROM _groupChat WHERE _chatMid = ? LIMIT 3', (chat_id,)).fetchall()
        # _chat also indexes groups (observed _midType=2). Only type 0 is a
        # direct identity, as in the named-chat resolvers above.
        direct = connection.execute(
            'SELECT h._midType, CASE WHEN c._displayNameOverridden IS NULL '
            "OR c._displayNameOverridden = '' THEN c._displayName ELSE c._displayNameOverridden END "
            'FROM _chat h LEFT JOIN _contact c ON h._id = c._mid '
            'WHERE h._id = ? AND h._midType = 0 LIMIT 3', (chat_id,)).fetchall()
        if group and direct:
            conflicting += 1
            continue
        if group:
            kind = 'group'
            names = [item[0] for item in group if isinstance(item, (tuple, list)) and len(item) == 1]
            conflict = len(names) != len(group) or len(set(names)) > 1
        elif direct:
            kind = 'direct'
            names = [item[1] for item in direct if isinstance(item, (tuple, list)) and len(item) == 2 and item[0] == 0]
            conflict = len(names) != len(direct) or len(set(names)) > 1
        else:
            unresolved += 1
            continue
        if conflict or len(group if group else direct) >= 3:
            conflicting += 1
            continue
        name = names[0]
        if (not isinstance(name, str) or not 1 <= len(name) <= 200 or name != name.strip()
                or any(unicodedata.category(c) == 'Cc' for c in name)):
            unresolved += 1
            continue
        if 'query' in scope and scope['query'].casefold() not in name.casefold():
            continue
        chats.append({'chatRef': reference('chat', chat_id), 'chatName': name,
                      'chatType': kind, 'lastMessageAt': dt.datetime.fromtimestamp(timestamp / 1000, TZ).isoformat(),
                      'lastMessageTimestamp': timestamp})
    chats.sort(key=lambda item: (-item['lastMessageTimestamp'], item['chatRef']))
    warnings = []
    if unresolved:
        warnings.append(f'{unresolved} recent chat identities had no valid resolvable name and were excluded.')
    if conflicting:
        warnings.append(f'{conflicting} recent chat identities had conflicting records and were excluded.')
    return {'ok': True, 'days': scope['days'], 'dateFrom': first.isoformat(),
            'dateTo': today.isoformat(), 'checkedAt': checked.isoformat(),
            'ownSenderRef': own_sender_ref(connection), 'chats': chats[:scope['limit']],
            'hasMore': len(chats) > scope['limit'], 'warnings': warnings}


def read_scoped(connection, args, snapshot, media_resolver=None, *,
                message_budget_bytes=3*1024*1024, preview_budget_bytes=1024*1024, media_item_limit=20):
    """connection.execute(sql, parameters).fetchall(); only fixed, scoped SQL."""
    if isinstance(args, dict) and args.get('mode') == 'keepOpenIdentity':
        validate_scope(args)
        return read_keep_open_identity(connection)
    if isinstance(args, dict) and args.get('mode') == 'chatCandidates':
        return read_chat_candidates(connection, args)
    if isinstance(args, dict) and args.get('mode') == 'recentChats':
        return read_recent_chats(connection, args)
    args, start, end = validate_scope(args)
    gui_identity_only = args.get('guiIdentityOnly') is True
    gui_candidate_only = args.get('guiCandidateOnly') is True
    group_candidate_only = args.get('groupCandidateOnly') is True
    bound_direct = args.get('boundDirect') is True
    chat_id, chat_identity = (resolve_gui_group_candidate_chat(connection, args) if group_candidate_only
                              else resolve_gui_candidate_chat(connection, args) if gui_candidate_only or bound_direct
                              else resolve_gui_chat(connection, args) if gui_identity_only
                              else resolve_chat(connection, {**args, 'chatType': 'auto'} if args.get('requireUniqueName') else args))
    if args.get('requireUniqueName') and args.get('chatType', 'auto') not in ('auto', chat_identity['kind']):
        raise ReaderError('CHAT_TYPE_MISMATCH')
    if args.get('requireUniqueName') or gui_identity_only:
        assert_unique_send_name(connection, args, chat_id, chat_identity['kind'])
    chat_ref = reference('chat', chat_id)
    if args.get('expectedChatRef') is not None and args['expectedChatRef'] != chat_ref:
        raise ReaderError('CHAT_IDENTITY_CHANGED')
    if args.get('expectedOwnSenderRef') is not None and own_sender_ref(connection) != args['expectedOwnSenderRef']:
        raise ReaderError('CHAT_ACCOUNT_CHANGED')
    if bound_direct:
        try:
            assert_unique_send_name(connection, args, chat_id, 'direct')
            chat_identity['globalNameUnique'] = True
        except ReaderError as error:
            if error.code != 'CHAT_AMBIGUOUS':
                raise
            chat_identity['globalNameUnique'] = False
    if args.get('identityOnly') is True:
        return {'ok': True, 'chatName': args['chatName'], 'chatRef': chat_ref,
                **({'ownSenderRef': own_sender_ref(connection)} if bound_direct or args.get('expectedOwnSenderRef') is not None else {}),
                'chatIdentity': chat_identity, 'count': 0, 'messages': [],
                'pagination': {'hasMore': False, 'nextCursor': None},
                'retrievedAt': dt.datetime.now(TZ).isoformat(),
                'scope': {'kind': 'local_gui_group_candidate_identity' if group_candidate_only else
                          'local_gui_candidate_identity' if gui_candidate_only else
                          'local_gui_chat_identity' if gui_identity_only else 'local_chat_identity',
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
        'ownSenderRef': own_sender_ref(connection),
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
