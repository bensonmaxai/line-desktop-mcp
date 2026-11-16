import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'extensions' / 'python'))
import line_scoped_core as core


class KeepOpenIdentityTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE _profile (_mid TEXT);
            CREATE TABLE _chat (_id TEXT, _midType INTEGER);
            CREATE TABLE _groupChat (_chatMid TEXT, _chatName TEXT);
            CREATE TABLE _contact (_mid TEXT, _displayName TEXT, _displayNameOverridden TEXT);
            INSERT INTO _profile VALUES ('self');
            INSERT INTO _chat VALUES ('self', 0);
        ''')

    def read(self):
        return core.read_scoped(self.db, {'mode': 'keepOpenIdentity'}, {})

    def test_existing_self_chat(self):
        self.assertEqual(self.read(), {'ok': True, 'mode': 'keepOpenIdentity'})

    def test_missing_or_duplicate_profile_and_wrong_chat_type_refuse(self):
        for sql in ("DELETE FROM _profile", "INSERT INTO _profile VALUES ('other')",
                    "UPDATE _chat SET _midType = 2", "DELETE FROM _chat"):
            with self.subTest(sql=sql), self.db:
                self.db.execute('SAVEPOINT test_case')
                self.db.execute(sql)
                with self.assertRaises(core.ReaderError) as caught:
                    self.read()
                self.assertEqual(caught.exception.code, 'CHAT_NOT_FOUND')
                self.db.execute('ROLLBACK TO test_case')
                self.db.execute('RELEASE test_case')

    def test_equivalent_contact_and_group_collisions_refuse(self):
        for sql in ("INSERT INTO _contact VALUES ('other', 'Keep 筆記 (2)', NULL)",
                    "INSERT INTO _groupChat VALUES ('other', 'Keep筆記')"):
            with self.subTest(sql=sql), self.db:
                self.db.execute('SAVEPOINT test_case')
                self.db.execute(sql)
                with self.assertRaises(core.ReaderError) as caught:
                    self.read()
                self.assertEqual(caught.exception.code, 'CHAT_AMBIGUOUS')
                self.db.execute('ROLLBACK TO test_case')
                self.db.execute('RELEASE test_case')

    def test_private_mode_rejects_extra_arguments(self):
        with self.assertRaises(core.ReaderError):
            core.read_scoped(self.db, {'mode': 'keepOpenIdentity', 'chatName': 'Keep筆記'}, {})
