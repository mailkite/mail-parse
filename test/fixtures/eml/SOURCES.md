# Sample email fixtures — sources & license

These `.eml` files are a curated subset of the test corpus from the **`mikel/mail`** Ruby gem
(<https://github.com/mikel/mail>), `spec/fixtures/emails/`. That corpus is the long-standing
gold-standard set for exercising MIME parsers and MTAs.

- **Upstream:** https://github.com/mikel/mail/tree/master/spec/fixtures/emails
- **License:** MIT — Copyright (c) Mikel Lindsaar. See the upstream `MIT-LICENSE`.
- **Why these:** a small set spanning the dimensions our inbound path must survive (parse → store →
  route → webhook), not the whole tree.

| Local file | Upstream | Dimension exercised |
|---|---|---|
| `plain_basic.eml` | plain_emails/basic_email.eml | Plain text, full real-world header set |
| `plain_simple.eml` | plain_emails/raw_email_simple.eml | Minimal plain message |
| `plain_reply_threaded.eml` | plain_emails/raw_email_reply.eml | Reply — In-Reply-To / References (threadId) |
| `mime_multipart.eml` | mime_emails/raw_email2.eml | multipart with several parts |
| `mime_multipart_alt.eml` | mime_emails/raw_email7.eml | multipart/alternative (text + html) |
| `mime_nested_attachment.eml` | mime_emails/raw_email_with_nested_attachment.eml | Nested multipart + attachment |
| `attach_pdf_base64.eml` | attachment_emails/attachment_pdf.eml | base64 PDF attachment |
| `attach_nonascii_filename.eml` | attachment_emails/attachment_nonascii_filename.eml | RFC2231 non-ASCII filename |
| `attach_message_rfc822.eml` | attachment_emails/attachment_message_rfc822.eml | message/rfc822 attachment |
| `charset_japanese_utf8.eml` | multi_charset/japanese.eml | UTF-8 base64 body + encoded-word headers |
| `charset_japanese_shiftjis.eml` | multi_charset/japanese_shift_jis.eml | Shift-JIS charset |
| `edge_missing_body.eml` | error_emails/missing_body.eml | Headers, no body (store-don't-crash) |
| `edge_bad_encoded_subject.eml` | error_emails/bad_encoded_subject.eml | Malformed encoded-word subject |
| `edge_multiple_content_types.eml` | error_emails/multiple_content_types.eml | Duplicate Content-Type headers |
| `eai_utf8_headers.eml` | rfc6532/utf8_headers.eml | RFC 6532 raw UTF-8 in headers (EAI) |

To refresh or extend, see `api/test/fixtures/eml/` download step in the MTA E2E test plan
(`docs/architecture/mta-e2e-test-plan.md`).
