---
name: wx-backup-decrypt
description: "Decrypt and extract WeChat backup database (.xb files) from NAS/Android backups. Handles XOR-encrypted content fields, friend/group metadata, and exports all messages. | 解密和提取微信备份数据库（.xb文件），处理加密内容字段，导出全部消息。"
argument-hint: "[database-path] [--imei IMEI] [--output OUTPUT_DIR] [--exclude-keywords KW1 KW2]"
version: "1.1.0"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash
---

> **Language / 语言**: Detect user's language from first message, respond in same language throughout.

# WeChat Backup Database Decryptor

## Trigger

Activate when user:
- Runs `/wx-backup-decrypt`
- Mentions: 解密微信备份数据, decrypt wechat backup, 微信聊天记录解密
- Points to a `.xb` file or WeChat backup directory

## Flow

### 1. Locate database

```bash
find {path} -name "*.xb" -type f 2>/dev/null
```

If directory provided, also check for `.xb` files directly inside it.

### 2. Decrypt using the tool

Run the bundled Python script:

```bash
python3 .claude/skills/wx-backup-decrypt/tools/decrypt.py \
  --db {db_path} \
  --output {output_dir} \
  [--wxid {wxid}] \
  [--imei {imei}] [--uin {uin}] \
  [--exclude-keywords {kw1} {kw2}]
```

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `--db` | Yes | Path to .xb database |
| `--output` | No | Output directory (default: `./wx_decrypted`) |
| `--wxid` | No | User's WeChat ID (auto-detected if omitted) |
| `--imei` | No | Phone IMEI (fallback key derivation) |
| `--uin` | No | WeChat UIN (paired with IMEI) |
| `--exclude-keywords` | No | Group name keywords to exclude |

### 3. Validate results

After decryption, check `decrypt_stats.json` for:
- Valid decryption rate (should be near 100%)
- Message counts
- Excluded sessions

If rate < 90%, suggest user provide IMEI/UIN for alternative key derivation.

### 4. Present findings

Show user:
- Total messages decrypted
- Friend/group counts
- Output file list
- Any warnings (low validation rate, excluded groups)

## Key Technical Notes

### Encryption in NAS WeChat backups

- `wx_chat.content`: **XOR-encrypted** (hex-encoded ciphertext)
- `wx_friend.nickname`, `wx_group.nickName`: **May be plaintext** — script auto-detects
- `wx_backup_history.display`: **Usually plaintext** — used for known-plaintext attack

### Key discovery (handled automatically by decrypt.py)

1. **Known-plaintext attack** (primary): Match `wx_backup_history.display` (plaintext) to `wx_chat.content` (ciphertext) at same timestamp/session → derive XOR key
2. **IMEI derivation** (fallback): `MD5(IMEI + UIN)[:7]`
3. **Brute-force** (last resort): Try all 256 single-byte XOR keys

### Field encryption auto-detection

The script detects if a field is encrypted by checking: hex-only characters + even length + length ≥ 4. If all conditions met, attempts decryption; otherwise treats as plaintext.

## Output Files

| File | Content |
|------|---------|
| `user_messages.json` | User's text messages (filtered) |
| `user_messages.txt` | Plain text: `[timestamp] message` |
| `all_user_messages.json` | User's all-type messages (filtered) |
| `all_text_messages.json` | Everyone's text messages (filtered) |
| `friends.json` | Friend list |
| `groups.json` | Group list |
| `decrypt_stats.json` | Statistics & metadata |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Garbled output | Field may be plaintext, not encrypted. Script auto-detects. |
| No plaintext-ciphertext pairs | `backup_history.display` may be empty. Provide `--imei` + `--uin`. |
| Low validation rate | Wrong key. Try different IMEI/UIN combinations. |
| pywxdump won't install | Linux doesn't support pywxdump (requires pywin32). Use this tool instead. |

## Persona Building

Exported data feeds directly into `create-yourself` skill:
- Message patterns → speech style, catchphrases, emoji usage
- Timestamps → active hours, daily rhythms
- Session analysis → relationship mapping, communication style per group
- Content themes → values, interests, life events
