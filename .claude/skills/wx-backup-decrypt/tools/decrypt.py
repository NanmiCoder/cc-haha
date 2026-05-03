#!/usr/bin/env python3
"""
WeChat Backup Database Decryptor
Decrypts .xb SQLite databases from NAS/Android WeChat backups.

Usage:
    python decrypt.py --db PATH [--wxid WXID] [--imei IMEI] [--output DIR] [--exclude-keywords KEYWORDS]

Key discovery method:
    1. Try known-plaintext attack (using wx_backup_history.display as plaintext)
    2. If IMEI provided, try MD5(IMEI+UIN)[:7] as key
    3. Fallback: brute-force single-byte XOR (256 possibilities)
"""

import sqlite3
import hashlib
import json
import os
import argparse
from collections import Counter
from datetime import datetime


def _is_likely_hex(s):
    """Check if a string looks like hex-encoded ciphertext."""
    if not s or len(s) < 4 or len(s) % 2 != 0:
        return False
    return all(c in '0123456789abcdefABCDEF' for c in s)


def decrypt_xor(content_hex, key_bytes):
    """Decrypt hex-encoded content using XOR with key bytes."""
    if not content_hex or len(content_hex) % 2 != 0:
        return None
    try:
        cipher = bytes.fromhex(content_hex)
        if len(key_bytes) == 1:
            plain = bytes(b ^ key_bytes[0] for b in cipher)
        else:
            plain = bytes(b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(cipher))
        return plain.decode('utf-8', errors='replace')
    except Exception:
        return None


def _try_decrypt_field(value, key_bytes):
    """Try decrypting a field value. Returns original if likely plaintext."""
    if not value:
        return value
    if _is_likely_hex(value):
        dec = decrypt_xor(value, key_bytes)
        if dec and '\ufffd' not in dec:
            return dec
    return value


def known_plaintext_attack(db_path):
    """Discover encryption key by matching plaintext from wx_backup_history."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        SELECT display, talkerId, endTime
        FROM wx_backup_history
        WHERE display IS NOT NULL AND display != ''
        AND length(display) > 2 AND length(display) < 50
    """)

    pairs = []
    for display, talker, endtime in cursor.fetchall():
        cursor.execute("""
            SELECT content FROM wx_chat
            WHERE session=? AND create_time=? AND msg_type=1
        """, (talker, endtime))
        result = cursor.fetchone()
        if result and result[0]:
            plain_bytes = display.encode('utf-8')
            hex_content = result[0]
            if _is_likely_hex(hex_content):
                try:
                    cipher_bytes = bytes.fromhex(hex_content)
                    if len(plain_bytes) == len(cipher_bytes):
                        pairs.append((plain_bytes, cipher_bytes))
                except ValueError:
                    continue

    conn.close()

    if not pairs:
        return None

    # Extract XOR key bytes from all pairs
    key_bytes_list = []
    for plain, cipher in pairs:
        keys = [p ^ c for p, c in zip(plain, cipher)]
        key_bytes_list.append(keys)

    # Check if all pairs yield the same constant key (single-byte XOR)
    first_key = key_bytes_list[0][0] if key_bytes_list else None
    is_constant = all(
        k == first_key
        for keys in key_bytes_list
        for k in keys
    )

    if is_constant and first_key is not None:
        return bytes([first_key]), 'constant_xor'

    # Check for repeating key
    if key_bytes_list:
        max_len = max(len(k) for k in key_bytes_list)
        for period in range(1, max_len + 1):
            is_repeating = True
            for keys in key_bytes_list:
                if len(keys) < period:
                    continue
                for i in range(period, len(keys)):
                    if keys[i] != keys[i % period]:
                        is_repeating = False
                        break
                if not is_repeating:
                    break
            if is_repeating:
                key = bytes(key_bytes_list[0][:period])
                return key, 'repeating_xor'

    return None


def imei_key_derivation(imei, uin=None):
    """Try IMEI-based key derivation (traditional WeChat method)."""
    key_str = imei + str(uin) if uin else imei
    md5_hash = hashlib.md5(key_str.encode()).hexdigest()
    return bytes.fromhex(md5_hash[:7])


def validate_key(db_path, key_bytes):
    """Validate a key by checking decryption quality on a sample."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        SELECT content FROM wx_chat
        WHERE msg_type=1 AND content IS NOT NULL AND content != ''
        ORDER BY RANDOM() LIMIT 1000
    """)

    valid = 0
    total = 0
    replacement = 0

    for row in cursor.fetchall():
        text = decrypt_xor(row[0], key_bytes)
        if text is not None:
            total += 1
            valid += 1
            if '\ufffd' in text:
                replacement += 1

    conn.close()

    if total == 0:
        return 0.0, 0

    return valid / total, replacement


def brute_force_key(db_path):
    """Brute-force single-byte XOR key by maximizing validation rate."""
    best_key = bytes([0])
    best_rate = 0.0
    for b in range(256):
        k = bytes([b])
        r, _ = validate_key(db_path, k)
        if r > best_rate:
            best_rate = r
            best_key = k
    return best_key, best_rate


def decrypt_all(db_path, key_bytes, output_dir, user_wxid=None, exclude_keywords=None):
    """Decrypt entire database and export to JSON files."""
    if exclude_keywords is None:
        exclude_keywords = []

    os.makedirs(output_dir, exist_ok=True)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Discover user wxid if not provided
    if not user_wxid:
        cursor.execute("""
            SELECT speak, COUNT(*) as cnt
            FROM wx_chat
            WHERE msg_type=1
            GROUP BY speak
            ORDER BY cnt DESC
            LIMIT 1
        """)
        result = cursor.fetchone()
        user_wxid = result[0] if result else None

    print(f"User wxid: {user_wxid}")

    # Decrypt friends
    cursor.execute("SELECT friend_id, nickname, remark, sex FROM wx_friend")
    friends = {}
    for f in cursor.fetchall():
        fid, nick, remark, sex = f
        friends[fid] = {
            'nick': _try_decrypt_field(nick, key_bytes) or '',
            'remark': _try_decrypt_field(remark, key_bytes) or '',
            'sex': sex,
        }

    # Decrypt groups
    cursor.execute("SELECT groupid, nickName, remark, memberCount FROM wx_group")
    groups = {}
    for g in cursor.fetchall():
        gid, name, remark, mc = g
        groups[gid] = {
            'name': _try_decrypt_field(name, key_bytes) or '',
            'remark': remark or '',
            'members': mc,
        }

    # Identify exclude sessions based on keywords
    exclude_sessions = set()
    for gid, info in groups.items():
        name = info.get('name', '')
        if any(k in name for k in exclude_keywords):
            exclude_sessions.add(gid)

    # Decrypt user messages
    cursor.execute("""
        SELECT id, session, speak, content, create_time, msg_type
        FROM wx_chat WHERE speak=?
    """, (user_wxid,))
    user_msgs = []
    for r in cursor.fetchall():
        text = decrypt_xor(r[3], key_bytes) if r[3] else None
        ts = datetime.fromtimestamp(r[4] / 1000) if r[4] else None
        if r[1] not in exclude_sessions:
            user_msgs.append({
                'id': r[0], 'session': r[1], 'speak': r[2],
                'text': text, 'time': r[4],
                'time_str': ts.strftime('%Y-%m-%d %H:%M:%S') if ts else None,
                'msg_type': r[5],
            })

    # Decrypt all text messages
    cursor.execute("""
        SELECT id, session, speak, content, create_time
        FROM wx_chat WHERE msg_type=1
    """)
    all_msgs = []
    for r in cursor.fetchall():
        text = decrypt_xor(r[3], key_bytes) if r[3] else None
        ts = datetime.fromtimestamp(r[4] / 1000) if r[4] else None
        if r[1] not in exclude_sessions:
            all_msgs.append({
                'id': r[0], 'session': r[1], 'speak': r[2],
                'text': text, 'time': r[4],
                'time_str': ts.strftime('%Y-%m-%d %H:%M:%S') if ts else None,
            })

    conn.close()

    # Save exports
    with open(os.path.join(output_dir, 'friends.json'), 'w', encoding='utf-8') as f:
        json.dump(friends, f, ensure_ascii=False, indent=2)

    with open(os.path.join(output_dir, 'groups.json'), 'w', encoding='utf-8') as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)

    user_text = [m for m in user_msgs if m['msg_type'] == 1]
    with open(os.path.join(output_dir, 'user_messages.json'), 'w', encoding='utf-8') as f:
        json.dump(user_text, f, ensure_ascii=False, indent=2)

    with open(os.path.join(output_dir, 'all_user_messages.json'), 'w', encoding='utf-8') as f:
        json.dump(user_msgs, f, ensure_ascii=False, indent=2)

    with open(os.path.join(output_dir, 'all_text_messages.json'), 'w', encoding='utf-8') as f:
        json.dump(all_msgs, f, ensure_ascii=False, indent=2)

    with open(os.path.join(output_dir, 'user_messages.txt'), 'w', encoding='utf-8') as f:
        for m in user_text:
            f.write(f"[{m['time_str']}] {m['text']}\n")

    # Stats
    stats = {
        'user_wxid': user_wxid,
        'key_method': 'XOR 0x{:02x}'.format(key_bytes[0]) if len(key_bytes) == 1 else key_bytes.hex(),
        'total_user_messages': len(user_msgs),
        'user_text_messages': len(user_text),
        'total_text_messages': len(all_msgs),
        'friends_count': len(friends),
        'groups_count': len(groups),
        'excluded_sessions': list(exclude_sessions),
        'export_files': [
            'friends.json', 'groups.json', 'user_messages.json',
            'all_user_messages.json', 'all_text_messages.json', 'user_messages.txt',
        ],
    }

    with open(os.path.join(output_dir, 'decrypt_stats.json'), 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    return stats


def main():
    parser = argparse.ArgumentParser(description='Decrypt WeChat backup database')
    parser.add_argument('--db', required=True, help='Path to .xb database file')
    parser.add_argument('--wxid', default=None, help='User WeChat ID (auto-detected if omitted)')
    parser.add_argument('--imei', default=None, help='Phone IMEI number')
    parser.add_argument('--uin', default=None, help='WeChat UIN')
    parser.add_argument('--output', default='./wx_decrypted', help='Output directory')
    parser.add_argument('--exclude-keywords', nargs='+', default=[],
                        help='Keywords for group names to exclude')
    args = parser.parse_args()

    print(f"Analyzing database: {args.db}")

    # Step 1: Known-plaintext attack
    print("\n[1] Trying known-plaintext attack...")
    result = known_plaintext_attack(args.db)

    key_bytes = None
    if result:
        key_bytes, method = result
        print(f"  Found key via {method}: {key_bytes.hex()}")
        rate, replacements = validate_key(args.db, key_bytes)
        print(f"  Validation: {rate*100:.1f}% valid, {replacements} replacement chars")
    else:
        print("  Known-plaintext attack failed.")

        # Step 2: IMEI-based key
        if args.imei:
            print("\n[2] Trying IMEI-based key derivation...")
            key_bytes = imei_key_derivation(args.imei, args.uin)
            print(f"  Derived key: {key_bytes.hex()}")
            rate, replacements = validate_key(args.db, key_bytes)
            print(f"  Validation: {rate*100:.1f}% valid, {replacements} replacement chars")

            if rate < 0.9:
                print("\n[3] Brute-forcing single-byte XOR...")
                key_bytes, best_rate = brute_force_key(args.db)
                print(f"  Best key: 0x{key_bytes[0]:02x} (rate: {best_rate*100:.1f}%)")
        else:
            # Brute-force
            print("\n[2] Brute-forcing single-byte XOR...")
            key_bytes, best_rate = brute_force_key(args.db)
            print(f"  Best key: 0x{key_bytes[0]:02x} (rate: {best_rate*100:.1f}%)")

    # Decrypt all
    print(f"\nDecrypting database with key {key_bytes.hex()}...")
    stats = decrypt_all(
        args.db, key_bytes, args.output,
        user_wxid=args.wxid,
        exclude_keywords=args.exclude_keywords,
    )

    print(f"\n=== Decryption Complete ===")
    for k, v in stats.items():
        if k != 'excluded_sessions':
            print(f"  {k}: {v}")

    print(f"\nFiles saved to: {args.output}")


if __name__ == '__main__':
    main()
