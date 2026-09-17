import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import unittest

PYTHON = Path(__file__).parents[2] / 'src' / 'extensions' / 'python'
sys.path.insert(0, str(PYTHON))
spec = importlib.util.spec_from_file_location('core', PYTHON / 'line_scoped_core.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''
          CREATE TABLE _groupChat(_chatMid TEXT, _chatName TEXT);
          CREATE TABLE _chat(_id TEXT, _midType INTEGER);
          CREATE TABLE _contact(_mid TEXT, _displayNameOverridden TEXT, _displayName TEXT);
          CREATE TABLE _profile(_mid TEXT, _displayName TEXT);
          CREATE TABLE _message(_id TEXT, _from TEXT, _createdTime INTEGER, _text TEXT,
            _contentType INTEGER, _contentMetadata BLOB, _contentInfo BLOB,
            _relatedMessageId TEXT, _type INTEGER, _status INTEGER, _rev INTEGER, _chatId TEXT);
        ''')
        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', ('c1','Synthetic Group'))
        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', ('c2','Other Synthetic Group'))
        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u1','Synthetic Direct 😀','Fallback Contact'))
        self.args = {'chatName':'Synthetic Group','dateFrom':'2026-09-05','dateTo':'2026-09-11'}
        _, self.start, self.end = core.validate_scope(self.args)

    def tearDown(self):
        self.db.close()

    def add(self, mid, timestamp, text='same\nsecond line 😀', chat='c1', kind=0):
        self.db.execute('INSERT INTO _message VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                        (mid,'u1',timestamp,text,kind,None,None,None,0,0,1,chat))

    def test_scope_dates_unicode_duplicate_text_and_stable_sources(self):
        for mid, stamp, chat in [('before',self.start-1,'c1'),('a',self.start,'c1'),
                                  ('b',self.end-1,'c1'),('after',self.end,'c1'),('foreign',self.start,'c2')]:
            self.add(mid,stamp,chat=chat)
        one = core.read_scoped(self.db,self.args,{})
        two = core.read_scoped(self.db,self.args,{})
        self.assertEqual([m['sourceMessageId'] for m in one['messages']], ['a','b'])
        self.assertEqual(one['messages'],two['messages'])
        self.assertEqual(one['messages'][0]['sender'],'Synthetic Direct 😀')
        self.assertEqual(one['messages'][0]['time'],'00:00:00')
        self.assertNotEqual(one['messages'][0]['sourceRef'],one['messages'][1]['sourceRef'])

    def test_exact_identity_and_no_sql_injection(self):
        for name, code in [("' OR 1=1--",'CHAT_NOT_FOUND'),('Synthetic','CHAT_NOT_FOUND')]:
            with self.assertRaises(core.ReaderError) as error:
                core.read_scoped(self.db,{**self.args,'chatName':name},{})
            self.assertEqual(error.exception.code,code)
        self.db.execute('INSERT INTO _groupChat VALUES (?,?)',('duplicate','Synthetic Group'))
        with self.assertRaises(core.ReaderError) as error:
            core.read_scoped(self.db,self.args,{})
        self.assertEqual(error.exception.code,'CHAT_AMBIGUOUS')

    def test_identity_only_does_not_read_messages_or_media(self):
        self.add('private-message', self.start)
        self.db.set_authorizer(lambda action, table, column, database, trigger:
                               sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == '_message'
                               else sqlite3.SQLITE_OK)
        result = core.read_scoped(self.db, {**self.args, 'chatType': 'group', 'identityOnly': True}, {},
                                  lambda *args: self.fail('No media reads allowed'))
        self.assertEqual(result['chatRef'], core.reference('chat', 'c1'))
        self.assertEqual(result['scope']['kind'], 'local_chat_identity')
        self.assertEqual(result['messages'], [])
        self.assertFalse(result['pagination']['hasMore'])
        for changed in [{'identityOnly': False}, {'identityOnly': True, 'query': 'x'},
                        {'identityOnly': True, 'mediaMode': 'preview'}]:
            with self.assertRaises(core.ReaderError):
                core.validate_scope({**self.args, **changed})

    def test_gui_identity_only_requires_the_private_identity_shape(self):
        for changed in [
            {'guiIdentityOnly': True},
            {'identityOnly': True, 'guiIdentityOnly': False},
            {'identityOnly': True, 'guiIdentityOnly': True, 'query': 'x'},
            {'identityOnly': True, 'guiIdentityOnly': True, 'cursor': 'bad'},
            {'identityOnly': True, 'guiIdentityOnly': True, 'mediaMode': 'preview'},
            {'identityOnly': True, 'guiIdentityOnly': True,
             'mediaMode': 'preview', 'mediaSourceRefs': ['message:' + 'a' * 24]},
        ]:
            with self.subTest(changed=changed), self.assertRaises(core.ReaderError) as caught:
                core.validate_scope({**self.args, **changed})
            self.assertEqual(caught.exception.code, 'INVALID_SCOPE')

    def test_gui_identity_refuses_duplicate_groups_directs_and_cross_kind_even_with_kind_hint(self):
        gui = {**self.args, 'identityOnly': True, 'guiIdentityOnly': True}

        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', ('duplicate', 'Synthetic Group'))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, gui, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')
        self.db.execute('DELETE FROM _groupChat WHERE _chatMid=?', ('duplicate',))

        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u1', 0))
        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u2', None, 'Synthetic Direct 😀'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u2', 0))
        direct_gui = {**gui, 'chatName': 'Synthetic Direct 😀', 'chatType': 'direct'}
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, direct_gui, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')
        self.db.execute('DELETE FROM _contact WHERE _mid=?', ('u2',))
        self.db.execute('DELETE FROM _chat WHERE _id=?', ('u2',))

        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u3', None, 'Synthetic Group'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u3', 0))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, {**gui, 'chatType': 'group'}, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')

    def test_gui_identity_refuses_nfc_whitespace_and_repeated_numeric_suffix_aliases(self):
        gui = {**self.args, 'identityOnly': True, 'guiIdentityOnly': True}
        aliases = [
            ('Café', 'Cafe\u0301'),
            ('SpaceName', 'Space\u00a0\ufeffName'),
            ('SuffixName', 'SuffixName(2)(3)'),
        ]
        for index, (group_name, direct_name) in enumerate(aliases):
            with self.subTest(group_name=group_name, direct_name=direct_name):
                group_id, direct_id = f'g-alias-{index}', f'u-alias-{index}'
                self.db.execute('INSERT INTO _groupChat VALUES (?,?)', (group_id, group_name))
                self.db.execute('INSERT INTO _contact VALUES (?,?,?)', (direct_id, None, direct_name))
                self.db.execute('INSERT INTO _chat VALUES (?,?)', (direct_id, 0))
                with self.assertRaises(core.ReaderError) as caught:
                    core.read_scoped(self.db, {**gui, 'chatName': group_name}, {})
                self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')
                self.db.execute('DELETE FROM _groupChat WHERE _chatMid=?', (group_id,))
                self.db.execute('DELETE FROM _contact WHERE _mid=?', (direct_id,))
                self.db.execute('DELETE FROM _chat WHERE _id=?', (direct_id,))

        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', ('g-literal', 'LiteralName'))
        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u-literal', None, 'LiteralName(2)'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u-literal', 0))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, {**gui, 'chatName': 'LiteralName(2)'}, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')

    def test_gui_identity_fails_closed_for_malformed_inventory_rows_and_schema(self):
        gui = {**self.args, 'identityOnly': True, 'guiIdentityOnly': True}

        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u-nameless', None, None))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u-nameless', 0))
        self.assertTrue(core.read_scoped(self.db, gui, {})['ok'])
        self.db.execute('DELETE FROM _contact WHERE _mid=?', ('u-nameless',))
        self.db.execute('DELETE FROM _chat WHERE _id=?', ('u-nameless',))

        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', (None, 'Malformed ID'))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')
        self.db.execute('DELETE FROM _groupChat WHERE _chatMid IS NULL')

        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u-empty', None, '\u00a0\ufeff'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u-empty', 0))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')
        self.db.execute('DELETE FROM _contact WHERE _mid=?', ('u-empty',))
        self.db.execute('DELETE FROM _chat WHERE _id=?', ('u-empty',))

        class Rows:
            def fetchall(self):
                return [('c1', 'Synthetic Group', 'unexpected')]
        class MalformedConnection:
            def execute(self, sql, params=()):
                return Rows()
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(MalformedConnection(), gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')

        self.db.execute('DROP TABLE _contact')
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')

    def test_gui_identity_requires_complete_inventory_and_enforces_total_cap(self):
        gui = {**self.args, 'identityOnly': True, 'guiIdentityOnly': True}

        class Rows:
            def __init__(self, rows):
                self.rows = rows
            def fetchall(self):
                return self.rows
        class IncompleteConnection:
            def execute(self, sql, params=()):
                if 'FROM _groupChat' in sql and params[-1] == 0:
                    return Rows([(f'g{n:04}', f'Group {n}') for n in range(1000)])
                raise core.ReaderError('RESULT_TOO_LARGE')
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(IncompleteConnection(), gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')

        self.db.executemany('INSERT INTO _groupChat VALUES (?,?)',
                            ((f'over-{n:05}', f'Over cap {n}') for n in range(10001)))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, gui, {})
        self.assertEqual(caught.exception.code, 'GUI_IDENTITY_UNAVAILABLE')

    def test_gui_identity_pages_complete_inventory_and_reads_no_messages(self):
        self.db.execute('DELETE FROM _groupChat WHERE _chatMid=?', ('c1',))
        self.db.executemany('INSERT INTO _groupChat VALUES (?,?)',
                            ((f'g-page-{n:04}', f'Unrelated {n}') for n in range(1005)))
        self.db.execute('INSERT INTO _groupChat VALUES (?,?)', ('z-target', 'Synthetic Group'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u1', 0))
        self.add('private-message', self.start)
        self.db.set_authorizer(lambda action, table, column, database, trigger:
                               sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == '_message'
                               else sqlite3.SQLITE_OK)

        result = core.read_scoped(self.db, {**self.args, 'identityOnly': True,
                                            'guiIdentityOnly': True}, {})
        self.assertEqual(result['chatRef'], core.reference('chat', 'z-target'))
        self.assertEqual(result['chatIdentity'], {
            'kind': 'group', 'displayName': 'Synthetic Group',
            'uiIdentityVerified': False, 'guiDisplayNameUnique': True,
        })
        self.assertEqual(result['scope']['kind'], 'local_gui_chat_identity')
        self.assertTrue(result['scope']['requested']['guiIdentityOnly'])
        self.assertEqual(result['count'], 0)
        self.assertEqual(result['messages'], [])
        self.assertEqual(result['pagination'], {'hasMore': False, 'nextCursor': None})
        self.assertNotIn('g-page-0000', str(result))
        self.assertNotIn('Unrelated 0', str(result))

        direct = core.read_scoped(self.db, {**self.args, 'chatName': 'Synthetic Direct 😀',
                                            'identityOnly': True, 'guiIdentityOnly': True}, {})
        self.assertEqual(direct['chatRef'], core.reference('chat', 'u1'))
        self.assertEqual(direct['chatIdentity']['kind'], 'direct')
        self.assertTrue(direct['chatIdentity']['guiDisplayNameUnique'])

    def test_direct_chat_requires_exact_effective_contact_name_and_chat_row(self):
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u1', 0))
        self.add('direct', self.start, chat='u1')
        result = core.read_scoped(self.db, {**self.args, 'chatName': 'Synthetic Direct 😀', 'chatType': 'direct'}, {})
        self.assertEqual(result['chatIdentity']['kind'], 'direct')
        self.assertEqual(result['chatIdentity']['displayName'], 'Synthetic Direct 😀')
        self.assertEqual([m['sourceMessageId'] for m in result['messages']], ['direct'])
        for name in ('Fallback Contact', 'Synthetic Direct'):
            with self.assertRaises(core.ReaderError) as caught:
                core.read_scoped(self.db, {**self.args, 'chatName': name}, {})
            self.assertEqual(caught.exception.code, 'CHAT_NOT_FOUND')

    def test_name_collision_requires_kind_but_duplicate_contacts_still_refuse(self):
        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u2', None, 'Synthetic Group'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u2', 0))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, self.args, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')
        group = core.read_scoped(self.db, {**self.args, 'chatType': 'group'}, {})
        self.assertEqual(group['chatIdentity']['kind'], 'group')
        direct = core.read_scoped(self.db, {**self.args, 'chatType': 'direct'}, {})
        self.assertEqual(direct['chatIdentity']['kind'], 'direct')
        self.db.execute('INSERT INTO _contact VALUES (?,?,?)', ('u3', None, 'Synthetic Group'))
        self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u3', 0))
        with self.assertRaises(core.ReaderError) as caught:
            core.read_scoped(self.db, {**self.args, 'chatType': 'direct'}, {})
        self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')

    def test_non_direct_mid_type_and_missing_chat_do_not_grant_contact_access(self):
        self.add('direct', self.start, chat='u1')
        for mid_type in (None, 1, 2, '0'):
            self.db.execute('DELETE FROM _chat')
            if mid_type is not None:
                self.db.execute('INSERT INTO _chat VALUES (?,?)', ('u1', mid_type))
            if mid_type == '0':  # SQLite INTEGER affinity canonicalizes this value.
                continue
            with self.assertRaises(core.ReaderError) as caught:
                core.read_scoped(self.db, {**self.args, 'chatName': 'Synthetic Direct 😀'}, {})
            self.assertEqual(caught.exception.code, 'CHAT_NOT_FOUND')

    def test_invalid_scope_rejected_before_database_access(self):
        for change in [{'dateFrom':'2026-02-30'},{'dateTo':'2026-10-06'}, {'dateTo':'2026-09-04'},
                       {'messageLimit':True},{'messageLimit':0},{'chatName':' Synthetic Group'},
                       {'chatName':'Synthetic\nGroup'},{'dateFrom':None},{'allChats':True}]:
            with self.assertRaises(core.ReaderError):
                core.read_scoped(None,{**self.args,**change},{})

    def test_literal_search_limit_and_unknown_media(self):
        self.add('a',self.start,text='.* 100%')
        self.add('b',self.start+1,text='normal')
        self.add('c',self.start+2,text='.* picture',kind=1)
        result = core.read_scoped(self.db,{**self.args,'query':'.*','messageLimit':1},{})
        self.assertEqual(result['count'],1)
        self.assertEqual(result['messages'][0]['sourceMessageId'],'c')
        self.assertTrue(result['scope']['truncated'])
        self.assertEqual(result['messages'][0]['media']['state'],'not_resolved')

    def test_metadata_values_never_leak(self):
        result = core.metadata_shape(b'{"mediaKey":"never-print-this","path":"private"}')
        self.assertEqual(result['keys'],['mediaKey','path'])
        self.assertNotIn('never-print-this',str(result))

    def test_deep_json_metadata_fails_closed_for_text_and_utf8_bytes(self):
        nested_array = '[' * 4000 + '0' + ']' * 4000
        nested_object = '{"k":' * 4000 + '0' + '}' * 4000
        for value in (nested_array,nested_array.encode(),nested_object,nested_object.encode()):
            with self.subTest(value_type=type(value).__name__,opening=value[:1]):
                self.assertLessEqual(len(value),256*1024)
                self.assertIsNone(core.object_metadata(value))

    def test_scoped_read_keeps_valid_row_beside_deep_malformed_metadata(self):
        self.add('valid',self.start,text='@All notice')
        valid_metadata = json.dumps({'MENTION': json.dumps({'MENTIONEES': [
            {'A':'1','S':'0','E':'4'}]})})
        self.db.execute('UPDATE _message SET _contentMetadata=?, _contentInfo=? WHERE _id=?',
                        (valid_metadata,b'[1,{"ok":true}]','valid'))
        self.add('deep',self.start+1,text='ordinary text')
        deep_metadata = '{"k":' * 4000 + '0' + '}' * 4000
        deep_info = ('[' * 4000 + '0' + ']' * 4000).encode()
        self.db.execute('UPDATE _message SET _contentMetadata=?, _contentInfo=? WHERE _id=?',
                        (deep_metadata,deep_info,'deep'))

        result = core.read_scoped(self.db,self.args,{})
        messages = {message['sourceMessageId']:message for message in result['messages']}
        self.assertEqual(set(messages),{'valid','deep'})
        self.assertEqual(messages['valid']['mentions']['state'],'recognized_all')
        self.assertEqual(messages['valid']['media']['metadata']['format'],'json-object')
        self.assertEqual(messages['valid']['media']['info'],{'format':'json-array','length':2})
        self.assertEqual(messages['deep']['mentions']['state'],'unrecognized')
        self.assertEqual(messages['deep']['media']['metadata'],
                         {'format':'str','bytes':len(deep_metadata)})
        self.assertEqual(messages['deep']['media']['info'],
                         {'format':'bytes','bytes':len(deep_info)})

    def test_stored_all_mentions_require_metadata_not_plain_text(self):
        def meta(entries):
            return json.dumps({'MENTION': json.dumps({'MENTIONEES': entries}), 'otherSecret': 'never-print-this'})
        observed = [{'A': '1', 'S': '0', 'E': '4'}]
        result = core.stored_mentions(meta(observed), '@All notice')
        self.assertEqual(result['state'], 'recognized_all')
        self.assertEqual(result['tokens'][0]['target'], 'all')
        self.assertFalse(result['notificationVerified'])
        self.assertFalse(result['uiTokenVerified'])
        self.assertNotIn('never-print-this', str(result))
        self.assertEqual(core.stored_mentions(None, '@All notice')['state'], 'absent')
        self.assertEqual(core.stored_mentions('{', '@All notice')['state'], 'unrecognized')
        self.assertEqual(core.stored_mentions(meta(observed), '@Bob notice')['state'], 'text_or_offset_mismatch')
        unknown = core.stored_mentions(meta([{'S': '0', 'E': '4', 'M': 'private-member-id'}]), '@Bob')
        self.assertEqual(unknown['state'], 'unsupported_encoding')
        self.assertNotIn('private-member-id', str(unknown))

    def test_member_mentions_bind_utf16_offsets_and_opaque_contact_identity(self):
        member = 'u' + '1' * 32
        metadata = json.dumps({'MENTION': json.dumps({'MENTIONEES': [
            {'M': member, 'S': '3', 'E': '7'}, {'A': '1', 'S': '8', 'E': '12'}]})})
        result = core.stored_mentions(metadata, '😀 @Zed @All', lambda mid: 'Zed' if mid == member else None)
        self.assertEqual(result['state'], 'recognized_mixed')
        self.assertEqual(result['tokens'][0]['memberRef'], core.reference('sender', member))
        self.assertEqual(result['tokens'][0]['displayName'], 'Zed')
        self.assertTrue(result['tokens'][0]['nameMatchesCurrentContact'])
        self.assertFalse(result['uiTokenVerified'])
        self.assertFalse(result['notificationVerified'])
        self.assertNotIn(member, str(result))
        unresolved = core.stored_mentions(metadata, '😀 @Zed @All')
        self.assertIsNone(unresolved['tokens'][0]['displayName'])
        self.assertFalse(unresolved['tokens'][0]['identityResolved'])
        drifted = core.stored_mentions(metadata, '😀 @Zed @All', lambda _: 'Changed')
        self.assertFalse(drifted['tokens'][0]['nameMatchesCurrentContact'])

    def test_member_metadata_invalid_token_text_never_resolves_contact(self):
        def refuse(_):
            self.fail('Invalid token must not trigger contact lookup')
        member = 'u' + '2' * 32
        def meta(entry):
            return json.dumps({'MENTION': json.dumps({'MENTIONEES': [entry]})})
        for text, entry in [('ZedQ', {'M':member,'S':'0','E':'4'}),
                            ('@Zed', {'M':member,'S':'1','E':'4'}),
                            ('@Zed', {'M':member,'S':'0','E':'5'})]:
            self.assertIn(core.stored_mentions(meta(entry), text, refuse)['state'],
                          ('text_or_offset_mismatch', 'invalid_offsets'))

    def test_stored_mentions_check_utf16_bounds_duplicates_and_malformed_json(self):
        def meta(entries):
            return json.dumps({'MENTION': json.dumps({'MENTIONEES': entries})})
        result = core.stored_mentions(meta([{'A': '1', 'S': '3', 'E': '7'}]), '😀 @All')
        self.assertEqual(result['state'], 'recognized_all')
        for entries in [
            [{'A': '1', 'S': '-1', 'E': '4'}],
            [{'A': '1', 'S': '0', 'E': '999999'}],
            [{'A': '1', 'S': '0', 'E': '1'}],
            [{'A': '1', 'S': True, 'E': '4'}],
        ]:
            self.assertNotEqual(core.stored_mentions(meta(entries), '😀 @All')['state'], 'recognized_all')
        repeated = [{'A': '1', 'S': '0', 'E': '4'}] * 2
        self.assertEqual(core.stored_mentions(meta(repeated), '@All')['state'], 'text_or_offset_mismatch')
        self.assertEqual(core.stored_mentions('{"MENTION":"broken"}', '@All')['state'], 'unrecognized')

    def test_scoped_records_include_stored_mention_evidence(self):
        self.add('mention', self.start, text='@All notice')
        metadata = json.dumps({'MENTION': json.dumps({'MENTIONEES': [{'A': '1', 'S': '0', 'E': '4'}]})})
        self.db.execute('UPDATE _message SET _contentMetadata=? WHERE _id=?', (metadata, 'mention'))
        result = core.read_scoped(self.db, self.args, {})
        self.assertEqual(result['messages'][0]['mentions']['state'], 'recognized_all')

    def test_keyset_pages_cover_equal_timestamps_without_duplicates_or_foreign_rows(self):
        for n in range(1007):
            self.add(f'{n:05}', self.start + n // 4)
        self.add('foreign', self.start, chat='c2')
        args = {**self.args, 'messageLimit': 173}
        found = []
        while True:
            result = core.read_scoped(self.db, args, {})
            found += [m['sourceMessageId'] for m in result['messages']]
            self.assertEqual(result['pagination']['hasMore'], result['scope']['truncated'])
            cursor = result['pagination']['nextCursor']
            if cursor is None:
                break
            args = {**args, 'cursor': cursor}
        self.assertEqual(len(found), 1007)
        self.assertEqual(len(set(found)), 1007)
        self.assertEqual(set(found), {f'{n:05}' for n in range(1007)})

    def test_cursor_is_scope_bound_and_invalid_inputs_fail_before_database_read(self):
        self.add('a', self.start)
        self.add('b', self.start + 1)
        cursor = core.read_scoped(self.db, {**self.args, 'messageLimit': 1}, {})['pagination']['nextCursor']
        for changed in [{'chatName': 'Other Synthetic Group'}, {'query': 'x'}, {'dateFrom': '2026-09-06'}]:
            with self.assertRaises(core.ReaderError) as error:
                core.read_scoped(None, {**self.args, 'cursor': cursor, **changed}, {})
            self.assertEqual(error.exception.code, 'CURSOR_SCOPE_MISMATCH')
        for changed in [{'cursor': 'bad!'}, {'mediaMode': 'all'}, {'mediaSourceRefs': []},
                        {'mediaMode': 'preview', 'mediaSourceRefs': ['../secret']}]:
            with self.assertRaises(core.ReaderError):
                core.read_scoped(None, {**self.args, **changed}, {})

    def test_cursor_preserves_integer_id_order_and_detects_replaced_chat_identity(self):
        self.db.execute('DROP TABLE _message')
        self.db.execute('CREATE TABLE _message(_id INTEGER, _from TEXT, _createdTime INTEGER, _text TEXT, '
                        '_contentType INTEGER, _contentMetadata BLOB, _contentInfo BLOB, _relatedMessageId TEXT, '
                        '_type INTEGER, _status INTEGER, _rev INTEGER, _chatId TEXT)')
        for mid in [1, 2, 10, 11]:
            self.add(mid, self.start)
        args = {**self.args, 'messageLimit': 2}
        first = core.read_scoped(self.db, args, {})
        self.assertEqual([m['sourceMessageId'] for m in first['messages']], ['10', '11'])
        second = core.read_scoped(self.db, {**args, 'cursor': first['pagination']['nextCursor']}, {})
        self.assertEqual([m['sourceMessageId'] for m in second['messages']], ['1', '2'])
        self.db.execute('UPDATE _groupChat SET _chatMid=? WHERE _chatName=?', ('replaced', self.args['chatName']))
        with self.assertRaises(core.ReaderError) as error:
            core.read_scoped(self.db, {**args, 'cursor': first['pagination']['nextCursor']}, {})
        self.assertEqual(error.exception.code, 'CURSOR_SCOPE_MISMATCH')

    def test_metadata_default_never_calls_media_resolver_and_selected_preview_is_lazy(self):
        self.add('a', self.start, kind=1)
        self.add('b', self.start + 1, kind=1)
        calls = []
        def resolver(kind, meta, info, ref, chat):
            calls.append(ref)
            return {'state': 'decoded', 'preview': {'mimeType': 'image/png', 'data': 'AAAA'}}
        metadata = core.read_scoped(self.db, self.args, {}, resolver)
        self.assertEqual(calls, [])
        wanted = metadata['messages'][0]['sourceRef']
        result = core.read_scoped(self.db, {**self.args, 'mediaMode': 'preview', 'mediaSourceRefs': [wanted]}, {}, resolver)
        self.assertEqual(calls, [wanted])
        self.assertIn('preview', result['messages'][0]['media'])
        self.assertNotIn('preview', result['messages'][1]['media'])
        self.assertEqual(result['mediaSelection']['notReturnedSourceRefs'], [])

    def test_preview_budget_preserves_text_and_stops_further_media_work(self):
        for n in range(4):
            self.add(str(n), self.start + n, kind=1)
        calls = []
        def resolver(*args):
            calls.append(1)
            return {'state': 'decoded', 'preview': {'mimeType': 'image/png', 'data': 'A' * 80}}
        result = core.read_scoped(self.db, {**self.args, 'mediaMode': 'preview'}, {}, resolver, preview_budget_bytes=100)
        self.assertEqual(result['count'], 4)
        self.assertLess(len(calls), 4)
        self.assertEqual(sum(len(m['media'].get('preview', {}).get('data', '')) for m in result['messages']), 80)
        self.assertTrue(all(m['text'] == 'same\nsecond line 😀' for m in result['messages']))

    def test_uncached_media_work_has_an_item_bound_even_without_preview_bytes(self):
        for n in range(25):
            self.add(str(n), self.start + n, kind=1)
        calls = []
        def resolver(*args):
            calls.append(1)
            return {'state': 'not_cached'}
        result = core.read_scoped(self.db, {**self.args, 'mediaMode': 'preview'}, {}, resolver)
        self.assertEqual(result['count'], 25)
        self.assertEqual(len(calls), 20)
        self.assertEqual(sum(m['media'].get('previewOmittedReason') == 'media_item_limit' for m in result['messages']), 5)

    def test_response_budget_pages_preserve_every_full_message(self):
        for n in range(9):
            self.add(str(n), self.start + n, text='😀' * 100)
        args = dict(self.args)
        found = []
        while True:
            result = core.read_scoped(self.db, args, {}, message_budget_bytes=2400)
            found += [m['sourceMessageId'] for m in result['messages']]
            self.assertTrue(all(m['text'] == '😀' * 100 for m in result['messages']))
            cursor = result['pagination']['nextCursor']
            if cursor is None:
                break
            self.assertEqual(result['pagination']['limitedBy'], 'response_bytes')
            args['cursor'] = cursor
        self.assertEqual(len(found), 9)
        self.assertEqual(len(set(found)), 9)
        with self.assertRaises(core.ReaderError) as error:
            core.read_scoped(self.db, self.args, {}, message_budget_bytes=10)
        self.assertEqual(error.exception.code, 'RESULT_TOO_LARGE')

    def test_cipher_row_budget_reduces_page_before_serialization_without_losing_messages(self):
        for n in range(5):
            self.add(str(n), self.start + n)
        actual = self.db
        class BudgetedConnection:
            def execute(self, sql, params=()):
                if '_contentMetadata' in sql and params[-1] > 1:
                    raise core.ReaderError('RESULT_TOO_LARGE')
                return actual.execute(sql, params)
        args, found = dict(self.args), []
        while True:
            result = core.read_scoped(BudgetedConnection(), args, {})
            found += [m['sourceMessageId'] for m in result['messages']]
            cursor = result['pagination']['nextCursor']
            if cursor is None:
                break
            self.assertEqual(result['pagination']['limitedBy'], 'response_bytes')
            args['cursor'] = cursor
        self.assertEqual(found, ['4', '3', '2', '1', '0'])


if __name__ == '__main__':
    unittest.main()
